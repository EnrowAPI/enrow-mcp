import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, mock, test } from 'node:test';

// Test credentials only: an API key, and a plugin token (the prefix of the
// tokens of the Enrow OAuth server).
const API_KEY = 'test-credential-0001';
const PLUGIN_TOKEN = 'enrow_mcp_test-credential-0001';
const ID = '3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f';
const REFUSED = 'This connection to Enrow is not valid. Please reconnect Enrow and try again.';
const PHONE_REFUSED = 'This account is not allowed to use the phone search feature';
const METADATA_URL = 'https://mcp.enrow.io/.well-known/oauth-protected-resource';
const CHALLENGE = 'Bearer error="invalid_token", error_description="The Enrow API refused the credential"';
const MISSING_KEY = 'Missing Enrow API key. Pass it as "Authorization: Bearer <key>" or the "x-enrow-api-key" header.';

const NO_CREDENTIAL: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const withCredential = (credential: string) => ({ ...NO_CREDENTIAL, authorization: `Bearer ${credential}` });

const toolCall = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});
const ACCOUNT_INFO = toolCall(7, 'get_account_info');
const FIND_EMAIL = toolCall(8, 'find_email', { fullname: 'Ada Lovelace', company_domain: 'example.com' });
const FIND_PHONE = toolCall(9, 'find_phone', { linkedin_url: 'https://www.linkedin.com/in/ada' });

// Answers of the Enrow API.
type Answer = { status: number; body: string };
const answer = (status: number, body: unknown): Answer => ({ status, body: JSON.stringify(body) });
const CREDENTIAL_REFUSED = answer(401, { message: REFUSED, reason: 'credential_refused' });
const CHANNEL_REFUSED = answer(401, { message: REFUSED, reason: 'channel_refused' });

// The flag and the public URL are read when the module loads, so each copy is
// loaded with its own environment: a query string makes it a module of its own.
delete process.env.MCP_PATH;
delete process.env.MCP_PUBLIC_URL;
delete process.env.CHANNEL_SECRET_PARAMETER;

type Listener = (typeof import('./http-handler.js'))['listener'];

async function loadListener(discovery: boolean): Promise<Listener> {
  if (discovery) process.env.OAUTH_DISCOVERY_ENABLED = '1';
  else delete process.env.OAUTH_DISCOVERY_ENABLED;
  const module = (await import(`./http-handler.js?discovery=${discovery}`)) as typeof import('./http-handler.js');
  return module.listener;
}

const discoveryOff = await loadListener(false);
const discoveryOn = await loadListener(true);
// The Lambda entry point loads a copy of its own, here with discovery on.
const { handler } = (await import('./lambda.js')) as typeof import('./lambda.js');

const realFetch = globalThis.fetch;
// What the Enrow API answers: `upstreamAt` by path, `upstream` for any other.
let upstream: Answer;
let upstreamAt: Record<string, Answer>;
// What went upstream.
let sent: { path: string; headers: Headers }[];

beforeEach(() => {
  upstream = answer(200, { credits: 42 });
  upstreamAt = {};
  sent = [];
  mock.method(globalThis, 'fetch', async (input: URL | string, init?: RequestInit) => {
    const { pathname } = new URL(String(input));
    sent.push({ path: pathname, headers: new Headers(init?.headers) });
    const { status, body } = upstreamAt[pathname] ?? upstream;
    return new Response(body, { status });
  });
});
afterEach(() => mock.restoreAll());

