import { decryptSecret, encryptSecret, isSecretStale } from './secret-crypto.js';

const PREFIX = 'route:';
const USER_ID = /^[UW][A-Z0-9]{2,31}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{2,31}$/;

export function isUserId(id) {
  return typeof id === 'string' && USER_ID.test(id);
}

export function isChannelId(id) {
  return typeof id === 'string' && CHANNEL_ID.test(id);
}

async function hydrateEntry(entry, crypto, { migrate = false, kv, userId } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const out = { ...entry };
  let plain = null;
  if (typeof out.secret_or_bearer === 'string' && out.secret_or_bearer !== '') {
    plain = out.secret_or_bearer;
    delete out.secret_or_bearer;
    if (crypto && migrate && kv && userId) {
      out.secret_enc = await encryptSecret(crypto, plain);
      if (typeof out.secret_verified_at !== 'number') out.secret_verified_at = Date.now();
      const stored = { ...out };
      delete stored.secret_or_bearer;
      await kv.put(PREFIX + userId, JSON.stringify(stored));
    }
  } else if (out.secret_enc && crypto) {
    try {
      plain = await decryptSecret(crypto, out.secret_enc);
    } catch {
      return null;
    }
  }
  if (plain !== null) out.secret_or_bearer = plain;
  return out;
}

async function sealEntry(entry, crypto, nowMs) {
  const out = { ...entry };
  if (typeof out.secret_or_bearer === 'string' && out.secret_or_bearer !== '' && crypto) {
    out.secret_enc = await encryptSecret(crypto, out.secret_or_bearer);
    delete out.secret_or_bearer;
    if (typeof out.secret_verified_at !== 'number') out.secret_verified_at = nowMs;
  }
  return out;
}

export function kvRouting(kv, crypto = null) {
  return {
    async get(userId) {
      if (!isUserId(userId)) return null;
      const raw = await kv.get(PREFIX + userId);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        return await hydrateEntry(parsed, crypto, { migrate: true, kv, userId });
      } catch {
        return null;
      }
    },
    async put(userId, entry) {
      const nowMs = Date.now();
      const sealed = await sealEntry(entry, crypto, nowMs);
      if (crypto && typeof sealed.secret_or_bearer === 'string') {
        sealed.secret_enc = await encryptSecret(crypto, sealed.secret_or_bearer);
        delete sealed.secret_or_bearer;
      }
      if (typeof sealed.secret_verified_at !== 'number' && sealed.secret_enc) {
        sealed.secret_verified_at = nowMs;
      }
      await kv.put(PREFIX + userId, JSON.stringify(sealed));
    },
    async delete(userId) {
      await kv.delete(PREFIX + userId);
    },
    async listUpTo(n) {
      const res = await kv.list({ prefix: PREFIX, limit: n });
      return res.keys.map((k) => k.name.slice(PREFIX.length));
    },
    async listIds() {
      const ids = [];
      let cursor;
      for (let i = 0; i < 100; i++) {
        const res = await kv.list({ prefix: PREFIX, cursor });
        for (const k of res.keys) ids.push(k.name.slice(PREFIX.length));
        if (res.list_complete) break;
        cursor = res.cursor;
      }
      return ids;
    },
    isSecretStale(entry, nowMs) {
      return isSecretStale(entry, nowMs);
    }
  };
}
