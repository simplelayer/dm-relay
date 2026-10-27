export const SLACK_TIMESTAMP_WINDOW_S = 300;

export const REQUIRED_SCOPES = ['im:history', 'mpim:history'];
export const OPTIONAL_CHANNEL_SCOPES = ['channels:history', 'groups:history'];
export const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
export const SLACK_API = 'https://slack.com/api';

export const FANOUT_TIMEOUT_MS = 3000;
export const FANOUT_MAX_PAGES = 5;
export const FORWARD_TIMEOUT_MS = 8000;
export const WAIT_UNTIL_BUDGET_MS = 30000;
export const MIN_RETRY_BUDGET_MS = 1500;

export const NUDGE_INTERVAL_MS = 300000;
export const NUDGE_RETRY_DELAY_MS = 30000;

export const SESSION_TTL_S = 3600;
export const DISCONNECT_SESSION_TTL_S = 600;
export const STATE_TTL_S = 600;
export const REGISTRATION_LIMIT = 5;
export const REGISTRATION_WINDOW_MS = 3600000;

export const MAX_URL_LENGTH = 2048;

export const CLAUDE_HOST = 'api.anthropic.com';
export const CLAUDE_FIRE_PATH = /^\/v1\/claude_code\/routines\/[A-Za-z0-9_-]{1,128}\/fire$/;
export const ANTHROPIC_VERSION = '2023-06-01';

// P6 confirmed 2026-10-26: a routine fire with this beta header was accepted (verification run succeeded).
export const CLAUDE_ROUTINE_BETA_HEADER = 'experimental-cc-routine-2026-04-01';

// P7 confirmed 2026-10-26: real Grok webhook endpoint is grok.com/webhook/automation/<id>; relay delivery accepted (2 runs succeeded).
export const GROK_HOST_PATTERN = /^([a-z0-9-]+\.)*(x\.ai|grok\.com)$/;

// P12 confirmed 2026-10-26: api2.cursor.sh webhook registered and a live DM ran the automation.
export const CURSOR_HOST = 'api2.cursor.sh';
export const CURSOR_WEBHOOK_PATH =
  /^\/automations\/webhook\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// P12 confirmed 2026-10-26: api2.cursor.sh webhook registered and a live DM ran the automation.
export const CURSOR_TOKEN_PATTERN =/^crsr_[A-Za-z0-9_-]+$/;
export const CURSOR_TOKEN_MIN_LENGTH = 20;
export const CURSOR_TOKEN_MAX_LENGTH = 200;

export const NUDGE_TEXT_TEMPLATE =
  'new DM activity in channel_id {C} at ts {T}; check my Slack DMs and draft replies for my approval';
export const VERIFY_TEXT = 'dm-relay connection test; there is no new DM activity, no action needed';

export const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

export const COUNTER_NAMES = ['forwarded', 'dropped', 'errors', 'fanout_degraded', 'coalesced', 'timeouts'];

export const OPERATOR_HOST_SUFFIXES = [];

export const DELIVERY_LOG_MAX = 20;
export const HOUR_MS = 3600000;
export const STATS_HOURS = 24;

export const LIMITS = {
  test: { limit: 3, windowMs: 60000 },
  filters: { limit: 10, windowMs: 60000 },
  caps: { limit: 10, windowMs: 60000 },
  profile: { limit: 10, windowMs: 60000 },
  keys: { limit: 10, windowMs: 60000 },
  requests: { limit: 10, windowMs: 60000 },
  decide: { limit: 10, windowMs: 60000 },
  channels: { limit: 10, windowMs: 60000 }
};

export const FILTER_MAX_KEYWORDS = 20;
export const FILTER_KEYWORD_MAX_LENGTH = 50;
export const FILTER_MAX_USERS = 50;
export const FILTER_COUNTER_NAMES = ['filtered_bot', 'filtered_sender', 'filtered_keyword'];

export const CAPS_DEFAULT = { process: true, draft: true, send: false };
export const SEND_WORD = 'SEND';
export const TRUSTED_MAX = 50;
export const CHANNEL_ALLOWLIST_MAX = 10;
export const VOICE_MAX = 2000;
export const API_KEY_MAX = 2;
export const API_KEY_LABEL_MAX = 40;
export const API_BODY_MAX = 8192;
export const API_RATE = { limit: 60, windowMs: 60000 };
export const CHANGE_LOG_MAX = 20;
export const REQUEST_TYPES = ['destination', 'enable_send', 'add_trusted', 'enable_channels'];
export const REQUEST_TTL_MS = 86400000;
export const REQUEST_MAX_PENDING = 5;
export const REQUEST_MAX_KEPT = 20;
export const REQUEST_TRUSTED_MAX = 10;
export const CHANGE_FIELDS = [
  'caps.process',
  'caps.draft',
  'caps.send',
  'filters',
  'trusted_users',
  'voice',
  'channels.enabled',
  'channels.mentions',
  'channels.allowlist',
  ...REQUEST_TYPES.flatMap((t) => [`request:${t}`, `request:${t}:rejected`])
];
