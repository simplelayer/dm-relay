import { handleSlackEvents } from './events.js';
import { handleApi } from './api.js';
import {
  handleCallback,
  handleCaps,
  handleDestination,
  handleDisconnectConfirm,
  handleFilters,
  handleBootstrap,
  handleKeyCreate,
  handleKeyRevoke,
  handleProfile,
  handleChannels,
  handleRequestApprove,
  handleRequestReject,
  handleTestFire,
  startFlow
} from './oauth.js';
import { messagePage } from './pages.js';
import { kvRouting, ROUTE_SWEEP_REPORT_KEY, sweepPlaintextRouteEntries } from './routes.js';
import { parseOwnHosts } from './ssrf.js';
import { makeEventDedupeClient, EventDedupeDO } from './event-dedupe-do.js';
import { routeCryptoFromEnv } from './secret-crypto.js';
import { makeDoClient } from './user-do.js';

export { UserDO } from './user-do.js';
export { EventDedupeDO } from './event-dedupe-do.js';

const ROUTED_SAMPLE = { at: -Infinity, ids: null };

export function makeDeps(env, overrides = {}) {
  const baseUrl = String(env.BASE_URL || '').replace(/\/+$/, '');
  let baseHost = [];
  try {
    baseHost = [new URL(baseUrl).hostname.toLowerCase()];
  } catch {
    baseHost = [];
  }
  return {
    config: {
      teamId: env.SLACK_TEAM_ID,
      appId: env.SLACK_APP_ID,
      baseUrl,
      publicRepoUrl: env.PUBLIC_REPO_URL,
      signingSecret: env.SLACK_SIGNING_SECRET,
      clientId: env.SLACK_CLIENT_ID,
      clientSecret: env.SLACK_CLIENT_SECRET,
      appToken: env.SLACK_APP_TOKEN,
      stateKey: env.STATE_HMAC_KEY
    },
    kv: env.ROUTES,
    routing: kvRouting(env.ROUTES, routeCryptoFromEnv(env)),
    eventDedupe: makeEventDedupeClient(env.EVENT_DEDUPE_DO, {
      allowInMemoryFallback: overrides.eventDedupeAllowMemory === true
    }),
    userDo: makeDoClient(env.USER_DO),
    fetchImpl: (...args) => fetch(...args),
    now: () => Date.now(),
    routedSample: ROUTED_SAMPLE,
    validateOpts: { ownHosts: parseOwnHosts(env.OPERATOR_HOSTS).concat(baseHost) },
    routeCrypto: routeCryptoFromEnv(env),
    ...overrides
  };
}

export async function route(request, deps, waitUntil) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (method === 'POST' && pathname === '/slack/events') return handleSlackEvents(request, deps, waitUntil);
  if (method === 'POST' && pathname === '/destination') return handleDestination(request, deps);
  if (method === 'POST' && pathname === '/destination/test') return handleTestFire(request, deps);
  if (method === 'POST' && pathname === '/filters') return handleFilters(request, deps);
  if (method === 'POST' && pathname === '/caps') return handleCaps(request, deps);
  if (method === 'POST' && pathname === '/profile') return handleProfile(request, deps);
  if (method === 'POST' && pathname === '/channels') return handleChannels(request, deps);
  if (method === 'POST' && pathname === '/keys/create') return handleKeyCreate(request, deps);
  if (method === 'POST' && pathname === '/keys/revoke') return handleKeyRevoke(request, deps);
  if (method === 'POST' && pathname === '/keys/bootstrap') return handleBootstrap(request, deps);
  if (method === 'POST' && pathname === '/requests/approve') return handleRequestApprove(request, deps);
  if (method === 'POST' && pathname === '/requests/reject') return handleRequestReject(request, deps);
  if (pathname.startsWith('/api/v1/'))return handleApi(request, deps, pathname);
  if (method === 'POST' && pathname === '/disconnect/confirm') return handleDisconnectConfirm(request, deps);
  if (method === 'GET' && pathname === '/oauth/callback') return handleCallback(request, deps);
  if (method === 'GET' && (pathname === '/connect' || pathname === '/disconnect' || pathname === '/status')) {
    return startFlow(pathname.slice(1), deps, { channels: new URL(request.url).searchParams.get('channels') === '1' });
  }
  return messagePage('Not found', 'Nothing here.', 404);
}

async function maybeSweepPlaintextRoutes(env, ctx) {
  if (String(env.ROUTE_SWEEP_ON_BOOT || '') !== '1') return;
  const crypto = routeCryptoFromEnv(env);
  if (!crypto) return;
  const force = String(env.ROUTE_SWEEP_FORCE || '') === '1';
  if (!force && (await env.ROUTES.get(ROUTE_SWEEP_REPORT_KEY))) return;
  ctx.waitUntil(
    sweepPlaintextRouteEntries(env.ROUTES, crypto)
      .then((report) => env.ROUTES.put(ROUTE_SWEEP_REPORT_KEY, JSON.stringify(report)))
      .catch(() => {})
  );
}

export default {
  async fetch(request, env, ctx) {
    try {
      await maybeSweepPlaintextRoutes(env, ctx);
      return await route(request, makeDeps(env), (p) => ctx.waitUntil(p));
    } catch {
      console.error('E_UNHANDLED');
      return new Response('error', { status: 500 });
    }
  }
};
