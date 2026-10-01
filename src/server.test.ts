// Needs Node 20.11 or later (mock.timers on Date).
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RequestId } from '@modelcontextprotocol/sdk/types.js';
import { createEnrowServer } from './server.js';

// Test secret and test credentials only: an API key, and a plugin token (the
// prefix of the tokens of the Enrow OAuth server).
const SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const CREDENTIAL = 'test-credential-0001';
const PLUGIN_TOKEN = 'enrow_mcp_test-credential-0001';
const ID = '3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f';
const PROOF_GET = 'v1.1790000000.a713ab39de3d869ec2e7a768c0d522a9d3a3054fd67734f505336d78462a8c49';
const PROOF_POST = 'v1.1790000000.f8dbeb2da2be17c5b8ade18d88aee08a87ff57332a066e70f040a980127e7699';
const PROOF_NO_QUERY = 'v1.1790000000.1774c4eee32a51dda9e746050207c7197ba223c90cd71d77310a86bf3e0b54ad';

const realFetch = globalThis.fetch;

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown };
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  mock.timers.enable({ apis: ['Date'], now: 1790000000_000 });
  mock.method(globalThis, 'fetch', async (input: URL | string, init: RequestInit) => {
    sent.push({
      url: String(input),
      method: String(init.method),
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body,
    });
    return new Response(JSON.stringify({ id: ID }), { status: 200 });
  });
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

async function connect(
  getChannelSecret?: () => Promise<string | undefined>,
  credential = CREDENTIAL,
  onCredentialRefused?: (message: string, requestId: RequestId) => void,
) {
  const server = createEnrowServer(() => credential, getChannelSecret, onCredentialRefused);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const textOf = (result: unknown) => JSON.stringify(result);

test('without a channel secret the request is sent as before', async () => {
  const client = await connect();
  await client.callTool({ name: 'get_email_result', arguments: { id: ID } });
  await client.callTool({ name: 'find_email', arguments: { fullname: 'Ada Lovelace', company_domain: 'example.com' } });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].url, `https://api.enrow.io/email/find/single?id=${ID}`);
  assert.deepEqual(sent[0].headers, { 'x-api-key': CREDENTIAL, 'Content-Type': 'application/json' });
  assert.equal(sent[0].body, undefined);
  assert.deepEqual(sent[1].headers, { 'x-api-key': CREDENTIAL, 'Content-Type': 'application/json' });
  assert.equal(sent[1].body, JSON.stringify({ fullname: 'Ada Lovelace', company_domain: 'example.com' }));
});

test('a provider that resolves nothing sends no proof', async () => {
  const client = await connect(async () => undefined);
  await client.callTool({ name: 'get_account_info', arguments: {} });
  assert.deepEqual(sent[0].headers, { 'x-api-key': CREDENTIAL, 'Content-Type': 'application/json' });
});

test('a provider that rejects sends no proof and the request still goes', async () => {
  const client = await connect(async () => {
    throw new Error('unavailable');
  });
  const result = await client.callTool({ name: 'get_account_info', arguments: {} });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers['x-enrow-mcp-proof'], undefined);
  assert.notEqual(result.isError, true);
});

test('with a channel secret every request is signed', async () => {
  const client = await connect(async () => SECRET);
  await client.callTool({ name: 'get_email_result', arguments: { id: ID } });
  await client.callTool({ name: 'find_email', arguments: { fullname: 'Ada Lovelace', company_domain: 'example.com' } });
  await client.callTool({ name: 'get_account_info', arguments: {} });
  assert.deepEqual(
    sent.map((s) => [s.method, s.url, s.headers['x-enrow-mcp-proof']]),
    [
      ['GET', `https://api.enrow.io/email/find/single?id=${ID}`, PROOF_GET],
      ['POST', 'https://api.enrow.io/email/find/single', PROOF_POST],
      ['GET', 'https://api.enrow.io/account/info', PROOF_NO_QUERY],
    ],
  );
  for (const s of sent) assert.equal(s.headers['x-api-key'], CREDENTIAL);
});

