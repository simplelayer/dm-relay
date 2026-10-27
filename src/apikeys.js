import { randomBase64Url, toHex, utf8 } from './util.js';

export const KEY_PATTERN = /^dmr_[A-Za-z0-9_-]{43}$/;

export function newKeyMaterial() {
  return { key: `dmr_${randomBase64Url(32)}`, kid: randomBase64Url(9) };
}

export async function hashKey(key) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(key))));
}
