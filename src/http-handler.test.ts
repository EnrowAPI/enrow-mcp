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

// A request has to settle. Behind Lambda, an invocation still pending when the
// event loop has nothing left to run is ended by the runtime (Runtime.NodeJsExit)
// and API Gateway answers 502; behind a Node server, the client waits forever.
// Here a timer keeps the loop alive, so a request that never settles fails its
// test instead of stalling the run.
const SETTLE_MS = 2000;
async function settled<T>(pending: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: still pending after ${SETTLE_MS} ms`)), SETTLE_MS);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type Call = { method: string; path?: string; headers?: Record<string, string>; body?: unknown };
type ProxyResult = { statusCode: number; multiValueHeaders: Record<string, string[]>; body: string };

// As production calls the Lambda entry point: an API Gateway REST API with a
// Lambda proxy integration on ANY / and ANY /{proxy+} (payload 1.0), behind
// mcp.enrow.io mapped to the stage without a base path. Header names arrive as
// the client sent them; the response carries multiValueHeaders. A string body
// is sent as it is.
async function invokeLambda(what: string, { method, path = '/mcp', headers = {}, body }: Call) {
  const received: Record<string, string> = { ...headers, Host: 'mcp.enrow.io' };
  const resource = path === '/' ? '/' : '/{proxy+}';
  const event = {
    resource,
    path,
    httpMethod: method,
    headers: received,
    multiValueHeaders: Object.fromEntries(Object.entries(received).map(([name, value]) => [name, [value]])),
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: path === '/' ? null : { proxy: path.slice(1) },
    stageVariables: null,
    requestContext: {
      resourcePath: resource,
      httpMethod: method,
      path,
      stage: 'prod',
      domainName: 'mcp.enrow.io',
      identity: { sourceIp: '127.0.0.1' },
    },
    body: body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
  };
  const result = await settled(handler(event, {}) as Promise<ProxyResult>, what);
  const header = (name: string) => result.multiValueHeaders[name] ?? null;
  return {
    status: result.statusCode,
    allow: header('allow'),
    challenge: header('www-authenticate'),
    type: header('content-type'),
    text: result.body,
  };
}

async function invokeRestApi(credential: string, body: unknown = ACCOUNT_INFO) {
  const headers = { Accept: 'application/json, text/event-stream', Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' };
  const { status, challenge, type, text } = await invokeLambda('POST /mcp', { method: 'POST', headers, body });
  return { status, challenge, type, body: JSON.parse(text) };
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

// Cursor and Claude Code open the standalone SSE stream with a GET that sends
// these headers, right after initialize.
const SSE: Record<string, string> = { accept: 'text/event-stream', 'mcp-protocol-version': '2025-11-25' };
const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` });
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-client', version: '0.0.0' } },
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };
const TOOLS_LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const PING = { jsonrpc: '2.0', id: 2, method: 'ping' };
const cancel = (requestId: number) => ({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'test' } });