test('the thirteen tools sign the method, path and query they send', async () => {
  const client = await connect(async () => SECRET);
  const person = { first_name: 'Ada', last_name: 'Lovelace', company_domain: 'example.com' };
  const calls: [string, Record<string, unknown>, string, string, string][] = [
    ['find_email', { fullname: 'Ada Lovelace', company_domain: 'example.com' }, 'POST', '/email/find/single', 'f8dbeb2da2be17c5b8ade18d88aee08a87ff57332a066e70f040a980127e7699'],
    ['get_email_result', { id: ID }, 'GET', `/email/find/single?id=${ID}`, 'a713ab39de3d869ec2e7a768c0d522a9d3a3054fd67734f505336d78462a8c49'],
    ['find_emails_bulk', { searches: [{ fullname: 'Ada Lovelace', company_domain: 'example.com' }] }, 'POST', '/email/find/bulk', 'd0fa93c5a2ce35205090110ad2130bc00a41072151095e2909f7159170f553a3'],
    ['get_emails_bulk_result', { id: ID }, 'GET', `/email/find/bulk?id=${ID}`, '27313bead9eae0227ee7d0e321fc3325af52f3a5f4ddcee061e8afc0d258aa6b'],
    ['verify_email', { email: 'ada@example.com' }, 'POST', '/email/verify/single', 'bc2e42b12f7a4f4c88c23979bd1fe5c38445ce9edc361b1e27a024b38084934a'],
    ['get_verification_result', { id: ID }, 'GET', `/email/verify/single?id=${ID}`, '6760541461b02e05276ebc6516cf58ab00dcd4f55980c9fe380cff43a57b57f7'],
    ['verify_emails_bulk', { emails: ['ada@example.com'] }, 'POST', '/email/verify/bulk', '438af240b9aba69f39112103a5cf739dddd5f8c8159385f0cfbfc1ead01426c1'],
    ['get_verifications_bulk_result', { id: ID }, 'GET', `/email/verify/bulk?id=${ID}`, '4417f5eaca5b87d454f9801345d0fd9e148040904c4e6487eba99bb0e0c763c9'],
    ['find_phone', person, 'POST', '/phone/single', '1fac18c59d644a7cdbf3f055992cd8001f983956c136d14d937ac69a59c692c3'],
    ['get_phone_result', { id: ID }, 'GET', `/phone/single?id=${ID}`, '687248179c311399d7a0d0a9b7c7618cd64eb0127b407ee9f16039c8f8261faf'],
    ['find_phones_bulk', { searches: [person] }, 'POST', '/phone/bulk', 'a23a04f48d651b9fb507f6aa235a40b12d3dac0d8a3ac78c6f40979b47931ed1'],
    ['get_phones_bulk_result', { id: ID }, 'GET', `/phone/bulk?id=${ID}`, '68bdaac70576ba6293f992f30dbd2d175f52675a27d829f1a816220b1c079434'],
    ['get_account_info', {}, 'GET', '/account/info', '1774c4eee32a51dda9e746050207c7197ba223c90cd71d77310a86bf3e0b54ad'],
  ];
  for (const [name, args] of calls) await client.callTool({ name, arguments: args });
  assert.deepEqual(
    sent.map((s) => [s.method, s.url, s.headers['x-enrow-mcp-proof']]),
    calls.map(([, , method, route, signature]) => [method, `https://api.enrow.io${route}`, `v1.1790000000.${signature}`]),
  );
});

test('an upper-case id is sent and signed as given', async () => {
  const client = await connect(async () => SECRET);
  await client.callTool({ name: 'get_email_result', arguments: { id: ID.toUpperCase() } });
  assert.equal(sent[0].url, `https://api.enrow.io/email/find/single?id=${ID.toUpperCase()}`);
  assert.equal(sent[0].headers['x-enrow-mcp-proof'], 'v1.1790000000.35197822d1a369428a8b17999d7731cf80a100039099e43fda6c46542dad00de');
});

test('the credential is signed as it goes on the wire, without surrounding whitespace', async () => {
  const seen: IncomingHttpHeaders[] = [];
  const recorder = createServer((req, res) => {
    seen.push(req.headers);
    res.end('{}');
  });
  await new Promise<void>((resolve) => recorder.listen(0, '127.0.0.1', resolve));
  const { port } = recorder.address() as AddressInfo;
  mock.method(globalThis, 'fetch', (input: URL, init: RequestInit) =>
    realFetch(`http://127.0.0.1:${port}${input.pathname}${input.search}`, init),
  );
  try {
    for (const credential of [CREDENTIAL, ` ${CREDENTIAL} `, `${CREDENTIAL}\t`, `${CREDENTIAL}\n`]) {
      const client = await connect(async () => SECRET, credential);
      await client.callTool({ name: 'get_account_info', arguments: {} });
    }
  } finally {
    recorder.closeAllConnections();
    recorder.close();
  }
  assert.deepEqual(
    seen.map((headers) => [headers['x-api-key'], headers['x-enrow-mcp-proof']]),
    Array(4).fill([CREDENTIAL, PROOF_NO_QUERY]),
  );
});

test('the timestamp is taken after the secret is resolved', async () => {
  const client = await connect(async () => {
    mock.timers.setTime(1790000061_000);
    return SECRET;
  });
  await client.callTool({ name: 'get_email_result', arguments: { id: ID } });
  assert.equal(sent[0].headers['x-enrow-mcp-proof'], 'v1.1790000061.c81b6e14fe7c0d0261208a7873bc7ee58c77e3452b3a9be657cb1a9c8e4bab8e');
});

test('the six read tools refuse an id that is not a UUID, before any request', async () => {
  const client = await connect(async () => SECRET);
  const tools = ['get_email_result', 'get_emails_bulk_result', 'get_verification_result', 'get_verifications_bulk_result', 'get_phone_result', 'get_phones_bulk_result'];
  for (const name of tools) {
    for (const id of ['a/b c=d&e', "o'neil", '', ` ${ID}`, `${ID}\n`, ID.replaceAll('-', '')]) {
      const result = await client.callTool({ name, arguments: { id } }).catch((err: unknown) => ({ isError: true, thrown: String(err) }));
      assert.equal(result.isError, true, `${name} ${JSON.stringify(id)}`);
    }
  }
  assert.equal(sent.length, 0);
});

