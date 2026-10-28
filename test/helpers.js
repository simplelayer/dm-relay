import { createHmac } from 'node:crypto';
import { fireNudge } from '../src/destinations.js';
import { makeDeps, route } from '../src/index.js';
import { routeCryptoFromEnv } from '../src/secret-crypto.js';
import { kvRouting } from '../src/routes.js';
import { parseOwnHosts } from '../src/ssrf.js';
import { UserDOCore } from '../src/user-do.js';

export const TEAM = 'T0TEAM';
export const APP = 'A0APP';
export const BASE = 'https://relay.example.net';
export const SIGNING_SECRET = 'slack-signing-secret-for-tests';
export const STATE_KEY = 'state-hmac-key-for-tests';
export const APP_TOKEN = 'xapp-test-app-token';
export const USER_TOKEN = 'xoxp-test-user-token-never-store';
export const GROK_SECRET = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
export const GROK_URL = 'https://hooks.x.ai/webhook/abc123';
export const ROUTINE_URL = 'https://api.anthropic.com/v1/claude_code/routines/trig_ABC123/fire';
export const ROUTINE_TOKEN = 'routine-bearer-token';
export const CURSOR_URL = 'https://api2.cursor.sh/automations/webhook/123e4567-e89b-12d3-a456-426614174000';
export const CURSOR_TOKEN = 'crsr_TestBearerToken0123456789_abc-DEF';
export const ROUTE_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
export const ROUTE_ENC_KID = 'test-v1';
export const U1 = 'U1AAAAAA';
export const U2 = 'U2BBBBBB';
export const U3 = 'U3CCCCCC';
export const U4 = 'U4DDDDDD';

export class FakeKV {
  constructor() {
    this.store = new Map();
    this.ttls = new Map();
  }
  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async put(key, value, opts = {}) {
    this.store.set(key, String(value));
    if (opts.expirationTtl) this.ttls.set(key, opts.expirationTtl);
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const names = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = names.slice(start, start + limit);
    const done = start + limit >= names.length;
    return { keys: slice.map((name) => ({ name })), list_complete: done, cursor: done ? undefined : String(start + limit) };
  }
}

export class FakeStorage {
  constructor() {
    this.map = new Map();
  }
  get(k) {
    return this.map.get(k);
  }
  put(k, v) {
    this.map.set(k, v);
  }
  delete(k) {
    this.map.delete(k);
  }
  async deleteAll() {
    this.map.clear();
  }
}

export function respond(status, body = '') {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

export function timeoutError() {
  return new DOMException('timed out', 'TimeoutError');
}

export function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call.url, init, calls);
  };
  fn.calls = calls;
  return fn;
}

export function slackSignature(secret, timestamp, bodyBytes) {
  const h = createHmac('sha256', secret);
  h.update(`v0:${timestamp}:`);
  h.update(bodyBytes);
  return `v0=${h.digest('hex')}`;
}

export function msgPayload({ sender = U1, channel = 'D0CHAN1', channelType = 'im', text = 'hello secret text', authorizations, extraEvent = {}, extra = {}, eventId = 'Ev0001' } = {}) {
  return {
    token: 'legacy',
    team_id: TEAM,
    api_app_id: APP,
    type: 'event_callback',
    event_id: eventId,
    event_time: 1800000000,
    event_context: 'ctx-1',
    authorizations: authorizations ?? [{ team_id: TEAM, user_id: sender === U1 ? U2 : U1, is_bot: false }],
    event: { type: 'message', channel, channel_type: channelType, user: sender, text, ts: '1800000000.000100', ...extraEvent },
    ...extra
  };
}