const answerOf = ({ text, ...rest }: Awaited<ReturnType<typeof invokeLambda>>) => ({ ...rest, body: text ? JSON.parse(text) : text });
const NOT_ALLOWED = {
  status: 405,
  allow: ['POST'],
  challenge: null,
  type: ['application/json'],
  body: { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
};

test('through the Lambda entry point behind the REST API, a GET for the SSE stream gets a 405 with Allow: POST', async () => {
  const requests: Record<string, Record<string, string>> = {
    'as Cursor and Claude Code send it': { ...SSE, ...bearer(API_KEY) },
    'with a plugin token': { ...SSE, ...bearer(PLUGIN_TOKEN) },
    'with x-enrow-api-key': { ...SSE, 'x-enrow-api-key': API_KEY },
    'with x-api-key': { ...SSE, 'x-api-key': API_KEY },
    'without a protocol version': { accept: 'text/event-stream', ...bearer(API_KEY) },
    'accepting JSON too': { accept: 'application/json, text/event-stream', ...bearer(API_KEY) },
    'resuming after an event id': { ...SSE, ...bearer(API_KEY), 'last-event-id': 'test-event-1' },
    'with a session id': { ...SSE, ...bearer(API_KEY), 'mcp-session-id': 'test-session-1' },
    // The SDK refused these two without opening a stream (406 and 400).
    'accepting JSON only': { accept: 'application/json', ...bearer(API_KEY) },
    'with an unsupported protocol version': { ...SSE, 'mcp-protocol-version': '1999-01-01', ...bearer(API_KEY) },
  };
  const answers: Record<string, unknown> = {};
  for (const [label, headers] of Object.entries(requests)) {
    answers[label] = answerOf(await invokeLambda(`GET /mcp ${label}`, { method: 'GET', headers }));
  }
  assert.deepEqual(answers, Object.fromEntries(Object.keys(requests).map((label) => [label, NOT_ALLOWED])));
  assert.equal(sent.length, 0);
});

test('through the Lambda entry point behind the REST API, any other method than POST gets the same 405', async () => {
  const headers = { ...withCredential(API_KEY), 'mcp-protocol-version': '2025-11-25' };
  const calls: Record<string, Call> = {
    DELETE: { method: 'DELETE', headers },
    'DELETE with a session id': { method: 'DELETE', headers: { ...headers, 'mcp-session-id': 'test-session-1' } },
    PUT: { method: 'PUT', headers, body: TOOLS_LIST },
    PATCH: { method: 'PATCH', headers, body: TOOLS_LIST },
    OPTIONS: { method: 'OPTIONS', headers },
  };
  const answers: Record<string, unknown> = {};
  for (const [label, call] of Object.entries(calls)) answers[label] = answerOf(await invokeLambda(`${label} /mcp`, call));
  assert.deepEqual(answers, Object.fromEntries(Object.keys(calls).map((label) => [label, NOT_ALLOWED])));
  // A HEAD gets the same status and headers, and no body.
  const head = await invokeLambda('HEAD /mcp', { method: 'HEAD', headers: { ...SSE, ...bearer(API_KEY) } });
  assert.deepEqual(answerOf(head), { ...NOT_ALLOWED, body: '' });
  assert.equal(sent.length, 0);
});

test('through the Lambda entry point behind the REST API, any method without a credential gets the 401 that starts OAuth discovery', async () => {
  const unauthorized = {
    status: 401,
    allow: null,
    challenge: [`Bearer resource_metadata="${METADATA_URL}"`],
    type: ['application/json'],
    body: { jsonrpc: '2.0', error: { code: -32001, message: MISSING_KEY }, id: null },
  };
  const calls: Record<string, Call> = {
    POST: { method: 'POST', headers: NO_CREDENTIAL, body: INITIALIZE },
    'GET for the SSE stream': { method: 'GET', headers: SSE },
    'GET with an empty bearer': { method: 'GET', headers: { ...SSE, authorization: 'Bearer ' } },
    'GET with nothing else': { method: 'GET' },
    DELETE: { method: 'DELETE' },
    PUT: { method: 'PUT', headers: NO_CREDENTIAL, body: TOOLS_LIST },
    OPTIONS: { method: 'OPTIONS' },
  };
  const answers: Record<string, unknown> = {};
  for (const [label, call] of Object.entries(calls)) answers[label] = answerOf(await invokeLambda(`${label} /mcp without a credential`, call));
  assert.deepEqual(answers, Object.fromEntries(Object.keys(calls).map((label) => [label, unauthorized])));
  assert.deepEqual(answerOf(await invokeLambda('HEAD /mcp without a credential', { method: 'HEAD' })), { ...unauthorized, body: '' });
  assert.equal(sent.length, 0);
});

test('through the Lambda entry point behind the REST API, the discovery routes and the health check answer as before', async () => {
  const metadata = { resource: 'https://mcp.enrow.io/mcp', authorization_servers: ['https://api.enrow.io'], bearer_methods_supported: ['header'] };
  const health = { status: 'ok', service: 'enrow-mcp' };
  const ok = (body: unknown) => ({ status: 200, allow: null, challenge: null, type: ['application/json'], body });
  const answers: Record<string, unknown> = {};
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/health', '/']) {
    answers[path] = answerOf(await invokeLambda(`GET ${path}`, { method: 'GET', path }));
  }
  assert.deepEqual(answers, {
    '/.well-known/oauth-protected-resource': ok(metadata),
    '/.well-known/oauth-protected-resource/mcp': ok(metadata),
    '/health': ok(health),
    '/': ok(health),
  });
});

test('through the Lambda entry point behind the REST API, a batch that cancels one of its own requests is answered', async () => {
  const headers = withCredential(API_KEY);
  const inA200 = (body: unknown) => ({ status: 200, allow: null, challenge: null, type: ['application/json'], body });
  // The cancellation is ignored: the request gets its answer. In either order,
  // as the SDK acts on a cancellation once the whole batch is handed over.
  assert.deepEqual(
    answerOf(await invokeLambda('a tool call and its cancellation', { method: 'POST', headers, body: [ACCOUNT_INFO, cancel(7)] })),
    inA200(toolResult(7, '{\n  "credits": 42\n}')),
  );
  assert.deepEqual(
    answerOf(await invokeLambda('a cancellation and then its tool call', { method: 'POST', headers, body: [cancel(7), ACCOUNT_INFO] })),
    inA200(toolResult(7, '{\n  "credits": 42\n}')),
  );
  const both = answerOf(
    await invokeLambda('two requests and the cancellation of one', { method: 'POST', headers, body: [ACCOUNT_INFO, TOOLS_LIST, cancel(7)] }),
  );
  assert.deepEqual([both.status, both.body.map(({ id }: { id: number }) => id)], [200, [7, 1]]);
  const listed = answerOf(await invokeLambda('tools/list and its cancellation', { method: 'POST', headers, body: [TOOLS_LIST, cancel(1)] }));
  assert.deepEqual([listed.status, listed.body.id, listed.body.result.tools.length], [200, 1, 13]);
  // A request of another POST is unknown to this fresh server: as before.
  assert.deepEqual(
    answerOf(await invokeLambda('a tool call and the cancellation of another', { method: 'POST', headers, body: [ACCOUNT_INFO, cancel(99)] })),
    inA200(toolResult(7, '{\n  "credits": 42\n}')),
  );
});