test('the six read tools send the id as given', async () => {
  const client = await connect(async () => SECRET);
  const routes = {
    get_email_result: '/email/find/single',
    get_emails_bulk_result: '/email/find/bulk',
    get_verification_result: '/email/verify/single',
    get_verifications_bulk_result: '/email/verify/bulk',
    get_phone_result: '/phone/single',
    get_phones_bulk_result: '/phone/bulk',
  };
  for (const name of Object.keys(routes)) await client.callTool({ name, arguments: { id: ID } });
  assert.deepEqual(sent.map((s) => s.url), Object.values(routes).map((route) => `https://api.enrow.io${route}?id=${ID}`));
});

test('no tool result holds the credential, the secret or the proof', async () => {
  const client = await connect(async () => SECRET);
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ message: 'refused' }), { status: 401 }));
  const refused = await client.callTool({ name: 'get_email_result', arguments: { id: ID } });
  mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch failed');
  });
  const failed = await client.callTool({ name: 'get_account_info', arguments: {} });
  for (const result of [refused, failed]) {
    assert.equal(result.isError, true);
    for (const value of [CREDENTIAL, SECRET, PROOF_GET, PROOF_NO_QUERY, 'x-enrow-mcp-proof']) {
      assert.ok(!textOf(result).includes(value));
    }
  }
});

// What the Enrow API answers from now on, as a JSON body or as raw text.
function answer(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  mock.method(globalThis, 'fetch', async () => new Response(text, { status }));
}

const CREDENTIAL_REFUSED = { message: 'refused', reason: 'credential_refused' };

test('a plugin token that the Enrow API refuses itself reaches the refusal hook, with the text of the tool error and the id of the request', async () => {
  const refused = mock.fn((_message: string, _requestId: RequestId) => {});
  const client = await connect(undefined, PLUGIN_TOKEN, refused);
  answer(401, CREDENTIAL_REFUSED);
  const result = await client.callTool({ name: 'get_account_info', arguments: {} });
  assert.deepEqual(result, { content: [{ type: 'text', text: 'Error 401: refused' }], isError: true });
  // The client sent its initialize request as id 0, then this call as id 1.
  assert.deepEqual(refused.mock.calls.map((call) => call.arguments), [['Error 401: refused', 1]]);
});

test('the prefix is read from the credential as it goes on the wire, without surrounding whitespace', async () => {
  const refused = mock.fn((_message: string, _requestId: RequestId) => {});
  for (const credential of [` ${PLUGIN_TOKEN} `, `${PLUGIN_TOKEN}\t`, `\t${PLUGIN_TOKEN}\n`]) {
    const client = await connect(undefined, credential, refused);
    answer(401, CREDENTIAL_REFUSED);
    await client.callTool({ name: 'get_account_info', arguments: {} });
  }
  assert.equal(refused.mock.callCount(), 3);
});

test('no other answer reaches the refusal hook', async () => {
  const refused = mock.fn((_message: string, _requestId: RequestId) => {});
  const plugin = await connect(undefined, PLUGIN_TOKEN, refused);
  // The proof was refused, not the token: a new sign-in would not help.
  answer(401, { message: 'refused', reason: 'channel_refused' });
  await plugin.callTool({ name: 'get_account_info', arguments: {} });
  // A 401 without that exact reason: as the Enrow API answered before it gave
  // one, a body that is not JSON or not an object, another spelling.
  for (const body of [{ message: 'refused' }, 'Unauthorized', '', '"credential_refused"', { reason: 'Credential_Refused' }]) {
    answer(401, body);
    await plugin.callTool({ name: 'get_account_info', arguments: {} });
  }
  for (const status of [200, 202, 400, 402, 403, 404, 429, 500, 503]) {
    answer(status, CREDENTIAL_REFUSED);
    await plugin.callTool({ name: 'get_account_info', arguments: {} });
  }
  // An API key never asks for a sign-in, whatever the reason.
  const apiKey = await connect(undefined, CREDENTIAL, refused);
  answer(401, CREDENTIAL_REFUSED);
  await apiKey.callTool({ name: 'get_account_info', arguments: {} });
  answer(401, { message: 'This account is not allowed to use the phone search feature' });
  await apiKey.callTool({ name: 'find_phone', arguments: { linkedin_url: 'https://www.linkedin.com/in/ada' } });
  mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch failed');
  });
  await plugin.callTool({ name: 'get_account_info', arguments: {} });
  assert.equal(refused.mock.callCount(), 0);
});

test('without a refusal hook, as over stdio, a refused plugin token stays a tool error', async () => {
  const client = await connect(undefined, PLUGIN_TOKEN);
  answer(401, CREDENTIAL_REFUSED);
  const result = await client.callTool({ name: 'get_account_info', arguments: {} });
  assert.deepEqual(result, { content: [{ type: 'text', text: 'Error 401: refused' }], isError: true });
});
