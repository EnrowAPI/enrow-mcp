import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createChannelSecretProvider } from './channel-secret.js';

const VALUE_1 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const VALUE_2 = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

let logged: unknown[][] = [];
beforeEach(() => {
  logged = [];
  for (const method of ['error', 'log'] as const) {
    mock.method(console, method, (...args: unknown[]) => {
      logged.push(args);
    });
  }
});
afterEach(() => mock.restoreAll());

test('without a parameter name nothing is read', async () => {
  const read = mock.fn(async () => VALUE_1);
  assert.equal(await createChannelSecretProvider(undefined, read)(), undefined);
  assert.equal(await createChannelSecretProvider('', read)(), undefined);
  assert.equal(read.mock.callCount(), 0);
});

test('reads once, trims, and serves the value until the refresh is due', async () => {
  let clock = 1_000_000;
  const read = mock.fn(async () => `  ${VALUE_1}\n`);
  const get = createChannelSecretProvider('/test/name', read, () => clock);
  assert.equal(await get(), VALUE_1);
  clock += 59_999;
  assert.equal(await get(), VALUE_1);
  assert.equal(read.mock.callCount(), 1);
  assert.deepEqual(read.mock.calls[0].arguments, ['/test/name']);
});

test('picks up a new value after the refresh period', async () => {
  let clock = 1_000_000;
  let value = VALUE_1;
  const get = createChannelSecretProvider('/test/name', async () => value, () => clock);
  assert.equal(await get(), VALUE_1);
  value = VALUE_2;
  clock += 60_000;
  assert.equal(await get(), VALUE_2);
});

test('a failed first read gives nothing and is retried 5 s later, not before', async () => {
  let clock = 1_000_000;
  let fail = true;
  const read = mock.fn(async () => {
    if (fail) throw Object.assign(new Error(`denied ${VALUE_1}`), { name: 'AccessDeniedException' });
    return VALUE_1;
  });
  const get = createChannelSecretProvider('/test/name', read, () => clock);
  assert.equal(await get(), undefined);
  clock += 4_999;
  assert.equal(await get(), undefined);
  assert.equal(read.mock.callCount(), 1);
  fail = false;
  clock += 1;
  assert.equal(await get(), VALUE_1);
  assert.equal(read.mock.callCount(), 2);
});

test('a failed refresh keeps the last value', async () => {
  let clock = 1_000_000;
  let fail = false;
  const get = createChannelSecretProvider('/test/name', async () => {
    if (fail) throw new Error('unavailable');
    return VALUE_1;
  }, () => clock);
  assert.equal(await get(), VALUE_1);
  fail = true;
  clock += 60_000;
  assert.equal(await get(), VALUE_1);
});

test('says once that a value is loaded, and again only when it changes', async () => {
  let clock = 1_000_000;
  let value = VALUE_1;
  const get = createChannelSecretProvider('/test/name', async () => value, () => clock);
  await get();
  clock += 60_000;
  await get();
  value = VALUE_2;
  clock += 60_000;
  await get();
  assert.deepEqual(logged, [['Channel secret loaded'], ['Channel secret changed']]);
});

test('a read that hangs is abandoned and nothing is served', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const get = createChannelSecretProvider('/test/name', () => new Promise(() => {}), () => 1_000_000);
  const result = get();
  mock.timers.tick(2_000);
  assert.equal(await result, undefined);
  mock.timers.reset();
  assert.deepEqual(logged, [['Channel secret read failed:', 'TimeoutError', '']]);
});

test('a value shorter than 32 characters is not used', async () => {
  const get = createChannelSecretProvider('/test/name', async () => 'x'.repeat(31), () => 1_000_000);
  assert.equal(await get(), undefined);
});

test('concurrent calls share one read', async () => {
  const read = mock.fn(async () => VALUE_1);
  const get = createChannelSecretProvider('/test/name', read, () => 1_000_000);
  assert.deepEqual(await Promise.all([get(), get(), get()]), [VALUE_1, VALUE_1, VALUE_1]);
  assert.equal(read.mock.callCount(), 1);
});

test('never logs a value', async () => {
  let fail = true;
  let clock = 1_000_000;
  const get = createChannelSecretProvider('/test/name', async () => {
    if (fail) throw Object.assign(new Error(`denied ${VALUE_1}`), { name: 'AccessDeniedException' });
    return VALUE_2;
  }, () => clock);
  await get();
  fail = false;
  clock += 5_000;
  await get();
  assert.deepEqual(logged.map((args) => args[0]), ['Channel secret read failed:', 'Channel secret loaded']);
  assert.ok(!JSON.stringify(logged).includes(VALUE_1));
  assert.ok(!JSON.stringify(logged).includes(VALUE_2));
});
