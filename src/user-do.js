import {
  API_KEY_LABEL_MAX,
  API_KEY_MAX,
  API_RATE,
  CHANGE_FIELDS,
  CHANGE_LOG_MAX,
  COUNTER_NAMES,
  DELIVERY_LOG_MAX,
  FILTER_COUNTER_NAMES,
  HOUR_MS,
  LIMITS,
  REQUEST_MAX_KEPT,
  REQUEST_MAX_PENDING,
  REQUEST_TTL_MS,
  REQUEST_TYPES,
  NUDGE_INTERVAL_MS,
  NUDGE_RETRY_DELAY_MS,
  REGISTRATION_LIMIT,
  REGISTRATION_WINDOW_MS,
  STATS_HOURS
} from './constants.js';
import { outcomeLabel, sanitizeDelivery } from './delivery-log.js';
import { fireNudge, isDefiniteFailure } from './destinations.js';
import { kvRouting } from './routes.js';
import { parseOwnHosts } from './ssrf.js';

const METHODS = new Set([
  'check',
  'increment',
  'noteActivity',
  'markDisconnected',
  'markConnected',
  'markConnecting',
  'consumeRegistration',
  'consumeLimit',
  'recordDelivery',
  'recordFiltered',
  'addKey',
  'listKeys',
  'keyHashes',
  'revokeKey',
  'consumeApiKey',
  'logChange',
  'reqCreate',
  'reqList',
  'reqGet',
  'reqResolve',
  'status',
  'wipe'
]);

export class UserDOCore {
  constructor({ storage, now, setAlarm, deleteAlarm, fire }) {
    this.s = storage;
    this.now = now;
    this.setAlarm = setAlarm;
    this.deleteAlarm = deleteAlarm;
    this.fire = fire;
  }

  async call(method, args) {
    if (!METHODS.has(method)) throw new Error('E_DO_METHOD');
    return this[method](args || {});
  }

  check() {
    return { disconnected: this.s.get('disconnected') === true };
  }

  increment({ name }) {
    if (!COUNTER_NAMES.includes(name) && !FILTER_COUNTER_NAMES.includes(name)) throw new Error('E_DO_COUNTER');
    this.#inc(name);
    return { ok: true };
  }

