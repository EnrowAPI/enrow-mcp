import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const BASE_URL = 'https://api.enrow.io';

/**
 * Build an Enrow MCP server instance. The Enrow API key is resolved lazily
 * per request via `getApiKey`, so the same tool definitions work for both the
 * local stdio transport (key from the ENROW_API_KEY env var) and the remote
 * HTTP transport (key from a per-request header — multi-tenant hosting).
 */
export function createEnrowServer(getApiKey: () => string): McpServer {
  async function request(method: string, path: string, body?: unknown) {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          'x-api-key': getApiKey(),
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: 'text' as const, text: `Network error calling Enrow API: ${msg}` }], isError: true };
    }

    // Read the body as text first — an empty or non-JSON body (proxy error page,
    // 204, gateway timeout) would otherwise make res.json() throw and crash the tool.
    const raw = await res.text();
    let data: any;
    try {
      data = raw ? JSON.parse(raw) : undefined;
    } catch {
      data = undefined;
    }

    if (!res.ok) {
      const detail =
        (data && typeof data === 'object' && (data.message ?? data.reason)) ||
        raw ||
        res.statusText;
      return { content: [{ type: 'text' as const, text: `Error ${res.status}: ${detail}` }], isError: true };
    }

    // 202 = the async job is still running. The caller must poll the matching
    // get_* tool again with the same id, so surface that explicitly.
    if (res.status === 202) {
      const text = data !== undefined ? JSON.stringify(data, null, 2) : raw;
      return { content: [{ type: 'text' as const, text: `Still processing (202) — call the matching get_* tool again with the same id in a few seconds.\n${text}` }] };
    }

    const text = data !== undefined ? JSON.stringify(data, null, 2) : raw || '(empty response)';
    return { content: [{ type: 'text' as const, text }] };
  }

  const server = new McpServer({
    name: 'enrow',
    version: '1.2.0',
  });

  // Annotation presets. `find_*`/`verify_*` create an async job and spend
  // credits, so they are not read-only; `get_*` retrievals are read-only.
  // All three hints are explicit on every tool: the OpenAI submission portal
  // rejects tools with a missing destructiveHint. `get_*` only read results
  // stored in the caller's own Enrow account, hence closed-world.
  const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
  const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

  // ── Email Finder ──

  server.tool(
    'find_email',
    'Find the work email address of one specific, named person at a specific company. Use only when the user explicitly asks for the work email of a named person and gives the company domain or name. Asynchronous: returns a search id, then call get_email_result with it.',
    {
      fullname: z.string().min(1).describe('Full name of the person to look up (e.g. "Tim Cook")'),
      company_domain: z.string().optional().describe('Website domain of the company the person works at (e.g. "apple.com"). Preferred over company_name.'),
      company_name: z.string().optional().describe('Name of the company the person works at (e.g. "Apple Inc."). Used only when company_domain is not given.'),
      company_country: z.string().length(2).optional().describe('Two-letter ISO 3166-1 country code of the company (e.g. "FR"), only to disambiguate company_name when company_domain is not given. Not the location of the user.'),
    },
    { title: 'Find email', ...WRITE },
    async (params) => {
      if (!params.company_domain && !params.company_name) {
        return { content: [{ type: 'text' as const, text: 'Error: provide at least one of company_domain or company_name.' }], isError: true };
      }
      const body: Record<string, unknown> = { fullname: params.fullname };
      if (params.company_domain) body.company_domain = params.company_domain;
      if (params.company_name) body.company_name = params.company_name;
      if (params.company_country) body.settings = { country_code: params.company_country };
      return request('POST', '/email/find/single', body);
    }
  );

  server.tool(
    'get_email_result',
    'Retrieve the status and result of an email search started with find_email, by its search id.',
    {
      id: z.string().describe('Search ID returned from find_email'),
    },
    { title: 'Get email result', ...READ },
    async (params) => request('GET', `/email/find/single?id=${encodeURIComponent(params.id)}`)
  );

  server.tool(
    'find_emails_bulk',
    'Find the work email addresses of a list of specific, named people (up to 5,000) in one batch. Use only when the user explicitly provides such a list with a company for each person. Asynchronous: returns a batch id, then call get_emails_bulk_result with it.',
    {
      searches: z.array(z.object({
        fullname: z.string().min(1).describe('Full name of the person'),
        company_domain: z.string().optional().describe('Website domain of the company of the person (preferred)'),
        company_name: z.string().optional().describe('Name of the company of the person, when the domain is unknown'),
      })).min(1).max(5000).describe('One entry per person to look up; each needs company_domain or company_name'),
      company_country: z.string().length(2).optional().describe('Two-letter ISO 3166-1 country code applied to entries that only have company_name. Not the location of the user.'),
    },
    { title: 'Find emails (bulk)', ...WRITE },
    async (params) => {
      const bad = params.searches.findIndex((s) => !s.company_domain && !s.company_name);
      if (bad !== -1) {
        return { content: [{ type: 'text' as const, text: `Error: searches[${bad}] needs company_domain or company_name.` }], isError: true };
      }
      const body: Record<string, unknown> = { searches: params.searches };
      if (params.company_country) body.settings = { country_code: params.company_country };
      return request('POST', '/email/find/bulk', body);
    }
  );

  server.tool(
    'get_emails_bulk_result',
    'Retrieve the status and results of a bulk email search started with find_emails_bulk, by its batch id.',
    {
      id: z.string().describe('Batch ID returned from find_emails_bulk'),
    },
    { title: 'Get bulk email results', ...READ },
    async (params) => request('GET', `/email/find/bulk?id=${encodeURIComponent(params.id)}`)
  );

  // ── Email Verifier ──

  server.tool(
    'verify_email',
    'Check whether one specific email address is deliverable (exists and accepts mail), including on catch-all domains. Use only when the user explicitly asks to verify or validate a given address; not for questions about the mailbox or email setup of the user. Asynchronous: returns a verification id, then call get_verification_result with it.',
    {
      email: z.string().email().describe('The email address to verify'),
    },
    { title: 'Verify email', ...WRITE },
    async (params) => request('POST', '/email/verify/single', { email: params.email })
  );

  server.tool(
    'get_verification_result',
    'Retrieve the status and result of an email verification started with verify_email, by its verification id.',
    {
      id: z.string().describe('Verification ID returned from verify_email'),
    },
    { title: 'Get verification result', ...READ },
    async (params) => request('GET', `/email/verify/single?id=${encodeURIComponent(params.id)}`)
  );

  server.tool(
    'verify_emails_bulk',
    'Check the deliverability of a list of email addresses (up to 5,000) in one batch. Use only when the user explicitly provides a list of addresses to verify. Asynchronous: returns a batch id, then call get_verifications_bulk_result with it.',
    {
      emails: z.array(z.string().email()).min(1).max(5000).describe('The email addresses to verify'),
    },
    { title: 'Verify emails (bulk)', ...WRITE },
    // The API reads the array under the `verifications` key (not `emails`).
    async (params) => request('POST', '/email/verify/bulk', { verifications: params.emails })
  );

  server.tool(
    'get_verifications_bulk_result',
    'Retrieve the status and results of a bulk email verification started with verify_emails_bulk, by its batch id.',
    {
      id: z.string().describe('Batch ID returned from verify_emails_bulk'),
    },
    { title: 'Get bulk verification results', ...READ },
    async (params) => request('GET', `/email/verify/bulk?id=${encodeURIComponent(params.id)}`)
  );

  // ── Phone Finder ──

  server.tool(
    'find_phone',
    'Find the professional mobile phone number of one specific, named person. Use only when the user explicitly asks for the phone number of a named person and identifies them by a LinkedIn profile URL, or by first name + last name + company. Not for general or customer-service numbers. Asynchronous: returns a search id, then call get_phone_result with it.',
    {
      linkedin_url: z.string().optional().describe('LinkedIn profile URL of the person (preferred; when given, the other fields are not needed)'),
      first_name: z.string().optional().describe('First name of the person (with last_name and a company, when there is no LinkedIn URL)'),
      last_name: z.string().optional().describe('Last name of the person'),
      company_domain: z.string().optional().describe('Website domain of the company of the person (preferred over company_name)'),
      company_name: z.string().optional().describe('Name of the company of the person, when the domain is unknown'),
    },
    { title: 'Find phone', ...WRITE },
    async (params) => {
      if (!params.linkedin_url && !(params.first_name && params.last_name && (params.company_domain || params.company_name))) {
        return { content: [{ type: 'text' as const, text: 'Error: provide linkedin_url, or first_name + last_name + (company_domain or company_name).' }], isError: true };
      }
      const body: Record<string, unknown> = {};
      if (params.linkedin_url) body.linkedin_url = params.linkedin_url;
      // API expects firstname/lastname (no underscore).
      if (params.first_name) body.firstname = params.first_name;
      if (params.last_name) body.lastname = params.last_name;
      if (params.company_domain) body.company_domain = params.company_domain;
      if (params.company_name) body.company_name = params.company_name;
      return request('POST', '/phone/single', body);
    }
  );

  server.tool(
    'get_phone_result',
    'Retrieve the status and result of a phone search started with find_phone, by its search id.',
    {
      id: z.string().describe('Search ID returned from find_phone'),
    },
    { title: 'Get phone result', ...READ },
    async (params) => request('GET', `/phone/single?id=${encodeURIComponent(params.id)}`)
  );

  server.tool(
    'find_phones_bulk',
    'Find the professional mobile phone numbers of a list of specific, named people (up to 3,000) in one batch. Use only when the user explicitly provides such a list, each person identified by a LinkedIn URL or by first name + last name + company. Asynchronous: returns a batch id, then call get_phones_bulk_result with it.',
    {
      searches: z.array(z.object({
        linkedin_url: z.string().optional().describe('LinkedIn profile URL of the person (preferred)'),
        first_name: z.string().optional().describe('First name (with last_name and a company, when there is no LinkedIn URL)'),
        last_name: z.string().optional().describe('Last name'),
        company_domain: z.string().optional().describe('Website domain of the company of the person'),
        company_name: z.string().optional().describe('Name of the company of the person, when the domain is unknown'),
      })).min(1).max(3000).describe('One entry per person to look up'),
    },
    { title: 'Find phones (bulk)', ...WRITE },
    async (params) => {
      const bad = params.searches.findIndex((s) => !s.linkedin_url && !(s.first_name && s.last_name && (s.company_domain || s.company_name)));
      if (bad !== -1) {
        return { content: [{ type: 'text' as const, text: `Error: searches[${bad}] needs linkedin_url, or first_name + last_name + (company_domain or company_name).` }], isError: true };
      }
      // Map the ergonomic first_name/last_name to the API's firstname/lastname.
      const searches = params.searches.map((s) => {
        const out: Record<string, unknown> = {};
        if (s.linkedin_url) out.linkedin_url = s.linkedin_url;
        if (s.first_name) out.firstname = s.first_name;
        if (s.last_name) out.lastname = s.last_name;
        if (s.company_domain) out.company_domain = s.company_domain;
        if (s.company_name) out.company_name = s.company_name;
        return out;
      });
      return request('POST', '/phone/bulk', { searches });
    }
  );

  server.tool(
    'get_phones_bulk_result',
    'Retrieve the status and results of a bulk phone search started with find_phones_bulk, by its batch id.',
    {
      id: z.string().describe('Batch ID returned from find_phones_bulk'),
    },
    { title: 'Get bulk phone results', ...READ },
    async (params) => request('GET', `/phone/bulk?id=${encodeURIComponent(params.id)}`)
  );

  // ── Account ──

  server.tool(
    'get_account_info',
    'Get the remaining credit balance and the registered webhook URLs of the connected Enrow account. Use only when the user asks about their Enrow credits or webhooks.',
    {},
    { title: 'Get account info', ...READ },
    async () => request('GET', '/account/info')
  );

  return server;
}
