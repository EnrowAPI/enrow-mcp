/**
 * Channel secret for the hosted deployment, read from AWS SSM Parameter Store
 * at runtime and refreshed periodically, so a rotation needs no redeploy.
 * Only imported by the Lambda entry point: the AWS SDK comes from the Lambda
 * runtime and is loaded on first use.
 */

import type { ChannelSecretProvider } from './channel-proof.js';

const REFRESH_MS = 60_000;
const RETRY_MS = 5_000;
const READ_TIMEOUT_MS = 2_000;
const MIN_LENGTH = 32;

type ReadParameter = (name: string) => Promise<string | undefined>;

let client: import('@aws-sdk/client-ssm').SSMClient | undefined;

async function readFromSsm(name: string): Promise<string | undefined> {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  client ??= new SSMClient({});
  const { Parameter } = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  return Parameter?.Value;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Never rejects. Without a parameter name nothing is read and nothing is
 * signed. A failed refresh keeps the last value read and is retried later.
 */
export function createChannelSecretProvider(
  parameterName: string | undefined,
  read: ReadParameter = readFromSsm,
  now: () => number = Date.now,
): ChannelSecretProvider {
  if (!parameterName) return async () => undefined;

  let secret: string | undefined;
  let nextReadAt = 0;
  let pending: Promise<void> | undefined;

  async function refresh(name: string): Promise<void> {
    try {
      const value = (await withTimeout(read(name), READ_TIMEOUT_MS))?.trim();
      if (!value || value.length < MIN_LENGTH) throw Object.assign(new Error('unusable'), { name: 'UnusableValue' });
      // Says that a value is in use, never the value itself.
      if (value !== secret) console.log(secret === undefined ? 'Channel secret loaded' : 'Channel secret changed');
      secret = value;
      nextReadAt = now() + REFRESH_MS;
    } catch (err) {
      nextReadAt = now() + RETRY_MS;
      // Name and code only: a message could quote a value.
      const code = (err as { code?: unknown } | undefined)?.code;
      console.error('Channel secret read failed:', err instanceof Error ? err.name : 'Error', typeof code === 'string' ? code : '');
    }
  }

  return async () => {
    if (now() >= nextReadAt) {
      pending ??= refresh(parameterName).finally(() => {
        pending = undefined;
      });
      await pending;
    }
    return secret;
  };
}
