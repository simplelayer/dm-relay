# dm-relay

A small Cloudflare Worker that lets individual Slack workspace members opt in to a private DM listener. Their direct messages and group DMs are routed to the member's own AI destination (a Grok automation webhook, a Cursor automation webhook, or a Claude routine). One Slack app, no bot user. The relay itself can never send anything to Slack; sending, if a user allows it, is done by the user's own assistant with its own Slack connector.

## Privacy commitments

- The relay stores no message text, no Slack user tokens and no sender data, except a disconnect token held for up to 10 minutes (see below). Message text is held in memory only while an event is being processed.
- The user token returned by Slack's OAuth exchange is never displayed, never stored and never logged. It is used once to read the user id and then discarded. For a disconnect it is held in the key-value store for up to 10 minutes, until the confirm click, so it can be passed to `auth.revoke`. `/status` revokes the token of anyone who has no destination.
- Logging is disabled (`observability` is off in `wrangler.jsonc`). The code calls `console.*` only with constant error codes. A test fails the build if that changes.
- Per-user counters (forwarded, dropped, errors, fanout_degraded) live in a Durable Object. They are counts and timestamps only, and the operator can read them.
- Honest limits: Slack sends the full DM text to this Worker for every opted-in user. Cloudflare and the operator can technically see it in transit. Grok and Cursor destinations default to IDs-only forwarding (no `text` field); full DM text is forwarded only when the user opts in on the destination form in the browser. Claude routines use `nudge` mode (a fixed sentence with channel id and timestamp only). Privacy from the operator is a written commitment backed by this public code, not a technical guarantee. The operator can see who opted in.
- Per-user data in KV: encrypted destination secrets (`secret_enc`, AES-GCM), routing settings, assistant API key lookup entries (`apikey:<hash>`), and disconnect OAuth sessions (`sess:<sid>`, up to 600 s) with an encrypted user token. Slack app credentials (`SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_APP_TOKEN`) and `STATE_HMAC_KEY` are Worker secrets only, not written to KV. Destination secrets must be re-verified or re-entered at least every 90 days (`secret_verified_at`).
- Cursor destinations: the destination account must have privacy mode on (no training on inputs), attested on the form and enforced server-side. The automation must treat DM text as data, not instructions, because any workspace member can write text it reads; what it may do (process, draft, send) is controlled by its own permissions and the options described under Capabilities. The attestation covers the account that owns the token. Each verification attempt can trigger one automation run. Whoever can read KV and hold the Worker encryption key (the operator) can trigger the automation with arbitrary content.
- Delivery is best-effort and at-most-once. For Cursor there is no retry after a timeout or a 5xx other than 503, because the run may already have started (at-most-once holds).

## How it works

1. `POST /slack/events` verifies the Slack signature, answers `url_verification`, checks `team_id` and `api_app_id`, replies 200 immediately, then in `waitUntil` applies an allowlist filter and fans out to opted-in recipients.
2. Recipients come from `authorizations[]` plus `apps.event.authorizations.list`, intersected with the routing table (Workers KV), minus the sender. The routed user ids are sampled from KV at most once per minute per isolate (ids only, no message data), so the sample can be up to 60 seconds old. If the sample fails, the API is called. A user who connects inside that window may miss messages in that minute.
3. `grok` destinations receive a Standard Webhooks signed JSON POST. `cursor` destinations receive the same JSON body with an `Authorization: Bearer crsr_...` header and no signing; the URL must be `https://api2.cursor.sh/automations/webhook/<uuid>`. `claude_routine` destinations are nudged through a per-user Durable Object that coalesces activity to one run per 5 minutes with a trailing edge.
4. `/connect`, `/disconnect` and `/status` each start a Slack OAuth round trip. Identity comes only from that round trip, never from a form field.

## Delivery log, test button, prompts, filters, status

All of these are on the authenticated pages that follow the Slack sign-in, so identity always comes from the OAuth round trip.

