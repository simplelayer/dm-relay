import { handleSlackEvents } from './events.js';
import { handleCallback, handleDestination, handleDisconnectConfirm, handleFilters, handleTestFire, startFlow } from './oauth.js';
import { messagePage } from './pages.js';
import { kvRouting } from './routes.js';
import { parseOwnHosts } from './ssrf.js';
import { makeDoClient } from './user-do.js';

export { UserDO } from './user-do.js';

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
    routing: kvRouting(env.ROUTES),
    userDo: makeDoClient(env.USER_DO),
    fetchImpl: (...args) => fetch(...args),
    now: () => Date.now(),
    routedSample: ROUTED_SAMPLE,
    validateOpts: { ownHosts: parseOwnHosts(env.OPERATOR_HOSTS).concat(baseHost) },
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
  if (method === 'POST' && pathname === '/disconnect/confirm') return handleDisconnectConfirm(request, deps);
  if (method === 'GET' && pathname === '/oauth/callback') return handleCallback(request, deps);
  if (method === 'GET' && (pathname === '/connect' || pathname === '/disconnect' || pathname === '/status')) {
    return startFlow(pathname.slice(1), deps);
  }
  return messagePage('Not found', 'Nothing here.', 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, makeDeps(env), (p) => ctx.waitUntil(p));
    } catch {
      console.error('E_UNHANDLED');
      return new Response('error', { status: 500 });
    }
  }
};
