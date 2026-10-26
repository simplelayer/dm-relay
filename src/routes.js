const PREFIX = 'route:';
const USER_ID = /^[UW][A-Z0-9]{2,31}$/;

export function isUserId(id) {
  return typeof id === 'string' && USER_ID.test(id);
}

export function kvRouting(kv) {
  return {
    async get(userId) {
      if (!isUserId(userId)) return null;
      const raw = await kv.get(PREFIX + userId);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
    async put(userId, entry) {
      await kv.put(PREFIX + userId, JSON.stringify(entry));
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
    }
  };
}