export function makeWorld({ fetchHandler, nowMs = 1_800_000_000_000 } = {}) {
  const clock = { t: nowMs };
  const kv = new FakeKV();
  const pending = [];
  const cores = new Map();
  const fetchImpl = makeFetch(fetchHandler || (() => respond(200, { ok: true })));
  const env = {
    SLACK_TEAM_ID: TEAM,
    SLACK_APP_ID: APP,
    BASE_URL: BASE,
    PUBLIC_REPO_URL: 'https://github.example/dm-relay',
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_CLIENT_ID: '111.222',
    SLACK_CLIENT_SECRET: 'client-secret-for-tests',
    SLACK_APP_TOKEN: APP_TOKEN,
    STATE_HMAC_KEY: STATE_KEY,
    ROUTE_SECRET_ENCRYPTION_KEY: ROUTE_ENC_KEY,
    ROUTE_SECRET_KEY_ID: ROUTE_ENC_KID,
    OPERATOR_HOSTS: ''
  };
  const routing = kvRouting(kv, routeCryptoFromEnv(env));
  const validateOpts = { ownHosts: parseOwnHosts('').concat(['relay.example.net']) };

  function entry(uid) {
    if (!cores.has(uid)) {
      const storage = new FakeStorage();
      const alarm = { at: null, sets: 0 };
      const core = new UserDOCore({
        storage,
        now: () => clock.t,
        setAlarm: async (t) => {
          alarm.at = t;
          alarm.sets++;
        },
        deleteAlarm: async () => {
          alarm.at = null;
        },
        fire: async ({ userId, channelId, ts }) => {
          const e = await routing.get(userId);
          if (!e) return { kind: 'invalid' };
          return fireNudge({ entry: e, channelId, ts, fetchImpl, validateOpts });
        }
      });
      cores.set(uid, { core, storage, alarm });
    }
    return cores.get(uid);
  }

  const deps = makeDeps(env, {
    kv,
    routing,
    fetchImpl,
    now: () => clock.t,
    routedSample: { at: -Infinity, ids: null },
    validateOpts,
    userDo: (uid) => new Proxy({}, { get: (_t, m) => (args) => entry(uid).core.call(String(m), args ?? {}) })
  });
  const waitUntil = (p) => pending.push(p);

  const world = {
    clock,
    kv,
    deps,
    routing,
    fetchImpl,
    entry,
    cores,
    async flush() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
    request(path, init) {
      return route(new Request(`${BASE}${path}`, init), deps, waitUntil);
    },
    async send(payload, { timestamp, signature, rawBody } = {}) {
      const bytes = rawBody ?? new TextEncoder().encode(JSON.stringify(payload));
      const ts = String(timestamp ?? Math.floor(clock.t / 1000));
      const res = await world.request('/slack/events', {
        method: 'POST',
        headers: {
          'x-slack-request-timestamp': ts,
          'x-slack-signature': signature ?? slackSignature(SIGNING_SECRET, ts, bytes),
          'content-type': 'application/json'
        },
        body: bytes
      });
      await world.flush();
      return res;
    },
    async addRoute(uid, e) {
      await routing.put(uid, e);
    },
    addGrok: (uid, url = `https://hooks.x.ai/w/${uid}`, { full = false } = {}) =>
      routing.put(uid, {
        dest_type: 'grok',
        url,
        secret_or_bearer: GROK_SECRET,
        secret_verified_at: clock.t,
        mode: full ? 'full' : 'ids_only'
      }),
    addCursor: (uid, url = CURSOR_URL, token = CURSOR_TOKEN, { full = false } = {}) =>
      routing.put(uid, {
        dest_type: 'cursor',
        url,
        secret_or_bearer: token,
        secret_verified_at: clock.t,
        mode: full ? 'full' : 'ids_only'
      }),
    addClaude: (uid, url = ROUTINE_URL) =>
      routing.put(uid, { dest_type: 'claude_routine', url, secret_or_bearer: ROUTINE_TOKEN, mode: 'nudge' })
  };
  return world;
}

export function authListResponse(ids) {
  return respond(200, { ok: true, authorizations: ids.map((user_id) => ({ user_id, is_bot: false, team_id: TEAM })) });
}

export function isAuthList(url) {
  return url.includes('apps.event.authorizations.list');
}

export function setCookies(res) {
  return res.headers.getSetCookie();
}

export function stripRouteMeta(entry) {
  if (!entry) return entry;
  const { secret_enc, secret_verified_at, ...rest } = entry;
  return rest;
}

export function cookieHeaderFrom(res) {
  return setCookies(res)
    .map((c) => c.split(';')[0])
    .filter((c) => !c.endsWith('='))
    .join('; ');
}