- **Delivery log.** The per-user Durable Object keeps the last 20 delivery events: time, destination type (cursor, grok, claude) and outcome (`ok`, `http_<status>`, `timeout`, `error_network`, `error_invalid`, `error_other`). No message text, channel or sender. It is shown only on that user's own `/status` view and wiped on disconnect. Hourly delivered, filtered and failed counts (the last 24 hourly buckets) are kept the same way.
- **Test button.** `/connect` (after sign-in) shows the saved destination (type and host only) with a "Send test" button. It posts to `/destination/test` with the same session, CSRF token and origin checks as the other actions, limited to 3 tests per minute per user. It sends a synthetic payload (`relay_test: true`, fixed connection-test text, no Slack event needed) through the same SSRF re-validation and signing or bearer code as real deliveries, with one attempt and no retry, and shows pass or fail with the HTTP status. The result is logged as a test and not counted in the 24 hour totals. A Claude routine test fires one real run.
- **Automation prompts.** Generated per user from the destination type, capabilities, trusted list and reply voice (`src/prompts.js`; see Capabilities and prompts below). The copy button needs one inline script, so that page alone adds `script-src 'nonce-...'` (fresh nonce per response, no inline handlers, no external script). Every other page keeps the strict no-script policy.
- **Filters.** Per user, saved on the routing entry through `POST /filters`: skip bot messages (on by default), skip listed Slack user IDs (up to 50), skip messages containing keywords (case-insensitive, up to 20 keywords of at most 50 characters). Matching happens in memory on the in-flight message; a drop only increments a per-reason counter (`filtered_bot`, `filtered_sender`, `filtered_keyword`). Bot-authored messages (a `bot_id` and no subtype) now reach the per-user stage so the setting means something; every other global drop (subtypes, edits, files, external, hidden, Slackbot) is unchanged and unconditional. The rules are operator-readable configuration, not message data.
- **Status.** `/status` shows connected yes or no, destinations, last delivery time and outcome, and the 24 hour delivered, filtered and failed counts, then the recent delivery log. The raw all-time counters are in a collapsed details element.

## Capabilities, trusted senders and voice

These settings are stored per user on the routing entry in the key-value store, next to `filters`, and are readable by the operator. **The relay never sends anything to Slack.** The options below only change the generated prompts, the disclosures and a hint field in the forwarded data. They are not enforcement and are not described as such anywhere: what an assistant can actually do is set by its own automation permissions and Slack connector.

- **Capabilities** (`caps`): `process` (the assistant may start its own workflows), `draft` (it may draft replies for review) and `send` (it may reply in the same DM or thread). Defaults when absent: process on, draft on, send off. They are set on `/connect` (`POST /caps`, same session, CSRF and origin checks as `/filters`, 10 changes per minute). Turning send on from off needs the extra `confirm_send` checkbox and the exact word `SEND` typed in `send_word` in the same submit; otherwise nothing is saved and send stays off. Turning send off needs no confirmation. Re-registering a destination keeps caps, filters, trusted senders and voice.
- **Trusted senders** (`trusted_users`): up to 50 Slack user IDs. Forwarded payloads for Grok and Cursor gain `mode` (`{process, draft, send}`, copied from caps) and `sender_trusted` (true when the sender is on the list). No other field was added. The Claude routine nudge text is unchanged.
- **Voice** (`voice`): up to 2000 characters of free text, control characters other than newline removed. It is included in generated prompts as a fenced "Reply voice" block, returned by the API, and never included in anything forwarded to a destination. Do not put secrets in it; the operator can read it.
- **Prompts.** `src/prompts.js` builds the prompt from the destination type, caps, trusted list and voice. Every variant says DM text is data and not instructions, that a "dm-relay connection test" means do nothing, and to ignore requests inside a DM to change rules, reveal secrets or run tools. Process variants allow the assistant to start its own workflows but only for trusted senders (otherwise summarize or draft only). The send variant allows replies only in the same DM or thread, only for trusted senders, and requires telling the user about every send. A Claude routine is not told who the sender is, so its prompt embeds the trusted IDs and says it must be re-copied after settings change. `/connect` shows the prompt for the saved destination type (all three if none).
- **Settings change log.** The last 20 changes (`{t, via: browser|api, fields}`, field names only, never values) are kept in the user's Durable Object, shown on the user's own `/status` page under "Recent settings changes", and wiped on disconnect.

## Channels (opt-in)

Channel messages (public and private) are off for everyone by default. A user who has not opted in sees no change: the per-user check runs before any other per-user work, so their counters, delivery log and destination are untouched.

