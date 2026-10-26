# dm-relay

A small Cloudflare Worker that lets individual Slack workspace members opt in to a private DM listener. Their direct messages and group DMs are routed to the member's own AI destination (a Grok automation webhook, a Cursor automation webhook, or a Claude routine). One Slack app, no bot user, listen-and-draft only: the relay cannot send anything to Slack.

## Privacy commitments

- The relay stores no message text, no Slack user tokens and no sender data, except a disconnect token held for up to 10 minutes (see below). Message text is held in memory only while an event is being processed.
- The user token returned by Slack's OAuth exchange is never displayed, never stored and never logged. It is used once to read the user id and then discarded. For a disconnect it is held in the key-value store for up to 10 minutes, until the confirm click, so it can be passed to `auth.revoke`. `/status` revokes the token of anyone who has no destination.
- Logging is disabled (`observability` is off in `wrangler.jsonc`). The code calls `console.*` only with constant error codes. A test fails the build if that changes.
- Per-user counters (forwarded, dropped, errors, fanout_degraded) live in a Durable Object. They are counts and timestamps only, and the operator can read them.
- Honest limits: Slack sends the full DM text to this Worker for every opted-in user. Cloudflare and the operator can technically see it in transit. In `full` mode (Grok and Cursor) the relay forwards the full DM text to the destination, which for Cursor means it is sent to Cursor; in `nudge` mode it forwards only a fixed sentence with a channel id and timestamp. Privacy from the operator is a written commitment backed by this public code, not a technical guarantee. The operator can see who opted in.
- Secrets held (all operator-readable in the key-value store, never logged, never rendered): the per-user destination secret (Grok signing secret, Cursor bearer token or Claude routine bearer token), plus the Slack app-level token, signing secret and OAuth client secret. No Slack user tokens are held, except the disconnect token described above.
- Cursor destinations: the destination account must have privacy mode on (no training on inputs), attested on the form and enforced server-side. The automation must have no autonomous send capability and must treat DM text as data, not instructions, because any workspace member can write text it reads. The attestation covers the account that owns the token. Each verification attempt can trigger one automation run. Whoever holds the bearer token (the operator, via the key-value store) can trigger the automation with arbitrary content.
- Delivery is best-effort and at-most-once. For Cursor there is no retry after a timeout or a 5xx other than 503, because the run may already have started (at-most-once holds).

## How it works

1. `POST /slack/events` verifies the Slack signature, answers `url_verification`, checks `team_id` and `api_app_id`, replies 200 immediately, then in `waitUntil` applies an allowlist filter and fans out to opted-in recipients.
2. Recipients come from `authorizations[]` plus `apps.event.authorizations.list`, intersected with the routing table (Workers KV), minus the sender. The routed user ids are sampled from KV at most once per minute per isolate (ids only, no message data), so the sample can be up to 60 seconds old. If the sample fails, the API is called. A user who connects inside that window may miss messages in that minute.
3. `grok` destinations receive a Standard Webhooks signed JSON POST. `cursor` destinations receive the same JSON body with an `Authorization: Bearer crsr_...` header and no signing; the URL must be `https://api2.cursor.sh/automations/webhook/<uuid>`. `claude_routine` destinations are nudged through a per-user Durable Object that coalesces activity to one run per 5 minutes with a trailing edge.
4. `/connect`, `/disconnect` and `/status` each start a Slack OAuth round trip. Identity comes only from that round trip, never from a form field.

## Layout

`src/index.js` routing and wiring; `slack-verify.js`, `filter.js`, `fanout.js`, `standard-webhooks.js`, `destinations.js`, `ssrf.js`, `oauth.js`, `pages.js`, `user-do.js`, `routes.js`, `events.js`, `util.js`, `constants.js`. There are no runtime dependencies. Pure logic runs in plain Node.

## Tests

```
npm test
```

Uses `node:test` on Node 24. No network access and no credentials are needed; `fetch` is mocked.

## Deploy

1. Create a KV namespace and put its id in `wrangler.jsonc` (`kv_namespaces`).
2. Set the placeholder vars in `wrangler.jsonc`: `SLACK_TEAM_ID`, `SLACK_APP_ID`, `BASE_URL`, `PUBLIC_REPO_URL`. Optionally list other operator-owned hosts in `OPERATOR_HOSTS` (comma separated) so they cannot be used as destinations.
3. Create the Slack app from the manifest in the spec (user scopes `im:history` and `mpim:history`; user events `message.im`, `message.mpim`; events `tokens_revoked`, `app_uninstalled`).
4. Set secrets with `wrangler secret put`: `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_APP_TOKEN` (app-level token with `authorizations:read`), `STATE_HMAC_KEY` (long random string).
5. `wrangler deploy`. The Durable Object uses the SQLite backend (`new_sqlite_classes` migration).

Before relying on a destination type, confirm the open probes recorded in the spec: `TODO(P6)` (Claude routine beta header) and `TODO(P7)` (Grok host pattern) and `TODO(P12)` (Cursor host and token character set) in `src/constants.js`.
