import { HOUR_MS } from './constants.js';

export const EVENT_DEDUPE_TTL_MS = HOUR_MS;

export class EventDedupeCore {
  constructor({ storage, now }) {
    this.s = storage;
    this.now = now;
  }

  claim({ eventId, nowMs }) {
    if (typeof eventId !== 'string' || eventId === '') throw new Error('E_DEDUPE');
    const now = typeof nowMs === 'number' ? nowMs : this.now();
    const expires = now + EVENT_DEDUPE_TTL_MS;
    const seen = this.s.get('seen') || {};
    if (seen[eventId] && seen[eventId] > now) return { duplicate: true };
    const next = { ...seen, [eventId]: expires };
    const pruned = {};
    for (const [id, exp] of Object.entries(next)) {
      if (exp > now) pruned[id] = exp;
    }
    this.s.put('seen', pruned);
    return { duplicate: false };
  }
}

function syncStorage(storage) {
  return {
    get: (k) => storage.kv.get(k),
    put: (k, v) => storage.kv.put(k, v)
  };
}

export class EventDedupeDO {
  constructor(ctx) {
    this.core = new EventDedupeCore({ storage: syncStorage(ctx.storage), now: () => Date.now() });
  }

  async fetch(request) {
    let args = {};
    try {
      args = await request.json();
    } catch {
      args = {};
    }
    try {
      return Response.json(this.core.claim(args));
    } catch {
      return new Response('{"error":"E_DEDUPE"}', { status: 400, headers: { 'content-type': 'application/json' } });
    }
  }
}

export function makeEventDedupeClient(namespace, { allowInMemoryFallback = false } = {}) {
  if (!namespace) {
    if (allowInMemoryFallback !== true) {
      return {
        async claim() {
          throw new Error('E_DEDUPE_UNCONFIGURED');
        }
      };
    }
    const mem = new Map();
    return {
      async claim(eventId, nowMs) {
        const exp = mem.get(eventId);
        if (exp && exp > nowMs) return { duplicate: true };
        mem.set(eventId, nowMs + EVENT_DEDUPE_TTL_MS);
        return { duplicate: false };
      }
    };
  }
  const stub = namespace.get(namespace.idFromName('global'));
  return {
    async claim(eventId, nowMs) {
      const res = await stub.fetch('https://dedupe/claim', {
        method: 'POST',
        body: JSON.stringify({ eventId, nowMs })
      });
      if (!res.ok) throw new Error('E_DEDUPE_CALL');
      return res.json();
    }
  };
}
