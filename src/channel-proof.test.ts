import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeChannelProof } from './channel-proof.js';

// Reference values, computed with test secrets and test credentials only.
// Columns: name, secret, timestamp, method, path, query, credential, expected.
const vectors: [string, string, number, string, string, string, string, string][] = [
  ['P-route. POST /email/find/single, no query', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'POST', '/email/find/single', '', 'test-credential-0001', 'v1.1790000000.f8dbeb2da2be17c5b8ade18d88aee08a87ff57332a066e70f040a980127e7699'],
  ['P-route. GET /email/find/single with a UUID id', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'GET', '/email/find/single', 'id=3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f', 'test-credential-0001', 'v1.1790000000.a713ab39de3d869ec2e7a768c0d522a9d3a3054fd67734f505336d78462a8c49'],
  ['P-route. POST /email/find/bulk, no query', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'POST', '/email/find/bulk', '', 'test-credential-0001', 'v1.1790000000.d0fa93c5a2ce35205090110ad2130bc00a41072151095e2909f7159170f553a3'],
  ['P-route. GET /email/find/bulk with a UUID id', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'GET', '/email/find/bulk', 'id=3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f', 'test-credential-0001', 'v1.1790000000.27313bead9eae0227ee7d0e321fc3325af52f3a5f4ddcee061e8afc0d258aa6b'],
  ['P-route. POST /email/verify/single, no query', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'POST', '/email/verify/single', '', 'test-credential-0001', 'v1.1790000000.bc2e42b12f7a4f4c88c23979bd1fe5c38445ce9edc361b1e27a024b38084934a'],
  ['P-route. GET /email/verify/single with a UUID id', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'GET', '/email/verify/single', 'id=3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f', 'test-credential-0001', 'v1.1790000000.6760541461b02e05276ebc6516cf58ab00dcd4f55980c9fe380cff43a57b57f7'],
  ['P-route. POST /email/verify/bulk, no query', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'POST', '/email/verify/bulk', '', 'test-credential-0001', 'v1.1790000000.438af240b9aba69f39112103a5cf739dddd5f8c8159385f0cfbfc1ead01426c1'],
  ['P-route. GET /email/verify/bulk with a UUID id', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'GET', '/email/verify/bulk', 'id=3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f', 'test-credential-0001', 'v1.1790000000.4417f5eaca5b87d454f9801345d0fd9e148040904c4e6487eba99bb0e0c763c9'],
  ['P-route. POST /phone/single, no query', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'POST', '/phone/single', '', 'test-credential-0001', 'v1.1790000000.1fac18c59d644a7cdbf3f055992cd8001f983956c136d14d937ac69a59c692c3'],
  ['P-route. GET /phone/single with a UUID id', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'GET', '/phone/single', 'id=3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f', 'test-credential-0001', 'v1.1790000000.687248179c311399d7a0d0a9b7c7618cd64eb0127b407ee9f16039c8f8261faf'],
  ['P-route. POST /phone/bulk, no query', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'POST', '/phone/bulk', '', 'test-credential-0001', 'v1.1790000000.a23a04f48d651b9fb507f6aa235a40b12d3dac0d8a3ac78c6f40979b47931ed1'],
  ['P-route. GET /phone/bulk with a UUID id', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'GET', '/phone/bulk', 'id=3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f', 'test-credential-0001', 'v1.1790000000.68bdaac70576ba6293f992f30dbd2d175f52675a27d829f1a816220b1c079434'],
  ['P-route. GET /account/info, no query', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'GET', '/account/info', '', 'test-credential-0001', 'v1.1790000000.1774c4eee32a51dda9e746050207c7197ba223c90cd71d77310a86bf3e0b54ad'],
  ['P-encoded. id that needs percent-encoding, signed as sent', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'GET', '/email/find/single', 'id=a%2Fb%20c%3Dd%26e', 'test-credential-0001', 'v1.1790000000.31a4f55b0be6f108ad6bd4dc7469181c6735fc034540ce9c7d106d1fa379542e'],
  ['P-decoded. same id in decoded form: MUST differ from P-encoded', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'GET', '/email/find/single', 'id=a/b c=d&e', 'test-credential-0001', 'v1.1790000000.d2284bf1e78ebe6dddad7f88f92382a19bc4d4861427d38eaf5a244b09ba324d'],
  ['P-time. GET /email/find/single with a UUID id, second timestamp', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000061, 'GET', '/email/find/single', 'id=3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f', 'test-credential-0001', 'v1.1790000061.c81b6e14fe7c0d0261208a7873bc7ee58c77e3452b3a9be657cb1a9c8e4bab8e'],
  ['P-credential. GET /email/find/single with a UUID id, second credential', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'GET', '/email/find/single', 'id=3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f', '11111111-2222-4333-8444-555555555555', 'v1.1790000000.b2b341a0c9ff345c01e55348a7670e1e619147374d96155e221d3977b057be59'],
  ['P-secret. GET /email/find/single with a UUID id, second secret', 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210', 1790000000, 'GET', '/email/find/single', 'id=3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f', 'test-credential-0001', 'v1.1790000000.822c60a38049f4726e8255155c0b3e87c30e568835e67d22385f3e98a166198c'],
  ['P-text-secret. secret that is not hexadecimal, used as a UTF-8 string', 'test-only-channel-secret-with-dashes-and-UPPER-case-0042', 1790000061, 'POST', '/email/verify/bulk', '', '11111111-2222-4333-8444-555555555555', 'v1.1790000061.b9008d8aa17dfabd5544472289547062c414c7467fbbb39c1eaba4c846516dde'],
  ['P-lower. lower-case method: MUST equal the GET /email/find/single route vector', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'get', '/email/find/single', 'id=3f2b8c1e-5d4a-4c6b-9e7f-0a1b2c3d4e5f', 'test-credential-0001', 'v1.1790000000.a713ab39de3d869ec2e7a768c0d522a9d3a3054fd67734f505336d78462a8c49'],
  ['P-upper-id. upper-case UUID, signed as sent: MUST differ from the lower-case one', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 1790000000, 'GET', '/email/find/single', 'id=3F2B8C1E-5D4A-4C6B-9E7F-0A1B2C3D4E5F', 'test-credential-0001', 'v1.1790000000.35197822d1a369428a8b17999d7731cf80a100039099e43fda6c46542dad00de'],
];

for (const [name, secret, timestamp, method, path, query, credential, expected] of vectors) {
  test(`computeChannelProof: ${name}`, () => {
    assert.equal(computeChannelProof(secret, { credential, method, path, query }, timestamp), expected);
  });
}

const SECRET = vectors[0][1];
const request = { credential: 'test-credential-0001', method: 'GET', path: '/account/info', query: '' };

test('computeChannelProof: the value has the expected shape', () => {
  assert.match(computeChannelProof(SECRET, request, 1790000000), /^v1\.\d{10}\.[0-9a-f]{64}$/);
});

test('computeChannelProof: refuses a line break in the path or the query', () => {
  assert.throws(() => computeChannelProof(SECRET, { ...request, path: '/account/info\r' }, 1790000000));
  assert.throws(() => computeChannelProof(SECRET, { ...request, query: 'id=a\nb' }, 1790000000));
});

test('computeChannelProof: refuses a timestamp that is not 10-digit seconds', () => {
  assert.throws(() => computeChannelProof(SECRET, request, 1790000000_000));
  assert.throws(() => computeChannelProof(SECRET, request, 1790000000.5));
});
