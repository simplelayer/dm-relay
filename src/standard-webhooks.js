import { b64decode, b64encode, concatBytes, hmacSha256, randomBase64Url, utf8 } from './util.js';

const PREFIX = 'whsec_';

export function parseSecret(secret) {
  if (typeof secret !== 'string' || !secret.startsWith(PREFIX)) throw new Error('E_SECRET_PREFIX');
  const key = b64decode(secret.slice(PREFIX.length));
  if (key.length === 0) throw new Error('E_SECRET_EMPTY');
  return key;
}

export function isValidSecret(secret) {
  try {
    parseSecret(secret);
    return true;
  } catch {
    return false;
  }
}

export async function sign({ secret, id, timestamp, bodyBytes }) {
  const key = parseSecret(secret);
  const signed = concatBytes(utf8(`${id}.${timestamp}.`), bodyBytes);
  return `v1,${b64encode(await hmacSha256(key, signed))}`;
}

export async function buildHeaders({ secret, id, timestampSeconds, bodyBytes }) {
  const timestamp = String(Math.floor(timestampSeconds));
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': timestamp,
    'webhook-signature': await sign({ secret, id, timestamp, bodyBytes })
  };
}

export function randomMessageId() {
  return `msg_${randomBase64Url(18)}`;
}