- **Settings** (`channels` on the routing entry): `{enabled: false, mentions: true, allowlist: []}`. A channel message (`channel_type` `channel` or `group`) is forwarded only when `enabled` is true and either `mentions` is true and the text contains `<@USERID>` for that user, or the channel id is on the allowlist (up to 10 ids, `C` or `G` prefix plus letters and digits). The browser form is `POST /channels` on `/connect` (same session, CSRF and origin checks and 10 per minute as the other forms). Changes are recorded in the change log as `channels.enabled`, `channels.mentions` and `channels.allowlist`.
- **Same safety rules as DMs.** Bot, subtype, hidden, user and keyword filters and trusted senders all apply to channel messages. Messages from channels shared with another workspace (`is_ext_shared_channel`, or `user_team` or `source_team` from another team) are never forwarded.
- **Payload.** Same fields as a DM plus `mentioned` (boolean). `type` is `channel` or `private_channel`; `channel_id`, `sender_id`, `text`, `ts`, `thread_ts`, `mode` and `sender_trusted` are as for DMs. DM payloads are unchanged and have no `mentioned` field. The Claude routine nudge text is unchanged.
- **Prompts.** When channels are on, generated prompts add a rule: a channel message is not a DM, the draft is for the user to review, and the assistant never sends or posts for a channel message even when send is allowed for DMs. With channels off, prompts are identical to before.
- **Scopes.** `REQUIRED_SCOPES` stays `im:history` and `mpim:history`, so existing users and the normal sign-in are unchanged. `OPTIONAL_CHANNEL_SCOPES` is `channels:history` and `groups:history`. `/connect?channels=1` adds them to the Slack authorize request; the granted scopes are stored on the routing entry (`scopes`) at the OAuth callback, only when both channel scopes were granted. Turning channels on is blocked, in the browser, in an approval request and when approving one, with a message telling the user to re-authorize, until `scopes` holds both.
- **Assistant API.** `GET /api/v1/settings` returns `channels` and `channel_scopes_granted`. The API cannot turn `channels.enabled` on: `PATCH` with `channels.enabled: true` returns 403, the same rule as send. It may turn channels off, change `mentions`, and edit the allowlist only while channels are already enabled (403 otherwise). To ask for channels the assistant proposes `{"type":"enable_channels","allowlist":[...]}` (allowlist optional) through `POST /api/v1/requests`; a human approves it on `/connect` ("Approve and turn channels on"). A proposal is refused with 409 when channels are already on or the scopes are missing.

### Slack app configuration for channels

Existing deployments keep working with no change. To offer channels, update the Slack app, then have each interested user re-authorize through `/connect?channels=1`:

1. Event Subscriptions, user events: add `message.channels` and `message.groups` (keep `message.im` and `message.mpim`).
2. OAuth and Permissions: add the user scopes `channels:history` and `groups:history` (if you deploy a bot token for the same events, add them as bot scopes too).
3. Reinstall the app if Slack asks. Users who do not re-authorize keep working exactly as before.

Privacy note: once channel events are subscribed, Slack sends the relay messages from every channel the opted-in installers are in. The relay discards them for users who have not opted in without storing or forwarding anything. Private-channel content is visible to the relay only for users who opted in (and the relay only forwards what matches their mention or allowlist rules), and, like DMs, it reaches the user's own destination. Operator-visible stored data is the settings and scopes only, never message text.

## Assistant API

A user creates an assistant key on `/connect` (up to 2 active keys, optional label of up to 40 characters). The key is `dmr_` plus 32 random bytes in base64url, shown exactly once on a no-store page. Only its SHA-256 hash is stored: the KV entry `apikey:<hash>` holds `{uid, kid, created, label}`, and the user's Durable Object holds the key list (label, created, last used) so keys can be listed and revoked individually. The lookup is a KV get by hash, with no secret comparison. All keys are revoked on disconnect, `tokens_revoked` and `app_uninstalled`. Keys are never logged.

Requests use `Authorization: Bearer dmr_...`. There are no cookies and no CORS headers. All responses are JSON with `Cache-Control: no-store`. Any missing, malformed, unknown or revoked key gets the same generic 401.

