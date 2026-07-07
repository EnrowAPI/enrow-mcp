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
    version: '1.1.0',
  });

  // Annotation presets. `find_*`/`verify_*` create an async job and spend
  // credits, so they are not read-only; `get_*` retrievals are read-only.
  const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
  const READ = { readOnlyHint: true, openWorldHint: true } as const;

  // ── Email Finder ──

  server.tool(
    'find_email',
    'Find a professional email address from a name and a company domain or name. At least one of company_domain or company_name is required. Asynchronous: returns a search id, then poll get_email_result.',
    {
      fullname: z.string().describe('Full name of the person (e.g. "Tim Cook")'),
      company_domain: z.string().optional().describe('Company domain (e.g. "apple.com")'),
      company_name: z.string().optional().describe('Company name (e.g. "Apple Inc.")'),
      country_code: z.string().optional().describe('ISO 3166 Alpha-2 country code (default "US", used with company_name)'),
      retrieve_gender: z.boolean().optional().describe('Return gender information (male/female)'),
      retrieve_company_info: z.boolean().optional().describe('Enrich the result with company info'),
    },
    { title: 'Find email', ...WRITE },
    async (params) => {
      if (!params.company_domain && !params.company_name) {
        return { content: [{ type: 'text' as const, text: 'Error: provide at least one of company_domain or company_name.' }], isError: true };
      }
      const body: Record<string, unknown> = { fullname: params.fullname };
      if (params.company_domain) body.company_domain = params.company_domain;
      if (params.company_name) body.company_name = params.company_name;
      const settings: Record<string, unknown> = {};
      if (params.country_code) settings.country_code = params.country_code;
      if (params.retrieve_gender) settings.retrieve_gender = params.retrieve_gender;
      if (params.retrieve_company_info) settings.retrieve_company_info = params.retrieve_company_info;
      if (Object.keys(settings).length) body.settings = settings;
      return request('POST', '/email/find/single', body);
    }
  );

  server.tool(
    'get_email_result',
    'Retrieve the result of a previously launched email search',
    {
      id: z.string().describe('Search ID returned from find_email'),
    },
    { title: 'Get email result', ...READ },
    async (params) => request('GET', `/email/find/single?id=${encodeURIComponent(params.id)}`)
  );

  server.tool(
    'find_emails_bulk',
    'Find multiple email addresses in bulk (up to 5,000 per batch). Asynchronous: returns a batch id, then poll get_emails_bulk_result.',
    {
      searches: z.array(z.object({
        fullname: z.string(),
        company_domain: z.string().optional(),
        company_name: z.string().optional(),
      })).describe('Array of search objects'),
      country_code: z.string().optional(),
      retrieve_gender: z.boolean().optional(),
      retrieve_company_info: z.boolean().optional().describe('Enrich results with company info'),
    },
    { title: 'Find emails (bulk)', ...WRITE },
    async (params) => {
      const body: Record<string, unknown> = { searches: params.searches };
      const settings: Record<string, unknown> = {};
      if (params.country_code) settings.country_code = params.country_code;
      if (params.retrieve_gender) settings.retrieve_gender = params.retrieve_gender;
      if (params.retrieve_company_info) settings.retrieve_company_info = params.retrieve_company_info;
      if (Object.keys(settings).length) body.settings = settings;
      return request('POST', '/email/find/bulk', body);
    }
  );

  server.tool(
    'get_emails_bulk_result',
    'Retrieve results of a bulk email search',
    {
      id: z.string().describe('Batch ID returned from find_emails_bulk'),
    },
    { title: 'Get bulk email results', ...READ },
    async (params) => request('GET', `/email/find/bulk?id=${encodeURIComponent(params.id)}`)
  );

  // ── Email Verifier ──

  server.tool(
    'verify_email',
    'Verify if an email address is deliverable. Works on catch-all domains. Asynchronous: returns a verification id, then poll get_verification_result.',
    {
      email: z.string().describe('Email address to verify'),
    },
    { title: 'Verify email', ...WRITE },
    async (params) => request('POST', '/email/verify/single', { email: params.email })
  );

  server.tool(
    'get_verification_result',
    'Retrieve the result of a previously launched email verification',
    {
      id: z.string().describe('Verification ID returned from verify_email'),
    },
    { title: 'Get verification result', ...READ },
    async (params) => request('GET', `/email/verify/single?id=${encodeURIComponent(params.id)}`)
  );

  server.tool(
    'verify_emails_bulk',
    'Verify multiple email addresses in bulk (up to 5,000 per batch). Asynchronous: returns a batch id, then poll get_verifications_bulk_result.',
    {
      emails: z.array(z.string()).describe('Array of email addresses to verify'),
    },
    { title: 'Verify emails (bulk)', ...WRITE },
    // The API reads the array under the `verifications` key (not `emails`).
    async (params) => request('POST', '/email/verify/bulk', { verifications: params.emails })
  );

  server.tool(
    'get_verifications_bulk_result',
    'Retrieve results of a bulk email verification',
    {
      id: z.string().describe('Batch ID returned from verify_emails_bulk'),
    },
    { title: 'Get bulk verification results', ...READ },
    async (params) => request('GET', `/email/verify/bulk?id=${encodeURIComponent(params.id)}`)
  );

  // ── Phone Finder ──

  server.tool(
    'find_phone',
    'Find a mobile phone number from a LinkedIn URL (recommended) or first name + last name + company. Asynchronous: returns a search id, then poll get_phone_result.',
    {
      linkedin_url: z.string().optional().describe('LinkedIn profile URL (recommended; takes precedence)'),
      first_name: z.string().optional().describe('First name'),
      last_name: z.string().optional().describe('Last name'),
      company_domain: z.string().optional().describe('Company domain'),
      company_name: z.string().optional().describe('Company name'),
    },
    { title: 'Find phone', ...WRITE },
    async (params) => {
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
    'Retrieve the result of a previously launched phone search',
    {
      id: z.string().describe('Search ID returned from find_phone'),
    },
    { title: 'Get phone result', ...READ },
    async (params) => request('GET', `/phone/single?id=${encodeURIComponent(params.id)}`)
  );

  server.tool(
    'find_phones_bulk',
    'Find multiple phone numbers in bulk (up to 3,000 per batch). Asynchronous: returns a batch id, then poll get_phones_bulk_result.',
    {
      searches: z.array(z.object({
        linkedin_url: z.string().optional(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        company_domain: z.string().optional(),
        company_name: z.string().optional(),
      })).describe('Array of search objects (max 3,000)'),
    },
    { title: 'Find phones (bulk)', ...WRITE },
    async (params) => {
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
    'Retrieve results of a bulk phone search',
    {
      id: z.string().describe('Batch ID returned from find_phones_bulk'),
    },
    { title: 'Get bulk phone results', ...READ },
    async (params) => request('GET', `/phone/bulk?id=${encodeURIComponent(params.id)}`)
  );

  // ── Account ──

  server.tool(
    'get_account_info',
    'Get your Enrow account info (credit balance and registered webhooks)',
    {},
    { title: 'Get account info', ...READ },
    async () => request('GET', '/account/info')
  );

  return server;
}