// As http.ts runs the listener: behind a standalone Node server.
async function post(listener: RequestListener, headers: Record<string, string>, body: unknown = ACCOUNT_INFO) {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await realFetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
    return {
      status: res.status,
      challenge: res.headers.get('www-authenticate'),
      type: res.headers.get('content-type'),
      body: await res.json(),
    };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

// As production calls the Lambda entry point: an API Gateway REST API with a
// Lambda proxy integration on ANY /{proxy+} (payload 1.0), behind mcp.enrow.io
// mapped to the stage without a base path. Header names arrive as the client
// sent them; the response carries multiValueHeaders.
async function invokeRestApi(credential: string, body: unknown = ACCOUNT_INFO) {
  const headers: Record<string, string> = {
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${credential}`,
    'Content-Type': 'application/json',
    Host: 'mcp.enrow.io',
  };
  const result = await handler(
    {
      resource: '/{proxy+}',
      path: '/mcp',
      httpMethod: 'POST',
      headers,
      multiValueHeaders: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, [value]])),
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      pathParameters: { proxy: 'mcp' },
      stageVariables: null,
      requestContext: {
        resourcePath: '/{proxy+}',
        httpMethod: 'POST',
        path: '/mcp',
        stage: 'prod',
        domainName: 'mcp.enrow.io',
        identity: { sourceIp: '127.0.0.1' },
      },
      body: JSON.stringify(body),
      isBase64Encoded: false,
    },
    {},
  );
  return {
    status: result.statusCode,
    challenge: result.multiValueHeaders['www-authenticate'] ?? null,
    type: result.multiValueHeaders['content-type'],
    body: JSON.parse(result.body),
  };
}

// As an API Gateway HTTP API (payload 2.0) would call the Lambda entry point:
// serverless-express reads both versions of the event.
async function invokeHttpApi(headers: Record<string, string>, body: unknown = ACCOUNT_INFO) {
  const result = await handler(
    {
      version: '2.0',
      routeKey: '$default',
      rawPath: '/mcp',
      rawQueryString: '',
      headers: { ...headers, host: 'mcp.enrow.io' },
      requestContext: { http: { method: 'POST', path: '/mcp', sourceIp: '127.0.0.1' } },
      body: JSON.stringify(body),
      isBase64Encoded: false,
    },
    {},
  );
  return {
    status: result.statusCode,
    challenge: result.headers['www-authenticate'] ?? null,
    type: result.headers['content-type'],
    body: JSON.parse(result.body),
  };
}

const refusedBody = { jsonrpc: '2.0', error: { code: -32001, message: `Error 401: ${REFUSED}` }, id: null };
const toolResult = (id: number, text: string) => ({ result: { content: [{ type: 'text', text }] }, jsonrpc: '2.0', id });
const toolError = (id: number, text: string) => ({ result: { content: [{ type: 'text', text }], isError: true }, jsonrpc: '2.0', id });
const toolErrorIn200 = (id: number, text: string) => ({ status: 200, challenge: null, type: 'application/json', body: toolError(id, text) });

test('a plugin token that the Enrow API refuses itself gets an HTTP 401 with an invalid_token challenge', async () => {
  upstream = CREDENTIAL_REFUSED;
  assert.deepEqual(await post(discoveryOff, withCredential(PLUGIN_TOKEN)), { status: 401, challenge: CHALLENGE, type: 'application/json', body: refusedBody });
  assert.equal(sent.length, 1);
});

test('with discovery on, the challenge also points at the resource metadata', async () => {
  upstream = CREDENTIAL_REFUSED;
  assert.deepEqual(await post(discoveryOn, withCredential(PLUGIN_TOKEN)), {
    status: 401,
    challenge: `${CHALLENGE}, resource_metadata="${METADATA_URL}"`,
    type: 'application/json',
    body: refusedBody,
  });
});

test('a refused channel proof stays a tool error in a 200: a new sign-in would not help', async () => {
  upstream = CHANNEL_REFUSED;
  for (const listener of [discoveryOff, discoveryOn]) {
    assert.deepEqual(await post(listener, withCredential(PLUGIN_TOKEN)), toolErrorIn200(7, `Error 401: ${REFUSED}`));
  }
});

test('a plugin token sent unsigned while the channel secret is unavailable asks for no sign-in', async () => {
  // The Enrow API refuses the missing proof, not the token.
  upstream = CHANNEL_REFUSED;
  const unavailable = [
    async () => undefined,
    async () => {
      throw new Error('unavailable');
    },
  ];
  for (const getChannelSecret of unavailable) {
    const listener: RequestListener = (req, res) => void discoveryOn(req, res, getChannelSecret);
    assert.deepEqual(await post(listener, withCredential(PLUGIN_TOKEN)), toolErrorIn200(7, `Error 401: ${REFUSED}`));
  }
  assert.deepEqual(
    sent.map(({ headers }) => [headers.get('x-api-key'), headers.get('x-enrow-mcp-proof')]),
    [[PLUGIN_TOKEN, null], [PLUGIN_TOKEN, null]],
  );
});

test('with an API key, the phone-feature 401 stays a tool error in a 200', async () => {
  upstream = answer(401, { message: PHONE_REFUSED });
  assert.deepEqual(await post(discoveryOn, withCredential(API_KEY), FIND_PHONE), toolErrorIn200(9, `Error 401: ${PHONE_REFUSED}`));
  assert.deepEqual(sent.map(({ path }) => path), ['/phone/single']);
});

test('with an API key, any 401 stays a tool error in a 200, even one that says credential_refused', async () => {
  for (const listener of [discoveryOff, discoveryOn]) {
    upstream = answer(401, { message: 'This apikey is not valid' });
    assert.deepEqual(await post(listener, withCredential(API_KEY)), toolErrorIn200(7, 'Error 401: This apikey is not valid'));
    upstream = CREDENTIAL_REFUSED;
    assert.deepEqual(await post(listener, withCredential(API_KEY)), toolErrorIn200(7, `Error 401: ${REFUSED}`));
  }
});

test('any other answer to a plugin token stays a tool error in a 200', async () => {
  // A 401 without a reason, as the Enrow API answered before it gave one, and
  // any other status, even with that reason.
  const answers = [
    answer(401, { message: 'upstream' }),
    ...[402, 403, 404, 500, 503].map((status) => answer(status, { message: 'upstream', reason: 'credential_refused' })),
  ];
  for (const listener of [discoveryOff, discoveryOn]) {
    for (const refusal of answers) {
      upstream = refusal;
      assert.deepEqual(await post(listener, withCredential(PLUGIN_TOKEN)), toolErrorIn200(7, `Error ${refusal.status}: upstream`));
    }
  }
});

test('a successful tool call is answered as before', async () => {
  for (const credential of [API_KEY, PLUGIN_TOKEN]) {
    assert.deepEqual(await post(discoveryOn, withCredential(credential)), {
      status: 200,
      challenge: null,
      type: 'application/json',
      body: toolResult(7, '{\n  "credits": 42\n}'),
    });
  }
});

test('a request without a credential gets the same 401 as before, and nothing goes upstream', async () => {
  const body = { jsonrpc: '2.0', error: { code: -32001, message: MISSING_KEY }, id: null };
  assert.deepEqual(await post(discoveryOff, NO_CREDENTIAL), { status: 401, challenge: null, type: 'application/json', body });
  assert.deepEqual(await post(discoveryOn, NO_CREDENTIAL), {
    status: 401,
    challenge: `Bearer resource_metadata="${METADATA_URL}"`,
    type: 'application/json',
    body,
  });
  assert.equal(sent.length, 0);
});

test('a batch in which any request got another answer keeps its per-call results in a 200', async () => {
  upstreamAt['/account/info'] = CREDENTIAL_REFUSED;
  upstream = answer(200, { id: ID });
  assert.deepEqual(await post(discoveryOn, withCredential(PLUGIN_TOKEN), [FIND_EMAIL, ACCOUNT_INFO]), {
    status: 200,
    challenge: null,
    type: 'application/json',
    body: [toolResult(8, `{\n  "id": "${ID}"\n}`), toolError(7, `Error 401: ${REFUSED}`)],
  });
  // A refused channel proof, or a request that is not a tool call, is another
  // answer too.
  upstream = CHANNEL_REFUSED;
  for (const other of [FIND_EMAIL, { jsonrpc: '2.0', id: 8, method: 'tools/list' }]) {
    const { status, challenge, body } = await post(discoveryOn, withCredential(PLUGIN_TOKEN), [ACCOUNT_INFO, other]);
    assert.deepEqual([status, challenge, body.map((response: { id: number }) => response.id)], [200, null, [7, 8]]);
  }
});

test('a batch in which every request had its plugin token refused gets the 401', async () => {
  upstream = CREDENTIAL_REFUSED;
  // A notification gets no answer of its own: it is not counted.
  const batch = [ACCOUNT_INFO, toolCall(8, 'get_email_result', { id: ID }), { jsonrpc: '2.0', method: 'notifications/initialized' }];
  assert.deepEqual(await post(discoveryOn, withCredential(PLUGIN_TOKEN), batch), {
    status: 401,
    challenge: `${CHALLENGE}, resource_metadata="${METADATA_URL}"`,
    type: 'application/json',
    body: refusedBody,
  });
  assert.deepEqual(sent.map(({ path }) => path), ['/account/info', '/email/find/single']);
});

test('through the Lambda entry point behind the REST API, a refused plugin token is a 401 with the challenge', async () => {
  upstream = CREDENTIAL_REFUSED;
  assert.deepEqual(await invokeRestApi(PLUGIN_TOKEN), {
    status: 401,
    challenge: [`${CHALLENGE}, resource_metadata="${METADATA_URL}"`],
    type: ['application/json'],
    body: refusedBody,
  });
});

test('through the Lambda entry point behind the REST API, any other answer stays a tool error in a 200', async () => {
  const inA200 = (id: number, text: string) => ({ status: 200, challenge: null, type: ['application/json'], body: toolError(id, text) });
  upstream = CHANNEL_REFUSED;
  assert.deepEqual(await invokeRestApi(PLUGIN_TOKEN), inA200(7, `Error 401: ${REFUSED}`));
  upstream = answer(401, { message: PHONE_REFUSED });
  assert.deepEqual(await invokeRestApi(API_KEY, FIND_PHONE), inA200(9, `Error 401: ${PHONE_REFUSED}`));
  upstream = answer(500, { message: 'upstream' });
  assert.deepEqual(await invokeRestApi(PLUGIN_TOKEN), inA200(7, 'Error 500: upstream'));
});

test('through the Lambda entry point behind an HTTP API, a refused plugin token is a 401 with the challenge', async () => {
  upstream = CREDENTIAL_REFUSED;
  assert.deepEqual(await invokeHttpApi(withCredential(PLUGIN_TOKEN)), {
    status: 401,
    challenge: `${CHALLENGE}, resource_metadata="${METADATA_URL}"`,
    type: 'application/json',
    body: refusedBody,
  });
});

test('through the Lambda entry point behind an HTTP API, any other answer stays a tool error in a 200', async () => {
  upstream = CHANNEL_REFUSED;
  assert.deepEqual(await invokeHttpApi(withCredential(PLUGIN_TOKEN)), toolErrorIn200(7, `Error 401: ${REFUSED}`));
  for (const status of [402, 404, 500]) {
    upstream = answer(status, { message: `upstream ${status}` });
    assert.deepEqual(await invokeHttpApi(withCredential(PLUGIN_TOKEN)), toolErrorIn200(7, `Error ${status}: upstream ${status}`));
  }
});