| Method and path | Auth | What it does |
| --- | --- | --- |
| `GET /api/v1/spec` | none | Machine-readable description of the endpoints, fields, limits, errors, examples, the forwarded payload and what the API cannot do. Contains no user data. |
| `GET /api/v1/settings` | key | `{connected, destination:{type,host}, caps, filters, trusted_users, voice, api_keys:[{label,created,last_used}]}`. Never the destination URL path, secret or any key material. |
| `PATCH /api/v1/settings` | key | Partial update of `caps.process`, `caps.draft`, `filters`, `trusted_users`, `voice`, with the same validation as the browser. `caps.send: true` returns 403 (send can only be enabled in the browser); `caps.send: false` is allowed. `trusted_users` can only shrink: adding a sender returns 403 and must be done in the browser. Unknown fields return 400. All or nothing. |
| `GET /api/v1/prompt?type=cursor\|grok\|claude_routine` | key | The current generated prompt; `type` defaults to the saved type. |
| `GET /api/v1/status` | key | The same data as the user's status page (summary, last 24 hour counts, delivery log, recent settings changes). No message content. |
| `POST /api/v1/test` | key | The browser test-fire: same 3 per minute limit, recorded as a test. |
| `GET /api/v1/setup` | key | `{steps:[{id,title,done,actor,how,url}], next_step}`: the setup checklist computed from real state (sign-in, destination, test, prompt, first delivery, optional voice and trusted senders). `actor` is `assistant` or `human`. The prompt step is never marked done because it cannot be detected. No secrets. |
| `POST /api/v1/requests` | key | Propose a sensitive change (see Approval requests). Returns `{id, type, status:"pending", expires}`. |
| `GET /api/v1/requests` | key | The user's requests: id, type, summary, status (`pending`, `approved`, `rejected`, `expired`, `cancelled`), created, expires. Never secrets. |
| `DELETE /api/v1/requests/<id>` | key | Cancel one of the user's own pending requests. |

Limits: request body at most 8 KB (413 otherwise), 60 requests per minute per key (429 with `Retry-After`), 2 active keys per user. The API cannot enable send, change the destination URL, secret or type directly, approve or apply a request, create or revoke keys, or disconnect. Unknown endpoints return 404 and wrong methods 405, with no CORS headers.


## Approval requests (assistant proposes, human approves)

The assistant cannot do the sensitive steps itself. It proposes them with `POST /api/v1/requests` and the user approves each one in the browser at `/connect`.

- **Types.** `destination` (`dest_type` grok, cursor or claude_routine, `url`, `secret`), `enable_send` (no fields), `add_trusted` (`user_ids`, 1 to 10 Slack user IDs) and `enable_channels` (optional `allowlist`, up to 10 channel IDs; see Channels). Unknown fields return 400.
- **Validation at proposal.** The same URL validators as the browser form (https only, host allowlists, SSRF and own-host checks) and the same secret shape checks run when the request is made. The destination is not contacted until a human approves.
- **Storage.** Requests live in the user's Durable Object (`reqs`), not in KV. The destination secret exists only inside the pending request. It is never returned by any API response or page, never logged and never written to the change log or delivery log. It is deleted from the store when the request is approved, rejected, cancelled or expires (24 hours). The operator can read it while the request is pending, like every other secret held for the user.
- **Limits.** At most 5 pending requests per user (409 beyond), identical pending requests are deduplicated (200 with the existing id), 10 proposals per minute, 8 KB bodies. Ids are 16 random bytes in base64url.
- **Approval.** `/connect` lists each pending request with the exact change (destination: type and host only; send: a strong warning; trusted: the IDs) and Approve and Reject buttons (`POST /requests/approve`, `POST /requests/reject`: same session, connect intent, CSRF token and origin checks as the other forms, 10 per minute). Approving applies exactly the stored request. A destination needs the training attestation, then runs the same verification as the form and stays pending if it fails. Send needs the `confirm_send` checkbox and the typed word `SEND`. Channels need the stored channel scopes. Trusted additions merge under the 50 ID cap. Expired, resolved and other users' ids are refused. Caps, filters, trusted senders and voice survive a destination approval.
- **Change log.** Each approval or rejection is recorded with `via: approval` and a field such as `request:destination` or `request:enable_send:rejected`, never values.
- **Wipe.** Requests are removed with the rest of the Durable Object on disconnect, `tokens_revoked` and `app_uninstalled`.
- **Bootstrap.** After Slack sign-in, "Set up with my assistant" on `/connect` (when the user has fewer than 2 keys, even before a destination exists) creates a key labelled `assistant` and shows it once together with the spec URL and the instructions "Fetch the spec URL, then call GET /api/v1/setup with this key and follow next_step. Never post or send anything unless the user has approved Send." That page keeps the strict no-script policy: the block is selectable with one click and has no copy button.