  #inc(name) {
    this.s.put(`c:${name}`, (this.s.get(`c:${name}`) || 0) + 1);
  }

  #bump(slot) {
    const hour = Math.floor(this.now() / HOUR_MS);
    const buckets = {};
    for (const [k, v] of Object.entries(this.s.get('hb') || {})) {
      if (Number(k) > hour - STATS_HOURS) buckets[k] = v;
    }
    const b = buckets[hour] ? [...buckets[hour]] : [0, 0, 0];
    b[slot] += 1;
    buckets[hour] = b;
    this.s.put('hb', buckets);
  }

  #last24h() {
    const hour = Math.floor(this.now() / HOUR_MS);
    const out = { delivered: 0, filtered: 0, failed: 0 };
    for (const [k, v] of Object.entries(this.s.get('hb') || {})) {
      if (Number(k) <= hour - STATS_HOURS) continue;
      out.delivered += v[0];
      out.filtered += v[1];
      out.failed += v[2];
    }
    return out;
  }

  #logDelivery(entry) {
    const log = [entry, ...(this.s.get('dlog') || [])].slice(0, DELIVERY_LOG_MAX);
    this.s.put('dlog', log);
  }

  recordDelivery({ dest, outcome, test }) {
    const entry = sanitizeDelivery({ dest, outcome, test }, this.now());
    if (entry === null) throw new Error('E_DO_DELIVERY');
    this.#logDelivery(entry);
    if (!entry.test) this.#bump(entry.o === 'ok' ? 0 : 2);
    return { ok: true };
  }

  recordFiltered({ reason }) {
    const name = `filtered_${reason}`;
    if (!FILTER_COUNTER_NAMES.includes(name)) throw new Error('E_DO_COUNTER');
    this.#inc(name);
    this.#bump(1);
    return { ok: true };
  }

  consumeLimit({ name }) {
    const cfg = LIMITS[name];
    if (!cfg) throw new Error('E_DO_LIMIT');
    const now = this.now();
    const key = `lim:${name}`;
    let [start, count] = this.s.get(key) || [null, 0];
    if (start == null || now - start >= cfg.windowMs) {
      start = now;
      count = 0;
    }
    if (count >= cfg.limit) return { allowed: false };
    this.s.put(key, [start, count + 1]);
    return { allowed: true };
  }

  addKey({ kid, hash, label }) {
    if (typeof kid !== 'string' || !/^[A-Za-z0-9_-]{8,32}$/.test(kid)) throw new Error('E_DO_KEY');
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error('E_DO_KEY');
    if (typeof label !== 'string' || [...label].length > API_KEY_LABEL_MAX) throw new Error('E_DO_KEY');
    const keys = this.s.get('keys') || [];
    if (keys.length >= API_KEY_MAX) return { ok: false, error: 'max_keys' };
    this.s.put('keys', [...keys, { kid, hash, label, created: this.now(), last_used: null }]);
    return { ok: true };
  }

  listKeys() {
    return { keys: (this.s.get('keys') || []).map(({ kid, label, created, last_used }) => ({ kid, label, created, last_used })) };
  }

  keyHashes() {
    return { hashes: (this.s.get('keys') || []).map((k) => k.hash) };
  }

  revokeKey({ kid }) {
    const keys = this.s.get('keys') || [];
    const found = keys.find((k) => k.kid === kid);
    if (!found) return { ok: false };
    this.s.put('keys', keys.filter((k) => k.kid !== kid));
    this.s.delete(`lim:k:${kid}`);
    return { ok: true, hash: found.hash };
  }

  consumeApiKey({ kid, hash }) {
    const keys = this.s.get('keys') || [];
    const idx = keys.findIndex((k) => k.kid === kid && k.hash === hash);
    if (idx < 0) return { exists: false, allowed: false };
    const now = this.now();
    const key = `lim:k:${kid}`;
    let [start, count] = this.s.get(key) || [null, 0];
    if (start == null || now - start >= API_RATE.windowMs) {
      start = now;
      count = 0;
    }
    if (count >= API_RATE.limit) return { exists: true, allowed: false };
    this.s.put(key, [start, count + 1]);
    this.s.put('keys', keys.map((k, i) => (i === idx ? { ...k, last_used: now } : k)));
    return { exists: true, allowed: true };
  }

  logChange({ via, fields }) {
    if (via !== 'browser' && via !== 'api' && via !== 'approval') throw new Error('E_DO_CHANGE');
    if (!Array.isArray(fields) || fields.length === 0 || !fields.every((f) => CHANGE_FIELDS.includes(f))) throw new Error('E_DO_CHANGE');
    this.s.put('clog', [{ t: this.now(), via, fields: [...new Set(fields)] }, ...(this.s.get('clog') || [])].slice(0, CHANGE_LOG_MAX));
    return { ok: true };
  }

  #reqs() {
    const now = this.now();
    const all = this.s.get('reqs') || [];
    let changed = false;
    const out = all.map((r) => {
      if (r.status === 'pending' && r.expires <= now) {
        changed = true;
        return { ...r, status: 'expired', payload: null };
      }
      return r;
    });
    if (changed) this.s.put('reqs', out);
    return out;
  }

  reqCreate({ id, type, summary, detail, payload }) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(id)) throw new Error('E_DO_REQ');
    if (!REQUEST_TYPES.includes(type) || typeof summary !== 'string' || summary.length > 300) throw new Error('E_DO_REQ');
    if (payload === null || typeof payload !== 'object' || detail === null || typeof detail !== 'object') throw new Error('E_DO_REQ');
    const all = this.#reqs();
    const pending = all.filter((r) => r.status === 'pending');
    const same = JSON.stringify(payload);
    const dup = pending.find((r) => r.type === type && JSON.stringify(r.payload) === same);
    if (dup) return { ok: true, duplicate: true, id: dup.id, type: dup.type, status: 'pending', expires: dup.expires };
    if (pending.length >= REQUEST_MAX_PENDING) return { ok: false, error: 'max_pending' };
    const now = this.now();
    const rec = { id, type, status: 'pending', created: now, expires: now + REQUEST_TTL_MS, summary, detail, payload };
    this.s.put('reqs', [rec, ...all].slice(0, REQUEST_MAX_KEPT));
    return { ok: true, duplicate: false, id, type, status: 'pending', expires: rec.expires };
  }

  reqList() {
    return { requests: this.#reqs().map(({ payload, ...meta }) => meta) };
  }

  reqGet({ id }) {
    return { request: this.#reqs().find((r) => r.id === id) || null };
  }

  reqResolve({ id, status }) {
    if (status !== 'approved' && status !== 'rejected' && status !== 'cancelled') throw new Error('E_DO_REQ');
    const all = this.#reqs();
    const rec = all.find((r) => r.id === id);
    if (!rec || rec.status !== 'pending') return { ok: false };
    this.s.put('reqs', all.map((r) => (r.id === id ? { ...r, status, payload: null } : r)));
    return { ok: true, type: rec.type };
  }

  #hourly() {
    const hour = Math.floor(this.now() / HOUR_MS);
    const hb = this.s.get('hb') || {};
    const out = [];
    for (let h = hour - STATS_HOURS + 1; h <= hour; h++) {
      const v = hb[h] || [0, 0, 0];
      out.push({ t: h * HOUR_MS, delivered: v[0], filtered: v[1], failed: v[2] });
    }
    return out;
  }

  status() {
    const counters = {};
    for (const n of COUNTER_NAMES) counters[n] = this.s.get(`c:${n}`) || 0;
    const filtered = {};
    for (const n of FILTER_COUNTER_NAMES) filtered[n.slice('filtered_'.length)] = this.s.get(`c:${n}`) || 0;
    return {
      counters,
      filtered,
      deliveries: this.s.get('dlog') || [],
      last24h: this.#last24h(),
      hourly: this.#hourly(),
      pending_requests: this.#reqs().filter((r) => r.status === 'pending').length,
      changes: this.s.get('clog') || [],
      last_nudge: this.s.get('last_nudge') ?? null,
      disconnected: this.s.get('disconnected') === true, connecting: (this.s.get('connecting_until') || 0) > this.now() };
  }

  #clearPending() {
    this.s.delete('pending');
    this.s.delete('pending_channel');
    this.s.delete('pending_ts');
  }

  async markDisconnected() {
    this.s.put('disconnected', true);
    this.#clearPending();
    this.s.delete('alarm_at');
    await this.deleteAlarm();
    return { ok: true };
  }

  markConnected() {
    this.s.delete('disconnected');
    return { ok: true };
  }

  markConnecting() {
    this.s.put('connecting_until', this.now() + 600000);
    return { ok: true };
  }

  consumeRegistration() {
    const now = this.now();
    let start = this.s.get('reg_start');
    let count = this.s.get('reg_count') || 0;
    if (start == null || now - start >= REGISTRATION_WINDOW_MS) {
      start = now;
      count = 0;
    }
    if (count >= REGISTRATION_LIMIT) return { allowed: false };
    this.s.put('reg_start', start);
    this.s.put('reg_count', count + 1);
    return { allowed: true };
  }

  async wipe() {
    await this.deleteAlarm();
    await this.s.deleteAll();
    this.s.put('disconnected', true);
    return { ok: true };
  }

  async noteActivity({ userId, channelId, ts }) {
    if (userId) this.s.put('uid', userId);
    if (this.s.get('disconnected') === true) {
      this.#inc('dropped');
      return { action: 'dropped' };
    }
    const now = this.now();
    const last = this.s.get('last_nudge');
    if (last == null || now - last >= NUDGE_INTERVAL_MS) {
      this.s.put('last_nudge', now);
      this.#clearPending();
      return this.#fireNow(channelId, ts);
    }
    this.s.put('pending', true);
    this.s.put('pending_channel', channelId);
    this.s.put('pending_ts', ts);
    this.#inc('coalesced');
    await this.#ensureAlarm(last + NUDGE_INTERVAL_MS);
    return { action: 'pending' };
  }

  async #ensureAlarm(at) {
    if (this.s.get('alarm_at') != null) return;
    this.s.put('alarm_at', at);
    await this.setAlarm(at);
  }

  async alarm() {
    this.s.delete('alarm_at');
    if (this.s.get('disconnected') === true) {
      this.#clearPending();
      return;
    }
    if (this.s.get('pending') !== true) return;
    const now = this.now();
    const last = this.s.get('last_nudge');
    if (last != null && now - last < NUDGE_INTERVAL_MS) {
      await this.#ensureAlarm(last + NUDGE_INTERVAL_MS);
      return;
    }
    const channelId = this.s.get('pending_channel');
    const ts = this.s.get('pending_ts');
    this.#clearPending();
    this.s.put('last_nudge', now);
    await this.#fireNow(channelId, ts);
  }

  async #fireNow(channelId, ts) {
    let outcome;
    try {
      outcome = await this.fire({ userId: this.s.get('uid'), channelId, ts });
    } catch {
      outcome = { kind: 'network' };
    }
    this.recordDelivery({ dest: 'claude', outcome: outcomeLabel(outcome) });
    if (outcome.kind === 'ok') {
      this.s.put('fail_streak', 0);
      this.#inc('forwarded');
      return { action: 'fired', kind: 'ok' };
    }
    this.#inc('errors');
    if (outcome.kind === 'timeout') this.#inc('timeouts');
    if (!isDefiniteFailure(outcome)) {
      this.s.put('fail_streak', 0);
      return { action: 'fired', kind: outcome.kind };
    }
    if (this.s.get('disconnected') === true) return { action: 'fired', kind: outcome.kind };
    this.s.delete('last_nudge');
    if ((this.s.get('fail_streak') || 0) === 0) {
      this.s.put('fail_streak', 1);
      this.s.put('pending', true);
      this.s.put('pending_channel', channelId);
      this.s.put('pending_ts', ts);
      const at = this.now() + NUDGE_RETRY_DELAY_MS;
      this.s.put('alarm_at', at);
      await this.setAlarm(at);
    } else {
      this.s.put('fail_streak', 0);
      this.#clearPending();
    }
    return { action: 'fired', kind: outcome.kind };
  }
}

