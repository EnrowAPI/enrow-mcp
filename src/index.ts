#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE_URL = 'https://api.enrow.io';

function getApiKey(): string {
  const key = process.env.ENROW_API_KEY;
  if (!key) throw new Error('ENROW_API_KEY environment variable is required');
  return key;
}

async function request(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'x-api-key': getApiKey(),
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) {
    return { content: [{ type: 'text' as const, text: `Error ${res.status}: ${data.message || JSON.stringify(data)}` }], isError: true };
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({
  name: 'enrow',
  version: '1.0.0',
});

// ── Email Finder ──

server.tool(
  'find_email',
  'Find a professional email address from a name and company domain or name',
  {
    fullname: z.string().describe('Full name of the person (e.g. "Tim Cook")'),
    company_domain: z.string().optional().describe('Company domain (e.g. "apple.com")'),
    company_name: z.string().optional().describe('Company name (e.g. "Apple Inc.")'),
    country_code: z.string().optional().describe('ISO 3166 Alpha-2 country code'),
    retrieve_gender: z.boolean().optional().describe('Return gender information'),
  },
  async (params) => {
    const body: Record<string, unknown> = { fullname: params.fullname };
    if (params.company_domain) body.company_domain = params.company_domain;
    if (params.company_name) body.company_name = params.company_name;
    const settings: Record<string, unknown> = {};
    if (params.country_code) settings.country_code = params.country_code;
    if (params.retrieve_gender) settings.retrieve_gender = params.retrieve_gender;
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
  async (params) => request('GET', `/email/find/single?id=${params.id}`)
);

server.tool(
  'find_emails_bulk',
  'Find multiple email addresses in bulk (up to 5,000)',
  {
    searches: z.array(z.object({
      fullname: z.string(),
      company_domain: z.string().optional(),
      company_name: z.string().optional(),
    })).describe('Array of search objects'),
    country_code: z.string().optional(),
    retrieve_gender: z.boolean().optional(),
  },
  async (params) => {
    const body: Record<string, unknown> = { searches: params.searches };
    const settings: Record<string, unknown> = {};
    if (params.country_code) settings.country_code = params.country_code;
    if (params.retrieve_gender) settings.retrieve_gender = params.retrieve_gender;
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
  async (params) => request('GET', `/email/find/bulk?id=${params.id}`)
);

// ── Email Verifier ──

server.tool(
  'verify_email',
  'Verify if an email address is deliverable. Works on catch-all domains.',
  {
    email: z.string().describe('Email address to verify'),
  },
  async (params) => request('POST', '/email/verify/single', { email: params.email })
);

server.tool(
  'get_verification_result',
  'Retrieve the result of a previously launched email verification',
  {
    id: z.string().describe('Verification ID returned from verify_email'),
  },
  async (params) => request('GET', `/email/verify/single?id=${params.id}`)
);

server.tool(
  'verify_emails_bulk',
  'Verify multiple email addresses in bulk (up to 5,000)',
  {
    emails: z.array(z.string()).describe('Array of email addresses to verify'),
  },
  async (params) => request('POST', '/email/verify/bulk', { emails: params.emails })
);

server.tool(
  'get_verifications_bulk_result',
  'Retrieve results of a bulk email verification',
  {
    id: z.string().describe('Batch ID returned from verify_emails_bulk'),
  },
  async (params) => request('GET', `/email/verify/bulk?id=${params.id}`)
);

// ── Phone Finder ──

server.tool(
  'find_phone',
  'Find a mobile phone number from a LinkedIn URL or name + company',
  {
    linkedin_url: z.string().optional().describe('LinkedIn profile URL (recommended)'),
    first_name: z.string().optional().describe('First name'),
    last_name: z.string().optional().describe('Last name'),
    company_domain: z.string().optional().describe('Company domain'),
    company_name: z.string().optional().describe('Company name'),
  },
  async (params) => {
    const body: Record<string, unknown> = {};
    if (params.linkedin_url) body.linkedin_url = params.linkedin_url;
    if (params.first_name) body.first_name = params.first_name;
    if (params.last_name) body.last_name = params.last_name;
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
  async (params) => request('GET', `/phone/single?id=${params.id}`)
);

server.tool(
  'find_phones_bulk',
  'Find multiple phone numbers in bulk (up to 5,000)',
  {
    searches: z.array(z.object({
      linkedin_url: z.string().optional(),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      company_domain: z.string().optional(),
      company_name: z.string().optional(),
    })).describe('Array of search objects'),
  },
  async (params) => request('POST', '/phone/bulk', { searches: params.searches })
);

server.tool(
  'get_phones_bulk_result',
  'Retrieve results of a bulk phone search',
  {
    id: z.string().describe('Batch ID returned from find_phones_bulk'),
  },
  async (params) => request('GET', `/phone/bulk?id=${params.id}`)
);

// ── Account ──

server.tool(
  'get_account_info',
  'Get your Enrow account info (credit balance and webhooks)',
  {},
  async () => request('GET', '/account/info')
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
