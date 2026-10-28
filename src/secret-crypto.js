import { b64decode, b64urlDecode, b64urlEncode, utf8 } from './util.js';

export const SECRET_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const PLAINTEXT_MARKERS = ['secret_or_bearer', 'access_token'];

export function looksLikePlaintextSecret(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.startsWith('whsec_') || value.startsWith('crsr_')) return true;
  if (value.startsWith('xoxp-') || value.startsWith('xapp-')) return true;
  return false;
}

export function routeCryptoFromEnv(env) {
  const kid = String(env.ROUTE_SECRET_KEY_ID || '').trim();
  const raw = String(env.ROUTE_SECRET_ENCRYPTION_KEY || '').trim();
  if (!kid || !raw) return null;
  let keyBytes;
  try {
    keyBytes = b64urlDecode(raw);
  } catch {
    return null;
  }
  if (keyBytes.length !== 32) return null;
  return { kid, keyBytes };
}

async function importKey(keyBytes) {
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(cryptoCtx, plaintext) {
  if (!cryptoCtx || typeof plaintext !== 'string') throw new Error('E_CRYPTO');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(cryptoCtx.keyBytes);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, utf8(plaintext));
  return { kid: cryptoCtx.kid, iv: b64urlEncode(iv), ct: b64urlEncode(new Uint8Array(ct)) };
}

export async function decryptSecret(cryptoCtx, blob) {
  if (!cryptoCtx || !blob || typeof blob !== 'object') throw new Error('E_CRYPTO');
  if (blob.kid !== cryptoCtx.kid) throw new Error('E_CRYPTO_KID');
  const iv = b64urlDecode(blob.iv);
  const ct = b64urlDecode(blob.ct);
  const key = await importKey(cryptoCtx.keyBytes);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export function isSecretStale(entry, nowMs) {
  if (!entry || typeof entry !== 'object') return true;
  const at = entry.secret_verified_at;
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  return nowMs - at > SECRET_MAX_AGE_MS;
}

export function jsonHasPlaintextMarkers(raw) {
  if (typeof raw !== 'string') return false;
  for (const m of PLAINTEXT_MARKERS) {
    if (raw.includes(`"${m}"`)) return true;
  }
  return looksLikePlaintextSecret(raw);
}
