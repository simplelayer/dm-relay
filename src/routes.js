import { decryptSecret, encryptSecret, isSecretStale } from './secret-crypto.js';

const PREFIX = 'route:';
export const ROUTE_SWEEP_REPORT_KEY = 'meta:route_sweep_report';
const USER_ID = /^[UW][A-Z0-9]{2,31}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{2,31}$/;

export class RouteCryptoRequiredError extends Error {
  constructor() {
    super('E_ROUTE_CRYPTO');
    this.name = 'RouteCryptoRequiredError';
  }
}

export function isUserId(id) {
  return typeof id === 'string' && USER_ID.test(id);
}

export function isChannelId(id) {
  return typeof id === 'string' && CHANNEL_ID.test(id);
}

function assertCanSeal(crypto) {
  if (!crypto) throw new RouteCryptoRequiredError();
}

async function hydrateEntry(entry, crypto, { migrate = false, kv, userId } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const out = { ...entry };
  let plain = null;
  if (typeof out.secret_or_bearer === 'string' && out.secret_or_bearer !== '') {
    if (!crypto) return null;
    plain = out.secret_or_bearer;
    delete out.secret_or_bearer;
    if (migrate && kv && userId) {
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
  } else if (out.secret_enc && !crypto) {
    return null;
  }
  if (plain !== null) out.secret_or_bearer = plain;
  return out;
}

async function sealEntry(entry, crypto, nowMs) {
  const out = { ...entry };
  if (typeof out.secret_or_bearer === 'string' && out.secret_or_bearer !== '') {
    assertCanSeal(crypto);
    out.secret_enc = await encryptSecret(crypto, out.secret_or_bearer);
    delete out.secret_or_bearer;
    if (typeof out.secret_verified_at !== 'number') out.secret_verified_at = nowMs;
  }
  return out;
}

function parseRouteRaw(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function routeEntryHasPlaintextSecret(parsed) {
  return Boolean(parsed && typeof parsed === 'object' && typeof parsed.secret_or_bearer === 'string' && parsed.secret_or_bearer !== '');
}

export async function auditPlaintextRouteEntries(kv) {
  let total = 0;
  let sealed = 0;
  let plaintext_remaining = 0;
  let cursor;
  for (let i = 0; i < 100; i++) {
    const res = await kv.list({ prefix: PREFIX, cursor });
    for (const k of res.keys) {
      total++;
      const raw = await kv.get(k.name);
      const parsed = parseRouteRaw(raw);
      if (parsed && parsed.secret_enc) sealed++;
      if (routeEntryHasPlaintextSecret(parsed)) plaintext_remaining++;
    }
    if (res.list_complete) break;
    cursor = res.cursor;
  }
  return { total, sealed, purged: 0, plaintext_remaining };
}

export async function sweepPlaintextRouteEntries(kv, crypto) {
  assertCanSeal(crypto);
  const routing = kvRouting(kv, crypto);
  const ids = await routing.listIds();
  let sealed = 0;
  let purged = 0;
  for (const userId of ids) {
    const raw = await kv.get(PREFIX + userId);
    const parsed = parseRouteRaw(raw);
    if (!routeEntryHasPlaintextSecret(parsed)) continue;
    try {
      const hydrated = await hydrateEntry(parsed, crypto, { migrate: false });
      if (!hydrated || typeof hydrated.secret_or_bearer !== 'string') {
        await kv.delete(PREFIX + userId);
        purged++;
        continue;
      }
      const stored = await sealEntry(hydrated, crypto, Date.now());
      delete stored.secret_or_bearer;
      await kv.put(PREFIX + userId, JSON.stringify(stored));
      sealed++;
    } catch {
      await kv.delete(PREFIX + userId);
      purged++;
    }
  }
  const audit = await auditPlaintextRouteEntries(kv);
  return { total: audit.total, sealed, purged, plaintext_remaining: audit.plaintext_remaining };
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
      if (typeof sealed.secret_or_bearer === 'string' && sealed.secret_or_bearer !== '') {
        throw new RouteCryptoRequiredError();
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
