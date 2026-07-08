/**
 * Shared HTTP request listener for the Enrow MCP Streamable HTTP transport.
 *
 * It is a plain Node `(req, res)` handler, so it runs unchanged as:
 *   - a standalone server (`http.ts` — local, PM2, App Runner, Fargate), and
 *   - an AWS Lambda behind API Gateway (`lambda.ts`, via serverless-express).
 *
 * Stateless + multi-tenant: the caller's Enrow API key is read per request from
 * `Authorization: Bearer <key>` (or the `x-enrow-api-key` header), and a fresh
 * MCP server + transport are created per request.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createEnrowServer } from './server.js';

const MCP_PATH = process.env.MCP_PATH ?? '/mcp';

// OAuth discovery (RFC 9728). Gated behind a flag so we only advertise OAuth
// once the Enrow Authorization Server routes are live — advertising a broken
// AS would make clients attempt OAuth instead of falling back to header keys.
const OAUTH_DISCOVERY_ENABLED = process.env.OAUTH_DISCOVERY_ENABLED === '1';
const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL ?? 'https://mcp.enrow.io/mcp';
const OAUTH_ISSUER = process.env.OAUTH_ISSUER ?? 'https://api.enrow.io';
const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

function extractApiKey(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  const header = req.headers['x-enrow-api-key'] ?? req.headers['x-api-key'];
  return typeof header === 'string' && header ? header : undefined;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export async function listener(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '').split('?')[0];

  // Health check for load balancers / uptime probes.
  if (req.method === 'GET' && (path === '/health' || path === '/')) {
    sendJson(res, 200, { status: 'ok', service: 'enrow-mcp' });
    return;
  }

  // RFC 9728 protected-resource metadata: points OAuth-capable clients at the
  // Enrow Authorization Server. Only served once the AS is live (flag).
  // Clients probe both the bare path and the resource-suffixed variant
  // (/.well-known/oauth-protected-resource/mcp) — serve both.
  const isMetadataPath =
    path === RESOURCE_METADATA_PATH || path === `${RESOURCE_METADATA_PATH}${MCP_PATH}`;
  if (OAUTH_DISCOVERY_ENABLED && req.method === 'GET' && isMetadataPath) {
    sendJson(res, 200, {
      resource: MCP_PUBLIC_URL,
      authorization_servers: [OAUTH_ISSUER],
      bearer_methods_supported: ['header'],
    });
    return;
  }

  if (path !== MCP_PATH) {
    sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32601, message: 'Not found' }, id: null });
    return;
  }

  const apiKey = extractApiKey(req);
  if (!apiKey) {
    if (OAUTH_DISCOVERY_ENABLED) {
      // RFC 9728 §5.1: tell the client where the resource metadata lives so it
      // can run the OAuth flow. Derive the metadata URL from the public URL.
      const origin = new URL(MCP_PUBLIC_URL).origin;
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}"`,
      );
    }
    sendJson(res, 401, {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Missing Enrow API key. Pass it as "Authorization: Bearer <key>" or the "x-enrow-api-key" header.' },
      id: null,
    });
    return;
  }

  // Pre-read and parse the JSON-RPC body for POST so the transport doesn't have
  // to re-read the stream (the documented handleRequest(req, res, body) pattern).
  let parsedBody: unknown;
  if (req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return;
    }
  }

  // Stateless: a fresh server + transport per request.
  const server = createEnrowServer(() => apiKey);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('MCP request failed:', msg);
    if (!res.headersSent) {
      sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
}