function syncStorage(storage) {
  return {
    get: (k) => storage.kv.get(k),
    put: (k, v) => storage.kv.put(k, v),
    delete: (k) => storage.kv.delete(k),
    deleteAll: () => storage.deleteAll()
  };
}

function makeFire(env) {
  const routing = kvRouting(env.ROUTES);
  const validateOpts = { ownHosts: parseOwnHosts(env.OPERATOR_HOSTS).concat(ownHost(env.BASE_URL)) };
  return async ({ userId, channelId, ts }) => {
    const entry = await routing.get(userId);
    if (!entry || entry.dest_type !== 'claude_routine') return { kind: 'invalid' };
    return fireNudge({ entry, channelId, ts, fetchImpl: fetch, validateOpts });
  };
}

function ownHost(baseUrl) {
  try {
    return [new URL(baseUrl).hostname.toLowerCase()];
  } catch {
    return [];
  }
}

export class UserDO {
  constructor(ctx, env) {
    this.core = new UserDOCore({
      storage: syncStorage(ctx.storage),
      now: () => Date.now(),
      setAlarm: (t) => ctx.storage.setAlarm(t),
      deleteAlarm: () => ctx.storage.deleteAlarm(),
      fire: makeFire(env)
    });
  }

  async fetch(request) {
    const method = new URL(request.url).pathname.slice(1);
    let args = {};
    try {
      args = await request.json();
    } catch {
      args = {};
    }
    try {
      return Response.json(await this.core.call(method, args));
    } catch {
      return new Response('{"error":"E_DO"}', { status: 400, headers: { 'content-type': 'application/json' } });
    }
  }

  async alarm() {
    try {
      await this.core.alarm();
    } catch {
      console.error('E_DO_ALARM');
    }
  }
}

export function makeDoClient(namespace) {
  return (userId) => {
    const stub = namespace.get(namespace.idFromName(userId));
    return new Proxy(
      {},
      {
        get: (_t, method) => async (args = {}) => {
          const res = await stub.fetch(`https://do/${String(method)}`, { method: 'POST', body: JSON.stringify(args) });
          if (!res.ok) throw new Error('E_DO_CALL');
          return res.json();
        }
      }
    );
  };
}