## Pages

Every page shares one small inline stylesheet (system fonts, one accent colour variable, light and dark, down to 360 px, no external assets). `/connect` is a set of cards: setup checklist (computed from real state), what the assistant can do (a banner such as "Your assistant can: process, draft. It cannot send." and a warning-styled Send control), connection (saved destination, test, and a destination form that shows only the hints for the chosen type using CSS `:has()` only), pending requests, assistant keys, filters and trusted senders, voice and prompts (the saved type's prompt first, the other two folded). `/status` adds a 24 hour delivery chart as inline SVG with a text summary and data table, a delivery table and a pending-requests banner. Error and expired-session pages say what happened and link to start again.

## Deploy script

`scripts/deploy.ps1` is a one-way pipeline from this repo to the public copy. With no flags it is a dry run: it runs the tests, checks the working tree, lists what would change, scans the publish set for secrets, and stops. `-AllowDirty` permits a dirty tree. `-Deploy` syncs, scans, then runs `npx wrangler deploy`. `-Push -Message "..."` syncs, scans, then commits and pushes the public copy on `main`. The scan aborts on `crsr_`, `whsec_`, `xoxb-`, `xoxp-`, `xapp-`, `dmr_`, `sk-ant`, Bearer tokens and long values assigned to token or secret keys, apart from the exact fake test fixtures listed in the script. The public copy never flows back into this repo.

## Layout

`src/index.js` routing and wiring; `slack-verify.js`, `filter.js`, `fanout.js`, `standard-webhooks.js`, `destinations.js`, `ssrf.js`, `oauth.js`, `pages.js`, `user-do.js`, `routes.js`, `events.js`, `util.js`, `constants.js`, `delivery-log.js`, `prompts.js`, `caps.js`, `settings.js`, `apikeys.js`, `api.js`, `requests.js`, `wipe.js`. There are no runtime dependencies. Pure logic runs in plain Node.

## Tests

```
npm test
```

Uses `node:test` on Node 24. No network access and no credentials are needed; `fetch` is mocked.

## Deploy

1. Create a KV namespace and put its id in `wrangler.jsonc` (`kv_namespaces`).
2. Set the placeholder vars in `wrangler.jsonc`: `SLACK_TEAM_ID`, `SLACK_APP_ID`, `BASE_URL`, `PUBLIC_REPO_URL`. Optionally list other operator-owned hosts in `OPERATOR_HOSTS` (comma separated) so they cannot be used as destinations.
3. Create the Slack app from the manifest in the spec (user scopes `im:history` and `mpim:history`; user events `message.im`, `message.mpim`; events `tokens_revoked`, `app_uninstalled`).
4. Set secrets with `wrangler secret put`: `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_APP_TOKEN` (app-level token with `authorizations:read`), `STATE_HMAC_KEY` (long random string), `ROUTE_SECRET_ENCRYPTION_KEY` (32 random bytes, base64-encoded), and `ROUTE_SECRET_KEY_ID` (a short label for rotation, e.g. `v1`).
5. `wrangler deploy`. Durable Objects use the SQLite backend (`new_sqlite_classes` migrations).

### Rotating `ROUTE_SECRET_ENCRYPTION_KEY`

1. Generate a new 32-byte key and choose a new id (e.g. `v2`). Set both as new Worker secrets (`ROUTE_SECRET_ENCRYPTION_KEY`, `ROUTE_SECRET_KEY_ID`).
2. Redeploy. New writes use the new key. Existing `route:` entries encrypted with the previous id cannot be decrypted until the user re-enters the destination secret in the browser (or approves a new destination request). On deploy, set `ROUTE_SWEEP_ON_BOOT=1` (Worker var) once to seal or delete any legacy plaintext `route:` entries; read back counts only from KV key `meta:route_sweep_report` (`total`, `sealed`, `purged`, `plaintext_remaining` must be 0).
3. After deploy, ask connected users to open `/connect` and save the destination again if deliveries fail with a stale-secret filter count.

Probes P6 (Claude routine beta header), P7 (Grok host pattern) and P12 (Cursor host and token character set) were confirmed live on 2026-10-26; see the comments in `src/constants.js`.
