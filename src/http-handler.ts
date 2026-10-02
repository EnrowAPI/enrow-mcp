/**
 * Shared HTTP request listener for the Enrow MCP Streamable HTTP transport.
 *
 * It is a plain Node `(req, res)` handler, so it runs unchanged as:
 *   - a standalone server (`http.ts` — local, PM2, App Runner, Fargate), and
 *   - an AWS Lambda behind API Gateway (`lambda.ts`, via serverless-express).
 *
 * Stateless + multi-tenant: the caller's Enrow API key is read per request from
 * `Authorization: Bearer <key>` (or the `x-enrow-api-key` header), and a fresh
 * MCP server + transport are created per request. The MCP path serves POST
 * only: with no session there is no stream to open on a GET and nothing to end
 * with a DELETE, so any other method gets a 405 once a credential is present.
 *
 * A plugin token that the Enrow API refuses itself during a tool call (token
 * invalid, revoked, evicted or expired) gets an HTTP 401 with an
 * `invalid_token` challenge rather than a tool error, so the client signs in
 * again. Any other refusal stays a tool error in a 200 (see `createEnrowServer`),
 * and so does a batch in which any request got another answer.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { isJSONRPCNotification, isJSONRPCRequest, type RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { ChannelSecretProvider } from './channel-proof.js';
import { createEnrowServer } from './server.js';

const MCP_PATH = process.env.MCP_PATH ?? '/mcp';

// OAuth discovery (RFC 9728). Gated behind a flag so we only advertise OAuth
// once the Enrow Authorization Server routes are live — advertising a broken
// AS would make clients attempt OAuth instead of falling back to header keys.
const OAUTH_DISCOVERY_ENABLED = process.env.OAUTH_DISCOVERY_ENABLED === '1';
const MCP_PUBLIC_URL = process.env.MCP_PUBLIC_URL ?? 'https://mcp.enrow.io/mcp';
const OAUTH_ISSUER = process.env.OAUTH_ISSUER ?? 'https://api.enrow.io';
const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';

// OpenAI plugin-directory domain verification: the submission portal issues a
// token that must be served verbatim (plain text) at this path. Unset → 404.
const OPENAI_CHALLENGE_PATH = '/.well-known/openai-apps-challenge';
const OPENAI_APPS_CHALLENGE = process.env.OPENAI_APPS_CHALLENGE ?? '';

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

// RFC 9728 §5.1: where the resource metadata lives, derived from the public URL.
function resourceMetadataUrl(): string {
  return `${new URL(MCP_PUBLIC_URL).origin}${RESOURCE_METADATA_PATH}`;
}

// MCP authorization: invalid or expired tokens MUST receive a 401. The
// challenge is the RFC 6750 §3 one, with a fixed description (header-safe);
// the detail from the Enrow API goes in the JSON-RPC message.
function credentialRefusedResponse(message: string): Response {
  const challenge = ['Bearer error="invalid_token"', 'error_description="The Enrow API refused the credential"'];
  if (OAUTH_DISCOVERY_ENABLED) challenge.push(`resource_metadata="${resourceMetadataUrl()}"`);
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': challenge.join(', ') },
  });
}

// The 401 replaces the response only when every JSON-RPC request of the body
// (one message or a batch; a notification gets no answer) had its plugin token
// refused: a batch that holds any other answer keeps its per-call results.
// Gives the text of the first refusal, or nothing. Requests are told apart as
// the transport tells them apart.
function refusalOf(body: unknown, refusals: ReadonlyMap<RequestId, string>): string | undefined {
  const ids = (Array.isArray(body) ? body : [body]).filter(isJSONRPCRequest).map((message) => message.id);
  return ids.length > 0 && ids.every((id) => refusals.has(id)) ? refusals.get(ids[0]) : undefined;
}

// A batch can cancel one of its own requests. The SDK then sends no answer to
// that request, while in JSON mode the transport waits for every answer of the
// batch: the response would never come, and behind Lambda the invocation would
// never settle. A receiver may ignore a cancellation, and a stateless server
// can act on no other kind (a later POST reaches a fresh server), so these
// notifications are dropped.
function withoutSelfCancellations(body: unknown): unknown {
  if (!Array.isArray(body)) return body;
  const ids = new Set<unknown>(body.filter(isJSONRPCRequest).map((message) => message.id));
  return body.filter(
    (message) => !(isJSONRPCNotification(message) && message.method === 'notifications/cancelled' && ids.has(message.params?.requestId)),
  );
}

export async function listener(
  req: IncomingMessage,
  res: ServerResponse,
  getChannelSecret?: ChannelSecretProvider,
): Promise<void> {
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

  if (OPENAI_APPS_CHALLENGE && req.method === 'GET' && path === OPENAI_CHALLENGE_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(OPENAI_APPS_CHALLENGE);
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
      // can run the OAuth flow.
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl()}"`);
    }
    sendJson(res, 401, {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Missing Enrow API key. Pass it as "Authorization: Bearer <key>" or the "x-enrow-api-key" header.' },
      id: null,
    });
    return;
  }

  // MCP Streamable HTTP lets a server that offers no stream answer 405 to a
  // GET, and to a DELETE when it has no session to end; the SDK client takes
  // the 405 on its GET as "no stream offered". Left to the SDK, the GET would
  // get a text/event-stream that nothing ever writes to or ends: behind Lambda
  // the invocation never settles, the runtime ends it as Runtime.NodeJsExit and
  // the client gets a 502. Checked after the credential, so that a request
  // without one still gets the 401 that starts OAuth discovery, whatever its
  // method.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    return;
  }

  // Pre-read and parse the JSON-RPC body so the transport doesn't have to
  // re-read the stream (the documented handleRequest(req, res, body) pattern).
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  let parsedBody: unknown;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    return;
  }

  // Stateless: a fresh server + transport per request. A tool call whose
  // plugin token the Enrow API refuses leaves the text of its error here,
  // under the id of its JSON-RPC request.
  const refusals = new Map<RequestId, string>();
  const server = createEnrowServer(() => apiKey, getChannelSecret, (message, requestId) => {
    refusals.set(requestId, message);
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  // The SDK's Node transport is this same transport behind this same adapter
  // (Node request in, web response written back, global Request and Response
  // left alone). Calling them directly adds one step: the response is in hand
  // before it is written, so a refused plugin token can replace it. In JSON
  // mode it is ready once every tool call of the request has returned.
  const handle = getRequestListener(
    async (request) => {
      const response = await transport.handleRequest(request, { parsedBody: withoutSelfCancellations(parsedBody) });
      const refusal = refusalOf(parsedBody, refusals);
      return refusal === undefined ? response : credentialRefusedResponse(refusal);
    },
    { overrideGlobalObjects: false },
  );

  try {
    await server.connect(transport);
    await handle(req, res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('MCP request failed:', msg);
    if (!res.headersSent) {
      sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
}
