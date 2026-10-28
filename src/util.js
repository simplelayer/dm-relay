const encoder = new TextEncoder();

export function utf8(s) {
  return encoder.encode(s);
}

export function concatBytes(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function b64encode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64decode(str) {
  const m = typeof str === 'string' ? /^([A-Za-z0-9+/]+)(={0,2})$/.exec(str) : null;
  if (!m || (m[2] !== '' && str.length % 4 !== 0) || m[1].length % 4 === 1) throw new Error('E_B64');
  const bin = atob(m[1] + '='.repeat((4 - (m[1].length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(bytes) {
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
  const pad = (4 - (str.length % 4)) % 4;
  return b64decode(str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad));
}

export async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

export function timingSafeEqual(a, b) {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  return timingSafeEqual(utf8(a), utf8(b));
}

export function randomBase64Url(nBytes) {
  const buf = new Uint8Array(nBytes);
  crypto.getRandomValues(buf);
  return b64urlEncode(buf);
}

export function isTimeoutError(err) {
  return Boolean(err) && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}
