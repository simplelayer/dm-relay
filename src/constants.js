export const SLACK_TIMESTAMP_WINDOW_S = 300;

export const REQUIRED_SCOPES = ['im:history', 'mpim:history'];
export const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
export const SLACK_API = 'https://slack.com/api';

export const FANOUT_TIMEOUT_MS = 3000;
export const FANOUT_MAX_PAGES = 5;
export const FORWARD_TIMEOUT_MS = 8000;
export const WAIT_UNTIL_BUDGET_MS = 30000;
export const MIN_RETRY_BUDGET_MS = 1500;

export const NUDGE_INTERVAL_MS = 300000;
export const NUDGE_RETRY_DELAY_MS = 30000;

export const SESSION_TTL_S = 600;
export const STATE_TTL_S = 600;
export const REGISTRATION_LIMIT = 5;
export const REGISTRATION_WINDOW_MS = 3600000;

export const MAX_URL_LENGTH = 2048;

export const CLAUDE_HOST = 'api.anthropic.com';
export const CLAUDE_FIRE_PATH = /^\/v1\/claude_code\/routines\/[A-Za-z0-9_-]{1,128}\/fire$/;
export const ANTHROPIC_VERSION = '2023-06-01';

// TODO(P6): replace with the beta header value confirmed by firing a routine by hand.
export const CLAUDE_ROUTINE_BETA_HEADER = 'experimental-cc-routine-2026-04-01';

// TODO(P7): replace with the host pattern confirmed by POSTing a signed test to a Grok webhook.
export const GROK_HOST_PATTERN = /^([a-z0-9-]+\.)*(x\.ai|grok\.com)$/;

export const NUDGE_TEXT_TEMPLATE =
  'new DM activity in channel_id {C} at ts {T}; check my Slack DMs and draft replies for my approval';
export const VERIFY_TEXT = 'dm-relay connection test; there is no new DM activity, no action needed';

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

export const COUNTER_NAMES = ['forwarded', 'dropped', 'errors', 'fanout_degraded', 'coalesced', 'timeouts'];

export const OPERATOR_HOST_SUFFIXES = [];