// Every invocation goes through the settle guard. The statuses are the ones
// answered before the 405, except where marked: the GETs and the batch never
// settled, the DELETE was a 200.
test('through the Lambda entry point behind the REST API, every request settles', async () => {
  const headers = { ...withCredential(API_KEY), 'mcp-protocol-version': '2025-11-25' };
  const posting = (body: unknown, more: Record<string, string> = {}): Call => ({ method: 'POST', headers: { ...headers, ...more }, body });
  const calls: Record<string, [Call, number]> = {
    'POST initialize': [posting(INITIALIZE), 200],
    'POST notifications/initialized': [posting(INITIALIZED), 202],
    'POST tools/list': [posting(TOOLS_LIST), 200],
    'POST ping': [posting(PING), 200],
    'POST tools/call': [posting(ACCOUNT_INFO), 200],
    'POST a response': [posting({ jsonrpc: '2.0', id: 99, result: {} }), 202],
    'POST a batch of requests and a notification': [posting([TOOLS_LIST, PING, INITIALIZED]), 200],
    'POST a batch of notifications only': [posting([INITIALIZED, cancel(5)]), 202],
    'POST a cancellation alone': [posting(cancel(7)), 202],
    'POST a batch that cancels one of its own requests (changed)': [posting([ACCOUNT_INFO, TOOLS_LIST, cancel(7)]), 200],
    'POST an empty body': [posting(undefined), 400],
    'POST invalid JSON': [posting('{'), 400],
    'POST JSON that is not JSON-RPC': [posting({ hello: 1 }), 400],
    'POST accepting JSON only': [posting(TOOLS_LIST, { accept: 'application/json' }), 406],
    'POST as text/plain': [posting(TOOLS_LIST, { 'content-type': 'text/plain' }), 415],
    'POST an unsupported protocol version': [posting(TOOLS_LIST, { 'mcp-protocol-version': '1999-01-01' }), 400],
    'GET for the SSE stream (changed)': [{ method: 'GET', headers: { ...SSE, ...bearer(API_KEY) } }, 405],
    'GET for the SSE stream, with a plugin token (changed)': [{ method: 'GET', headers: { ...SSE, ...bearer(PLUGIN_TOKEN) } }, 405],
    'DELETE (changed)': [{ method: 'DELETE', headers }, 405],
    HEAD: [{ method: 'HEAD', headers }, 405],
    OPTIONS: [{ method: 'OPTIONS', headers }, 405],
    'GET without a credential': [{ method: 'GET', headers: SSE }, 401],
    'POST without a credential': [{ method: 'POST', headers: NO_CREDENTIAL, body: INITIALIZE }, 401],
    'GET /health': [{ method: 'GET', path: '/health' }, 200],
    'GET /.well-known/oauth-protected-resource/mcp': [{ method: 'GET', path: '/.well-known/oauth-protected-resource/mcp' }, 200],
    'GET /robots.txt': [{ method: 'GET', path: '/robots.txt' }, 404],
    'HEAD /health': [{ method: 'HEAD', path: '/health' }, 404],
  };
  const statuses: Record<string, number> = {};
  for (const [label, [call]] of Object.entries(calls)) statuses[label] = (await invokeLambda(label, call)).status;
  assert.deepEqual(statuses, Object.fromEntries(Object.entries(calls).map(([label, [, status]]) => [label, status])));
});

test('behind a standalone Node server, a GET for the SSE stream gets the 405 instead of a stream that never ends', async () => {
  const server = createServer(discoveryOn);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await settled(realFetch(`http://127.0.0.1:${port}/mcp`, { headers: { ...SSE, ...bearer(API_KEY) } }), 'GET /mcp');
    assert.deepEqual(
      { status: res.status, allow: res.headers.get('allow'), type: res.headers.get('content-type'), body: await settled(res.json(), 'GET /mcp, its body') },
      { status: 405, allow: 'POST', type: 'application/json', body: NOT_ALLOWED.body },
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
