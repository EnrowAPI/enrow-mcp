import { createHash, createHmac } from 'node:crypto';

export const CHANNEL_PROOF_HEADER = 'x-enrow-mcp-proof';

/** Resolves the channel secret, or nothing when none is configured. */
export type ChannelSecretProvider = () => Promise<string | undefined>;

/**
 * Header value that signs one upstream request with the channel secret:
 * `v1.<unix seconds>.<hex HMAC-SHA256>`. The signed string is six fields
 * joined by a line feed: version, timestamp, method, path, query (as sent,
 * without the `?`) and the hex SHA-256 of the credential.
 */
export function computeChannelProof(
  secret: string,
  request: { credential: string; method: string; path: string; query: string },
  timestampSeconds: number,
): string {
  // A line break would shift the fields of the signed string.
  if (/[\n\r]/.test(request.path) || /[\n\r]/.test(request.query)) {
    throw new Error('Channel proof: line break in the path or the query');
  }
  if (!Number.isInteger(timestampSeconds) || !/^\d{10}$/.test(String(timestampSeconds))) {
    throw new Error('Channel proof: the timestamp must be a 10-digit integer');
  }
  const timestamp = String(timestampSeconds);
  const signed = [
    'v1',
    timestamp,
    request.method.toUpperCase(),
    request.path,
    request.query,
    createHash('sha256').update(request.credential, 'utf8').digest('hex'),
  ].join('\n');
  return `v1.${timestamp}.${createHmac('sha256', secret).update(signed, 'utf8').digest('hex')}`;
}
