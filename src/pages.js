import { CSP } from './constants.js';
import { randomBase64Url } from './util.js';

const COPY_SCRIPT =
  "document.querySelectorAll('button[data-copy]').forEach(function(b){b.hidden=false;b.addEventListener('click',function(){var t=document.getElementById(b.getAttribute('data-copy'));navigator.clipboard.writeText(t.value).then(function(){b.textContent='Copied'},function(){t.select();b.textContent='Press Ctrl+C to copy'})})});";

// Change --accent (and its dark twin) to re-theme every page.
const STYLE = `:root{--accent:#2f6f6a;--on-accent:#fff;--bg:#eef0f2;--card:#fff;--ink:#1e262d;--muted:#56626e;--line:#d5dbe1;--code:#eceff2;--ok:#17653f;--ok-bg:#e3f3ea;--warn:#7a4f00;--warn-bg:#fff2cf;--bad:#9c2323;--bad-bg:#fbe7e7;--info:#1f4e63;--info-bg:#e5eff4;--btn-bad:#a82a2a;--s1:.25rem;--s2:.5rem;--s3:1rem;--s4:1.5rem;--s5:2.5rem;--r:10px}
@media(prefers-color-scheme:dark){:root{--accent:#5fb3aa;--on-accent:#0b1a19;--bg:#13171b;--card:#1c2227;--ink:#e6eaee;--muted:#9ca7b2;--line:#333c45;--code:#2a323a;--ok:#74d6a3;--ok-bg:#16301f;--warn:#f0c14b;--warn-bg:#352c10;--bad:#ff9a9a;--bad-bg:#3b1c1c;--info:#8fc4dc;--info-bg:#1b2b34;--btn-bad:#c24848}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:var(--s3) var(--s3) var(--s5)}
.top{padding:var(--s3) 0 var(--s2);font-weight:700;letter-spacing:.03em;color:var(--accent)}
h1{font-size:1.6rem;line-height:1.2;margin:var(--s2) 0 var(--s3)}
h2{font-size:1.15rem;line-height:1.3;margin:0 0 var(--s2)}
h3{font-size:1rem;margin:var(--s3) 0 var(--s2)}
p{margin:0 0 var(--s3)}
ul,ol{padding-left:1.25rem;margin:0 0 var(--s3)}
li{margin:var(--s1) 0}
a{color:var(--accent)}
code{background:var(--code);padding:.05rem .3rem;border-radius:4px;font-size:.9em;overflow-wrap:anywhere}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:var(--s3) var(--s4);margin:0 0 var(--s3)}
details.card>summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;gap:var(--s3)}
details.card>summary::-webkit-details-marker{display:none}
details.card>summary::after{content:"+";color:var(--muted);font-weight:700}
details.card[open]>summary::after{content:"\\2013"}
details.card>summary h2{margin:0}
details.card[open]>summary{margin-bottom:var(--s3)}
details.sub{margin:0 0 var(--s3)}
details.sub>summary{cursor:pointer;font-weight:600}
label{display:block;font-weight:600;margin:0 0 var(--s1)}
label.inline{display:flex;gap:var(--s2);align-items:flex-start;font-weight:400}
.field{margin:0 0 var(--s3)}
.hint{display:block;color:var(--muted);font-size:.9rem;margin-top:var(--s1)}
input[type=text],input[type=password],textarea{width:100%;font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.55rem .65rem}
input[type=checkbox],input[type=radio]{flex:none;width:1.1rem;height:1.1rem;margin:.25rem 0 0;accent-color:var(--accent)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
fieldset{border:1px solid var(--line);border-radius:8px;margin:0 0 var(--s3);padding:var(--s3)}
legend{font-weight:700;padding:0 var(--s2)}
.btn,button{display:inline-block;font:inherit;font-weight:600;line-height:1.2;border-radius:8px;padding:.6rem 1.1rem;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;text-decoration:none}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn-secondary{background:transparent;border-color:var(--accent);color:var(--accent)}
.btn-danger{background:var(--btn-bad);border-color:var(--btn-bad);color:#fff}
.row{display:flex;flex-wrap:wrap;gap:var(--s2);align-items:center}
.banner{border-left:4px solid;border-radius:8px;padding:var(--s2) var(--s3);margin:0 0 var(--s3)}
.banner p{margin:var(--s1) 0}
.b-info{background:var(--info-bg);border-color:var(--info)}
.b-success{background:var(--ok-bg);border-color:var(--ok)}
.b-warning{background:var(--warn-bg);border-color:var(--warn)}
.b-danger{background:var(--bad-bg);border-color:var(--bad)}
.badge{display:inline-block;font-size:.8rem;font-weight:700;border-radius:999px;padding:.05rem .6rem;background:var(--code);color:var(--muted);white-space:nowrap}
.badge.ok{background:var(--ok-bg);color:var(--ok)}
.badge.bad{background:var(--bad-bg);color:var(--bad)}
.badge.warn{background:var(--warn-bg);color:var(--warn)}
.check{list-style:none;padding:0;margin:0 0 var(--s3)}
.check li{display:flex;gap:var(--s3);justify-content:space-between;align-items:flex-start;margin:0;padding:var(--s2) 0;border-top:1px solid var(--line)}
.check li:first-child{border-top:0}
.send-box{border:2px solid var(--warn);background:var(--warn-bg);border-radius:8px;padding:var(--s3);margin:var(--s3) 0}
.req{border:1px solid var(--line);border-radius:8px;padding:var(--s3);margin:0 0 var(--s3)}
.req.danger{border-color:var(--bad)}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.92rem}
th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600}
.muted{color:var(--muted)}
.small{font-size:.9rem}
.sel{user-select:all;-webkit-user-select:all}
.chart{display:block;width:100%;height:auto;margin:0 0 var(--s2)}
.bar-d{fill:var(--accent)}.bar-f{fill:var(--muted)}.bar-x{fill:var(--bad)}
.axis{stroke:var(--line);stroke-width:1}
.ax{fill:var(--muted);font-size:10px}
.legend{display:flex;flex-wrap:wrap;gap:var(--s3);font-size:.9rem;margin:0 0 var(--s3)}
.sw.d{background:var(--accent)}.sw.f{background:var(--muted)}.sw.x{background:var(--bad)}
.sw{display:inline-block;width:.8rem;height:.8rem;border-radius:2px;margin-right:.35rem;vertical-align:-.05rem}
@supports selector(:has(*)){.dest-form .only{display:none}
.dest-form:has(#t-grok:checked) .only.grok,.dest-form:has(#t-cursor:checked) .only.cursor,.dest-form:has(#t-claude_routine:checked) .only.claude_routine{display:block}}
@media(max-width:480px){.wrap{padding:var(--s2)}.card{padding:var(--s3)}h1{font-size:1.35rem}.check li{flex-direction:column;gap:var(--s1)}}`;

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function pageHeaders(nonce) {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'referrer-policy': 'no-referrer',
    'content-security-policy': nonce ? `${CSP}; script-src 'nonce-${nonce}'` : CSP,
    'x-content-type-options': 'nosniff'
  };
}

export function htmlResponse(title, body, { status = 200, cookies = [], script = null } = {}) {
  const nonce = script ? randomBase64Url(16) : null;
  const headers = new Headers(pageHeaders(nonce));
  for (const c of cookies) headers.append('set-cookie', c);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main class="wrap"><div class="top">DM Relay</div>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
  return new Response(html, { status, headers });
}

const banner = (kind, inner) => `<div class="banner b-${kind}" role="${kind === 'danger' || kind === 'warning' ? 'alert' : 'status'}">${inner}</div>`;
const msgBanner = (m, kind = 'success') => (m ? banner(kind, `<strong>${esc(m.text)}</strong>`) : '');
const card = (id, title, inner) => `<section class="card"${id ? ` id="${id}"` : ''}><h2>${esc(title)}</h2>${inner}</section>`;
const fold = (id, title, inner, open = false) =>
  `<details class="card"${id ? ` id="${id}"` : ''}${open ? ' open' : ''}><summary><h2>${esc(title)}</h2></summary>${inner}</details>`;
const csrfInput = (csrf) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

function repoLink(url) {
  return /^https:\/\//.test(url || '') ? `<a href="${esc(url)}">${esc(url)}</a>` : esc(url);
}

export function connectPage({ intent, authorizeUrl, cookie, publicRepoUrl, channels = false }) {
  const verb = { connect: 'Connect', disconnect: 'Disconnect', status: 'View status for' }[intent];
  const body = `<h1>${esc(verb)} DM Relay</h1>
${channels ? banner('warning', `<strong>Channel access.</strong><p>This sign-in also asks Slack for permission to read public and private channel messages (channels:history and groups:history). Nothing from channels is forwarded until you turn channels on, and then only messages that mention you or are in channels you list. Private channel content becomes visible to this relay only for users who opt in.</p>`) : ''}
${card('', 'What is DM Relay?', `<p>DM Relay turns your Slack direct messages into draft replies from your own AI assistant. When someone messages you, the relay passes the message to the assistant you choose, and your assistant can prepare a reply for you to review.</p>
<p>The relay never sends anything itself. You choose what your assistant may do, and you can disconnect at any time.</p>
<p class="muted small">The rest of this page explains exactly what happens to your data. Please read it before you continue.</p>`)}
${card('', 'What this does', `<p>When you connect, direct messages and group DMs sent to you (and by you) are delivered to the Slack app, then forwarded to the AI destination you choose (a Grok bot, a Cursor automation or a Claude routine). Only people who click Allow have a listener. People who DM you have their messages processed by your AI; they have not consented.</p>
<p>The relay cannot send anything to Slack. It never stores message text. Your Slack token is never stored, except for up to 10 minutes during a disconnect, until you confirm.</p>`)}
${card('', 'Disclosures', `<ul>
<li>Slack delivers the full text of your DMs to this relay Worker. By default Grok and Cursor destinations receive metadata only (event id, channel id, sender id, timestamps). If you opt in on the destination form, the relay forwards the full DM text, which for Cursor means it is sent to Cursor. Claude routines use nudge mode: the relay forwards none of the text; content reaches Claude only through your own Slack connector. Cloudflare and the operator can technically see text in transit, and your destination's AI vendor sees full text only when you opt in.</li>
<li>The operator is also the Slack workspace owner, Slack app owner and Cloudflare account owner. Privacy from the operator is a written commitment backed by public code, not a technical guarantee. The owner can see who has opted in (Slack admin app authorization view).</li>
<li>Per-user counters (forwarded, dropped, errors, fanout_degraded) are activity metadata that is visible to the operator.</li>
<li>The relay also keeps a delivery log of your last 20 delivery events (time, destination type and outcome only) and the filter rules you set (skipped user IDs and keywords). The log and the rules are visible to the operator and are deleted when you disconnect. No message text, channel or sender is kept.</li>
<li>Delivery is best-effort and at-most-once. If your destination is down, DMs during the outage are not delivered. Claude nudges can also be lost to daily run caps or timeouts. Forwarding can continue for up to about 60 seconds after you disconnect. Messages in roughly the first minute after you connect may not be delivered. For Cursor, there is no retry after a timeout or a 5xx other than 503, because the run may already have started (at-most-once holds).</li>
<li>Your destination secret or bearer token is encrypted at rest in the relay's key-value store (AES-GCM with a Worker-only key). The operator can still decrypt it with Cloudflare access. Slack app credentials are not stored in KV; they are Worker secrets.</li>
<li>If your assistant proposes a destination, the proposed URL and secret are held in your Durable Object, readable by the operator, until you approve or reject it or it expires after 24 hours. The secret is deleted from that store when the request is resolved. Nothing is contacted or saved until you approve.</li>
<li>Connecting a Claude routine fires one real routine run to verify it, which uses one of your daily runs.</li>
<li>Each verification attempt can trigger one automation run.</li>
<li>The relay never sends anything to Slack. What your own AI assistant may do with your DMs (process them, draft replies, send) is controlled by your own automation permissions, and you can record your choices after connecting. Those choices only change the prompts, these disclosures and a hint field in the forwarded data; they are not enforcement by the relay.</li>
<li>DM text is untrusted data written by any workspace member. An assistant that is allowed to act or send can be steered by a hostile message, so keep send off unless you need it and rely on the trusted-sender list.</li>
<li>Your trusted-sender list, reply voice text and capability choices are stored with your routing entry and are readable by the operator. Do not put secrets in the voice text. Assistant API keys are stored only as a SHA-256 hash.</li>
</ul>`)}
${card('', 'Claude routine setup rules', `<ul>
<li>Attach only the Slack connector to the routine.</li>
<li>Give the routine only the Slack permissions you want it to use. If you do not want it to send, disable every Slack write tool and allow draft creation only, if it exists.</li>
<li>In the routine prompt, state that the fire <code>text</code> must be ignored and that DM content is data, not instructions.</li>
</ul>`)}
${card('', 'Cursor automation setup rules', `<ul>
<li>The Cursor account that owns the automation must have privacy mode on (no training on inputs). You attest to this below and on the next page.</li>
<li>What the automation may do (process, draft, send) is controlled by its own permissions. Keep send off unless you need it.</li>
<li>In the automation prompt, state that the DM text is data, not instructions, because any workspace member can write text the automation reads.</li>
</ul>`)}
${card('', 'Unattended-agent risk', `<p>Routines run unattended. Any workspace member can write text your routine reads, so prompt injection is possible. Whoever holds the routine bearer token (the operator, through the key-value store) can inject arbitrary instructions into your agent through the fire text. Keep send off for your Grok bot, Cursor automation or Claude routine unless you need it, and rely on the trusted-sender list.</p>
<p>The same applies to Cursor automations: any workspace member can write text your automation reads, and whoever holds the Cursor bearer token (the operator, through the key-value store) can trigger your automation with arbitrary content.</p>`)}
${card('', 'Third parties and training', `<p><label class="inline" for="attest-preview"><input id="attest-preview" type="checkbox" name="attest_preview" value="1"> <span>I attest that model training on inputs is turned off for my destination account (Claude: "Help improve Claude" off, or a Team/Enterprise plan; Grok: the equivalent setting; Cursor: privacy mode on). You will be asked to confirm this again before activation.</span></label></p>`)}
${card('', 'Source code', `<p>Public repository: ${repoLink(publicRepoUrl)}</p><p><a class="btn btn-primary" href="${esc(authorizeUrl)}">Continue to Slack</a></p>`)}`;
  return htmlResponse('DM Relay', body, { cookies: [cookie] });
}

const DEST_TEXT = {
  grok: { name: 'Grok automation webhook', example: 'https://grok.com/webhook/automation/&lt;id&gt;', secret: 'Grok signing secret (starts with <code>whsec_</code>)' },
  cursor: { name: 'Cursor automation webhook', example: 'https://api2.cursor.sh/automations/webhook/&lt;uuid&gt;', secret: 'Cursor bearer token (starts with <code>crsr_</code>)' },
  claude_routine: { name: 'Claude routine', example: 'https://api.anthropic.com/v1/claude_code/routines/&lt;trigger_id&gt;/fire', secret: 'Claude routine bearer token' }
};

function savedDestinationBlock(csrf, manage) {
  const d = manage.destination;
  const r = manage.testResult;
  const result = r ? banner(r.ok ? 'success' : 'danger', `<strong>${r.ok ? 'Test passed' : 'Test failed'}:</strong> ${esc(r.text)}`) : '';
  if (!d) return `<p>No destination is saved yet. Choose one below.</p>`;
  const note = d.type === 'claude' ? ' A Claude routine test fires one real routine run.' : '';
  return `<p><strong>Saved destination:</strong> ${esc(d.label)} at <code>${esc(d.host)}</code></p>
${result}
<form method="post" action="/destination/test">${csrfInput(csrf)}<p class="row"><button type="submit" class="btn-secondary">Send test</button> <span class="muted small">A harmless synthetic connection test. It contains no real message. Limited to a few tests per minute.${note}</span></p></form>`;
}

function destinationForm(csrf, sel, saved) {
  const radios = ['grok', 'cursor', 'claude_routine']
    .map((t) => {
      const text = {
        grok: 'Grok automation webhook (IDs-only by default)',
        cursor: 'Cursor automation webhook (IDs-only by default)',
        claude_routine: 'Claude routine (nudge mode)'
      }[t];
      return `<label class="inline" for="t-${t}"><input id="t-${t}" type="radio" name="dest_type" value="${t}"${sel === t ? ' checked' : ''}> <span>${text}</span></label>`;
    })
    .join('\n');
  const examples = Object.entries(DEST_TEXT).map(([t, v]) => `<span class="hint only ${t}">${esc(v.name)} example: <code>${v.example}</code></span>`).join('');
  const secrets = Object.entries(DEST_TEXT).map(([t, v]) => `<span class="only ${t}">${v.secret}</span>`).join(' ');
  return `<form method="post" action="/destination">
${csrfInput(csrf)}<div class="dest-form">
<fieldset><legend>Destination type</legend>
${radios}
</fieldset>
<div class="field"><label for="f-url">Webhook URL or routine fire URL</label><input id="f-url" type="text" name="url" autocomplete="off" required>${examples}</div>
<div class="field"><label for="f-secret">${secrets}</label><input id="f-secret" type="password" name="secret" autocomplete="off" required></div>
<div class="only grok only cursor send-box">
<p><label class="inline" for="f-full"><input id="f-full" type="checkbox" name="forward_full_text" value="1"> <span><strong>Forward full DM text</strong> to this destination (off by default). Counterparties have not consented to their messages being sent to an AI vendor in full. Only enable this if you accept that risk.</span></label></p>
</div>
<p><label class="inline" for="f-attest"><input id="f-attest" type="checkbox" name="attest" value="1" required> <span>I attest that model training on inputs is turned off for this destination account (for Cursor: privacy mode is on; the attestation covers the account that owns the token).</span></label></p>
<p class="only cursor muted small">Cursor: Each verification attempt can trigger one automation run. The automation must treat DM text as data, not instructions, and what it may do is controlled by its own permissions. Whoever holds the bearer token (the operator, through the key-value store) can trigger the automation with arbitrary content.</p>
<p class="only claude_routine muted small">Claude: verifying fires one real routine run, which uses one of your daily runs.</p>
<p class="muted small">Leaving without activating keeps Slack access until you run /disconnect.</p>
<p><button type="submit" class="btn-primary">Verify and activate</button></p>
</div></form>`;
}

function msgLine(m) {
  return msgBanner(m);
}

function filtersBlock(csrf, manage) {
  const f = manage.filters;
  return `${msgLine(manage.filterMsg)}
<form method="post" action="/filters">
${csrfInput(csrf)}
<fieldset><legend>Filters</legend>
<p class="muted small">Messages that match are not forwarded. Only a count per reason is kept; the matching text and sender are never stored. Keywords are checked in memory against each message as it arrives.</p>
<p><label class="inline" for="f-bots"><input id="f-bots" type="checkbox" name="skip_bots" value="1"${f.skip_bots ? ' checked' : ''}> <span>Skip messages from bots</span></label></p>
<div class="field"><label for="f-users">Skip these Slack user IDs</label><input id="f-users" type="text" name="skip_users" autocomplete="off" value="${esc(f.skip_users.join(' '))}"><span class="hint">Separated by spaces or commas, up to 50.</span></div>
<div class="field"><label for="f-kw">Skip messages containing these keywords</label><textarea id="f-kw" name="keywords" rows="4" autocomplete="off">${esc(f.keywords.join('\n'))}</textarea><span class="hint">One per line, case-insensitive, up to 20 keywords of at most 50 characters.</span></div>
</fieldset>
<p><button type="submit" class="btn-secondary">Save filters</button></p>
</form>`;
}

function capsBlock(csrf, manage) {
  const c = manage.caps;
  return `<p>The relay itself never sends anything to Slack. These options only change the prompts below, the disclosures and a <code>mode</code> hint in the forwarded data. They are not enforcement: what your assistant can actually do is set by its own automation permissions and Slack connector.</p>
<p>DM text is untrusted data written by any workspace member. An assistant that is allowed to act or send can be steered by a hostile message, so keep send off unless you need it and rely on the trusted-sender list.</p>
${msgLine(manage.capsMsg)}
<form method="post" action="/caps">
${csrfInput(csrf)}
<fieldset><legend>What your assistant may do</legend>
<p><label class="inline" for="cap-process"><input id="cap-process" type="checkbox" name="process" value="1"${c.process ? ' checked' : ''}> <span>Process: my assistant may start its own workflows for trusted senders</span></label></p>
<p><label class="inline" for="cap-draft"><input id="cap-draft" type="checkbox" name="draft" value="1"${c.draft ? ' checked' : ''}> <span>Draft: my assistant may draft replies for me to review</span></label></p>
<div class="send-box">
<label class="inline" for="cap-send"><input id="cap-send" type="checkbox" name="send" value="1"${c.send ? ' checked' : ''}> <span><strong>Send: my assistant may reply in the same DM or thread for trusted senders</strong></span></label>
<p class="small">Warning: this lets your assistant reply on your behalf, and it can be steered by a hostile DM. To turn send on you must also tick the box and type the word SEND below. Turning send off needs no confirmation.</p>
<p><label class="inline" for="cap-confirm"><input id="cap-confirm" type="checkbox" name="confirm_send" value="1"> <span>I understand that a hostile DM could steer an assistant that is allowed to send.</span></label></p>
<div class="field"><label for="cap-word">Type SEND to confirm</label><input id="cap-word" type="text" name="send_word" autocomplete="off"></div>
</div>
</fieldset>
<p><button type="submit" class="btn-primary">Save capabilities</button></p>
</form>`;
}

function trustedBlock(csrf, manage) {
  return `${msgLine(manage.trustedMsg)}
<form method="post" action="/profile">
${csrfInput(csrf)}
<fieldset><legend>Trusted senders</legend>
<p class="muted small">Trusted senders are the only people whose messages an assistant with process or send enabled should act on. Forwarded data carries a <code>sender_trusted</code> flag. The list is stored with your routing entry and is readable by the operator.</p>
<div class="field"><label for="f-trusted">Trusted Slack user IDs</label><input id="f-trusted" type="text" name="trusted_users" autocomplete="off" value="${esc(manage.trusted_users.join(' '))}"><span class="hint">Separated by spaces or commas, up to 50. Your assistant can ask you to add IDs from the Pending requests section.</span></div>
</fieldset>
<p><button type="submit" class="btn-secondary">Save trusted senders</button></p>
</form>`;
}

function channelsBlock(csrf, manage) {
  const c = manage.channels;
  const scopes = manage.channelScopes
    ? ''
    : banner('info', `<strong>Re-authorize first.</strong><p>Channels need two extra Slack permissions (channels:history and groups:history) that your current sign-in did not grant. <a href="/connect?channels=1">Re-authorize with channel access</a>, then come back here. Until then, turning channels on is blocked.</p>`);
  return `${msgLine(manage.channelsMsg)}${scopes}
<form method="post" action="/channels">
${csrfInput(csrf)}
<fieldset><legend>Channels (off by default)</legend>
<p class="muted small">Off by default. When on, messages from public and private channels you are in are forwarded to your destination only if they mention you or are in a channel on your list below. Private channel text becomes visible to this relay for your account only. Messages from channels shared with other workspaces are never forwarded. Your filters and trusted senders still apply.</p>
<p><label class="inline" for="ch-enabled"><input id="ch-enabled" type="checkbox" name="enabled" value="1"${c.enabled ? ' checked' : ''}> <span>Forward channel messages to my assistant</span></label></p>
<p><label class="inline" for="ch-mentions"><input id="ch-mentions" type="checkbox" name="mentions" value="1"${c.mentions ? ' checked' : ''}> <span>Forward messages that mention me</span></label></p>
<div class="field"><label for="ch-allow">Always forward these channel IDs</label><input id="ch-allow" type="text" name="allowlist" autocomplete="off" value="${esc(c.allowlist.join(' '))}"><span class="hint">Slack channel IDs starting with C or G, separated by spaces or commas, up to 10.</span></div>
</fieldset>
<p><button type="submit" class="btn-secondary">Save channel settings</button></p>
</form>`;
}

function voiceBlock(csrf, manage) {
  const used = [...manage.voice].length;
  return `${msgLine(manage.profileMsg)}
<form method="post" action="/profile">
${csrfInput(csrf)}
<div class="field"><label for="f-voice">Reply voice</label><textarea name="voice" id="f-voice" rows="6" autocomplete="off">${esc(manage.voice)}</textarea><span class="hint">A short sample or description of how you write (up to 2000 characters). It is included in your prompts and is never forwarded with DMs. Do not put secrets here. Currently ${esc(used)} of 2000 characters.</span></div>
<p><button type="submit" class="btn-secondary">Save voice</button></p>
</form>`;
}

function fmtDate(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : 'never';
}

const fmtHuman = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const timeTag = (ms) => `<time datetime="${esc(new Date(ms).toISOString())}">${esc(fmtHuman(ms))}</time>`;

function copyRow(id, value, label) {
  return `<div class="field"><label for="${id}">${esc(label)}</label><input id="${id}" class="sel" type="text" readonly value="${esc(value)}" autocomplete="off"><p class="row"><button type="button" class="btn-secondary" data-copy="${id}" hidden>Copy</button></p></div>`;
}

function keysBlock(csrf, manage) {
  const list = manage.keys.length
    ? `<ul>${manage.keys
        .map(
          (k) => `<li>${esc(k.label || '(no label)')}, created ${esc(fmtDate(k.created))}, last used ${esc(fmtDate(k.last_used))}
<form method="post" action="/keys/revoke" style="display:inline">${csrfInput(csrf)}<input type="hidden" name="kid" value="${esc(k.kid)}"> <button type="submit" class="btn-danger">Revoke</button></form></li>`
        )
        .join('')}</ul>`
    : '<p>No active keys.</p>';
  const create = manage.destination
    ? `<form method="post" action="/keys/create">
${csrfInput(csrf)}
<div class="field"><label for="f-label">Label (optional, up to 40 characters)</label><input id="f-label" type="text" name="label" maxlength="40" autocomplete="off"></div>
<p><button type="submit" class="btn-secondary">Create assistant key</button></p>
</form>`
    : '<p class="muted small">Save a destination to create a labelled key, or use Set up with my assistant above.</p>';
  return `<p>A key lets your own assistant read and update these settings through a small API. Give the key and the spec URL to your assistant. The API can never turn send on, change the destination or create keys by itself; anything sensitive becomes a request that you approve here. You can have up to 2 active keys. Only a hash of each key is stored, and the key is shown once.</p>
${msgLine(manage.keysMsg)}
${list}
${create}`;
}

function assistantBlock(csrf, manage) {
  const canBootstrap = manage.keys.length < 2;
  return `<div class="banner b-info" role="status"><strong>Give this to your assistant</strong>
<p>Your assistant reads this address to learn how to set things up for you. It never contains your key.</p></div>
${copyRow('spec-url', manage.specUrl, 'Spec URL')}
${
  canBootstrap
    ? `<form method="post" action="/keys/bootstrap">${csrfInput(csrf)}<p class="row"><button type="submit" class="btn-primary">Set up with my assistant</button> <span class="muted small">Creates a key labelled "assistant" and shows it once. Your assistant then proposes changes and you approve the sensitive ones below.</span></p></form>`
    : '<p class="muted small">You already have 2 active keys. Revoke one under Assistant keys to create another.</p>'
}`;
}

function checklistBlock(csrf, manage) {
  const p = manage.progress;
  const items = [
    { done: true, t: 'Signed in with Slack', hint: 'You are signed in.' },
    {
      done: p.destination,
      t: 'Destination saved',
      hint: p.destination ? `${manage.destination.label} at ${manage.destination.host}.` : 'Pick where your DMs should go in <a href="#connection">Connection</a>, or let your assistant propose one.'
    },
    {
      done: p.testPassed,
      t: 'Test passed',
      hint: p.testPassed ? 'The relay reached your destination.' : p.destination ? 'Press Send test in <a href="#connection">Connection</a>.' : 'Save a destination first.'
    },
    {
      done: p.delivered,
      t: 'First real DM delivered',
      hint: p.delivered ? 'A real DM has been delivered.' : 'Waiting for a DM. Ask someone to message you, then check <a href="/status">status</a> after Slack sign-in.'
    }
  ];
  const doneCount = items.filter((i) => i.done).length;
  return `<section class="card" id="checklist"><h2>Setup checklist <span class="badge ${doneCount === items.length ? 'ok' : ''}">${doneCount} of ${items.length} done</span></h2>
<ol class="check">${items
    .map((i) => `<li><span><strong>${esc(i.t)}</strong><br><span class="muted small">${i.hint}</span></span><span class="badge ${i.done ? 'ok' : 'warn'}">${i.done ? 'Done' : 'To do'}</span></li>`)
    .join('')}</ol>
${assistantBlock(csrf, manage)}</section>`;
}

function capsBanner(caps) {
  const can = ['process', 'draft', 'send'].filter((k) => caps[k]);
  if (caps.send) {
    return banner('warning', `<strong>Your assistant can: ${can.join(', ')}.</strong><p>Send is on: your assistant can reply on your behalf, and a hostile DM could steer it. Turn it off below if you do not need it.</p>`);
  }
  return banner('info', `<strong>Your assistant can: ${can.length ? can.join(', ') : 'only tell you a DM arrived'}. It cannot send.</strong>`);
}

function requestForm(csrf, r) {
  const hid = `${csrfInput(csrf)}<input type="hidden" name="id" value="${esc(r.id)}">`;
  const reject = `<form method="post" action="/requests/reject">${hid}<button type="submit" class="btn-secondary">Reject</button></form>`;
  let detail;
  let approve;
  if (r.type === 'destination') {
    detail = `<p class="small">Only the type and host are shown. The full URL and the secret stay hidden. Approving verifies the destination, which can trigger one automation run.</p>`;
    approve = `<form method="post" action="/requests/approve">${hid}
<p><label class="inline" for="a-${esc(r.id)}"><input id="a-${esc(r.id)}" type="checkbox" name="attest" value="1" required> <span>I attest that model training on inputs is turned off for this destination account (for Cursor: privacy mode is on).</span></label></p>
<p><button type="submit" class="btn-primary">Approve</button></p></form>`;
  } else if (r.type === 'enable_send') {
    detail = banner('danger', `<strong>Strong warning.</strong><p>Approving lets your assistant reply to your DMs on your behalf. A hostile DM can steer an assistant that is allowed to send. Only approve if you asked for this.</p>`);
    approve = `<form method="post" action="/requests/approve">${hid}
<p><label class="inline" for="c-${esc(r.id)}"><input id="c-${esc(r.id)}" type="checkbox" name="confirm_send" value="1"> <span>I understand that a hostile DM could steer an assistant that is allowed to send.</span></label></p>
<div class="field"><label for="w-${esc(r.id)}">Type SEND to confirm</label><input id="w-${esc(r.id)}" type="text" name="send_word" autocomplete="off"></div>
<p><button type="submit" class="btn-danger">Approve and turn send on</button></p></form>`;
  } else if (r.type === 'enable_channels') {
    const ids = (r.detail && r.detail.allowlist) || [];
    detail = banner('warning', `<strong>Channel messages.</strong><p>Approving lets the relay forward public and private channel messages that mention you${ids.length ? ' and every message in these channels: ' + ids.map((i) => `<code>${esc(i)}</code>`).join(' ') : ''} to your destination. Private channel content becomes visible to the relay for your account. Shared channels with other workspaces are never forwarded.</p>`);
    approve = `<form method="post" action="/requests/approve">${hid}<p><button type="submit" class="btn-primary">Approve and turn channels on</button></p></form>`;
  } else {
    const ids = (r.detail && r.detail.user_ids) || [];
    detail = `<p class="small">These Slack user IDs would be added to your trusted senders: ${ids.map((i) => `<code>${esc(i)}</code>`).join(' ')}</p>`;
    approve = `<form method="post" action="/requests/approve">${hid}<p><button type="submit" class="btn-primary">Approve</button></p></form>`;
  }
  return `<div class="req${r.type === 'enable_send' ? ' danger' : ''}"><p><strong>${esc(r.summary)}</strong><br><span class="muted small">Expires ${timeTag(r.expires)}</span></p>${detail}<div class="row">${approve}${reject}</div></div>`;
}

const STATUS_BADGE = { pending: 'warn', approved: 'ok', rejected: 'bad', expired: '', cancelled: '' };

function requestsBlock(csrf, manage) {
  const pending = manage.requests.filter((r) => r.status === 'pending');
  const past = manage.requests.filter((r) => r.status !== 'pending');
  const msg = manage.requestMsg ? msgBanner(manage.requestMsg, manage.requestMsg.ok === false ? 'danger' : 'success') : '';
  const list = pending.length
    ? pending.map((r) => requestForm(csrf, r)).join('')
    : '<p>No requests are waiting. When your assistant proposes a change that needs your approval, it appears here.</p>';
  const history = past.length
    ? `<details class="sub"><summary>Earlier requests (${past.length})</summary><ul>${past.map((r) => `<li><span class="badge ${STATUS_BADGE[r.status] || ''}">${esc(r.status)}</span> ${esc(r.summary)}</li>`).join('')}</ul></details>`
    : '';
  return `${msg}<p class="muted small">Your assistant can propose changes, but only you can approve them. Nothing happens until you click Approve.</p>${list}${history}`;
}

function promptsBlock(manage) {
  const one = (p) => `<h3>${esc(p.label)}</h3>
<p><textarea id="prompt-${esc(p.id)}" readonly rows="12">${esc(p.text)}</textarea><br><button type="button" data-copy="prompt-${esc(p.id)}" hidden>Copy prompt</button></p>`;
  const main = manage.prompts.filter((p) => p.primary);
  const rest = manage.prompts.filter((p) => !p.primary);
  const others = rest.length
    ? `<details class="sub"><summary>${main.length ? 'Prompts for other destination types' : 'Prompts for each destination type'}</summary>${rest.map(one).join('')}</details>`
    : '';
  return `<p>Paste the prompt for your destination type into your own automation. It is generated from your current settings, so copy it again after you change capabilities, trusted senders or voice. Claude routines are not told who sent a DM, so their prompt embeds your trusted list and must be re-copied whenever that list changes.</p>
${main.map(one).join('\n')}${others}`;
}

function pendingBanner(n, href = '#requests') {
  return n > 0 ? banner('warning', `<strong>${n} request${n === 1 ? '' : 's'} from your assistant ${n === 1 ? 'is' : 'are'} waiting for your approval.</strong> <a href="${href}">Review ${n === 1 ? 'it' : 'them'}</a>`) : '';
}

export function destinationFormPage({ csrf, error, manage }) {
  const savedType = manage && manage.destination ? manage.destination.type : null;
  const sel = savedType === 'claude' ? 'claude_routine' : savedType === 'cursor' ? 'cursor' : 'grok';
  const errorBanner = error ? banner('danger', `<strong>${esc(error)}</strong>`) : '';
  if (!manage) {
    return htmlResponse('Destination', `<h1>Choose your destination</h1>${errorBanner}${card('connection', 'Connection', `<p>No destination is saved yet. Choose one below.</p>${destinationForm(csrf, sel, false)}`)}`, { status: error ? 400 : 200 });
  }
  const connection = `${savedDestinationBlock(csrf, manage)}${manage.destination ? `<details class="sub"><summary>Change destination</summary>${destinationForm(csrf, sel, true)}</details>` : destinationForm(csrf, sel, false)}`;
  const body = `<h1>Your DM Relay</h1>
${errorBanner}${pendingBanner(manage.requests.filter((r) => r.status === 'pending').length)}
${checklistBlock(csrf, manage)}
${capsBanner(manage.caps)}
${manage.destination ? fold('capabilities', 'Your assistant can...', capsBlock(csrf, manage), true) : ''}
${fold('connection', 'Connection', connection, true)}
${fold('requests', 'Pending requests from your assistant', requestsBlock(csrf, manage), manage.requests.some((r) => r.status === 'pending'))}
${fold('keys', 'Assistant keys', keysBlock(csrf, manage))}
${fold('filters', 'Filters and trusted senders', `${filtersBlock(csrf, manage)}${manage.destination ? trustedBlock(csrf, manage) : ''}`)}
${manage.destination ? fold('channels', 'Channels', channelsBlock(csrf, manage)) : ''}
${manage.destination ? fold('voice', 'Voice', voiceBlock(csrf, manage)) : ''}
${fold('prompts', 'Automation prompts', promptsBlock(manage))}`;
  return htmlResponse('Destination', body, { status: error ? 400 : 200, script: COPY_SCRIPT });
}

export function keyCreatedPage({ key, specUrl }) {
  const block = `DM Relay assistant key: ${key}\nSpec URL: ${specUrl}\nFetch the spec URL, then call GET /api/v1/setup with this key and follow next_step. Never post or send anything unless the user has approved Send.`;
  return htmlResponse(
    'Assistant key',
    `<h1>Your assistant key</h1>
${banner('warning', '<strong>This key is shown once and cannot be shown again.</strong><p>Copy it now. If you lose it, revoke it on /connect and create another.</p>')}
${card('', 'Give this to your assistant', `<p>Click in the box, press Ctrl+A then Ctrl+C (or select all and copy), and paste it into your assistant. It contains the key, the spec URL and what to do next.</p>
<div class="field"><label for="assist-block">Copy block</label><textarea id="assist-block" class="sel" readonly rows="5" autocomplete="off">${esc(block)}</textarea></div>
<div class="field"><label for="key-only">Key only</label><input id="key-only" class="sel" type="text" readonly value="${esc(key)}" autocomplete="off"></div>
<p class="muted small">Spec URL: <code>${esc(specUrl)}</code></p>`)}
<p>Go back to <a href="/connect">/connect</a> to manage your keys and approve requests.</p>`
  );
}

export function successPage() {
  return htmlResponse('Connected', `<h1>Connected</h1>${banner('success', '<strong>Your listener is active.</strong> You can close this tab.')}`);
}

function fmtTime(ms) {
  return new Date(ms).toISOString();
}

function chartBlock(hourly) {
  if (!Array.isArray(hourly) || hourly.length === 0) return '';
  const step = 30;
  const base = 140;
  const total = hourly.reduce((a, h) => ({ d: a.d + h.delivered, f: a.f + h.filtered, x: a.x + h.failed }), { d: 0, f: 0, x: 0 });
  const max = Math.max(1, ...hourly.map((h) => h.delivered + h.filtered + h.failed));
  const scale = (base - 8) / max;
  let bars = '';
  hourly.forEach((h, i) => {
    let y = base;
    for (const [cls, v] of [['bar-d', h.delivered], ['bar-f', h.filtered], ['bar-x', h.failed]]) {
      if (!v) continue;
      const ht = v * scale;
      y -= ht;
      bars += `<rect class="${cls}" x="${i * step + 3}" y="${y.toFixed(1)}" width="24" height="${ht.toFixed(1)}" rx="2"/>`;
    }
  });
  const hh = (t) => String(new Date(t).getUTCHours()).padStart(2, '0');
  const labels = [0, 6, 12, 18, hourly.length - 1]
    .filter((i, n, a) => i < hourly.length && a.indexOf(i) === n)
    .map((i) => `<text class="ax" x="${i * step + 15}" y="158" text-anchor="middle">${hh(hourly[i].t)}:00</text>`)
    .join('');
  const busiest = hourly.reduce((a, h) => (h.delivered + h.filtered + h.failed > a.delivered + a.filtered + a.failed ? h : a), hourly[0]);
  const busyTotal = busiest.delivered + busiest.filtered + busiest.failed;
  const summary = `Last 24 hours: ${total.d} delivered, ${total.f} filtered, ${total.x} failed.${busyTotal ? ` Busiest hour ${hh(busiest.t)}:00 UTC with ${busyTotal}.` : ' No activity yet.'}`;
  const rows = hourly
    .filter((h) => h.delivered + h.filtered + h.failed > 0)
    .map((h) => `<tr><td>${esc(hh(h.t))}:00</td><td>${esc(h.delivered)}</td><td>${esc(h.filtered)}</td><td>${esc(h.failed)}</td></tr>`)
    .join('');
  const table = rows
    ? `<details class="sub"><summary>Show the data as a table</summary><div class="tw"><table><thead><tr><th scope="col">Hour (UTC)</th><th scope="col">Delivered</th><th scope="col">Filtered</th><th scope="col">Failed</th></tr></thead><tbody>${rows}</tbody></table></div></details>`
    : '';
  return `<svg class="chart" viewBox="0 0 720 166" role="img" aria-label="${esc(`Deliveries per hour for the last 24 hours. ${summary}`)}"><line class="axis" x1="0" x2="720" y1="140.5" y2="140.5"/>${bars}${labels}</svg>
<p class="legend"><span><span class="sw d"></span>Delivered</span><span><span class="sw f"></span>Filtered</span><span><span class="sw x"></span>Failed</span></p>
<p>${esc(summary)}</p>${table}`;
}

function summaryBlock(s) {
  const dests = s.destinations.length ? s.destinations.map((d) => `${esc(d.label)} (${esc(d.host)})`).join(', ') : 'none';
  const last = s.lastDelivery ? `${esc(fmtTime(s.lastDelivery.t))}, ${esc(s.lastDelivery.d)}, ${esc(s.lastDelivery.o)}` : 'none yet';
  const f = s.filtered;
  const filtered = f.bot + f.sender + f.keyword;
  const pill = (o) => `<span class="badge ${o === 'ok' ? 'ok' : 'bad'}">${esc(o)}</span>`;
  const log = s.deliveries.length
    ? `${card('', 'Recent deliveries', `<p class="muted small">The last ${s.deliveries.length} delivery events. Times, destination types and outcomes only; no message content, channel or sender.</p>
<div class="tw"><table><thead><tr><th scope="col">Time</th><th scope="col">Destination</th><th scope="col">Outcome</th><th scope="col">Kind</th></tr></thead><tbody>${s.deliveries
        .map((d) => `<tr><td>${timeTag(d.t)}</td><td>${esc(d.d)}</td><td>${pill(d.o)}</td><td>${d.test ? 'Test' : 'Real'}</td></tr>`)
        .join('')}</tbody></table></div>`)}`
    : card('', 'Recent deliveries', '<p>No deliveries yet.</p>');
  const changes = s.changes
    ? s.changes.length
      ? card('', 'Recent settings changes', `<p class="muted small">Which settings changed, when and where. Never the values.</p><ul>${s.changes.map((c) => `<li>${timeTag(c.t)} via ${esc(c.via)}: ${esc(c.fields.join(', '))}</li>`).join('')}</ul>`)
      : card('', 'Recent settings changes', '<p>No changes yet.</p>')
    : '';
  return `${pendingBanner(s.pendingRequests || 0, '/connect')}${card('', 'Summary', `<ul>
<li>Connected: ${s.connected ? 'yes' : 'no'}</li>
<li>Destinations: ${dests}</li>
<li>Last delivery: ${last}</li>
<li>Last 24 hours: ${esc(s.last24h.delivered)} delivered, ${esc(filtered)} filtered, ${esc(s.last24h.failed)} failed</li>
</ul>`)}${s.hourly && s.hourly.length ? card('', 'Last 24 hours', chartBlock(s.hourly)) : ''}${log}${changes}`;
}

export function statusPage({ counters, lastNudge, showNudge = false, summary = null, notice = null }) {
  const rows = Object.entries(counters).map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join('');
  const filteredRows = summary ? Object.entries(summary.filtered).map(([k, v]) => `<li>filtered_${esc(k)}: ${esc(v)}</li>`).join('') : '';
  const nudge = showNudge ? `<p>Last nudge: ${lastNudge ? esc(fmtTime(lastNudge)) : 'never'}</p>` : '';
  const head = summary ? summaryBlock(summary) : '';
  const note = notice ? banner(notice.kind || 'success', `<strong>${esc(notice.text)}</strong>`) : '';
  return htmlResponse(
    'Status',
    `<h1>Your status</h1>${note}${head}${nudge}<div class="card"><details><summary>Raw counters (all-time, for debugging)</summary><ul>${rows}${filteredRows}</ul></details></div>`
  );
}

export function disconnectConfirmPage({ csrf }) {
  return htmlResponse(
    'Confirm disconnect',
    `<h1>Confirm disconnect</h1>${card('', 'Disconnect DM Relay?', `<p>This revokes the app's access to your DMs and removes your destination.</p><form method="post" action="/disconnect/confirm">${csrfInput(csrf)}<button type="submit" class="btn-danger">Disconnect</button></form>`)}`
  );
}

export function disconnectedPage({ revoked }) {
  return htmlResponse(
    'Disconnected',
    `<h1>Disconnected</h1>${banner(revoked ? 'success' : 'warning', `<strong>${revoked ? 'Slack access was revoked.' : 'Your destination was removed, but Slack access could not be revoked automatically. Remove the app in Slack to finish.'}</strong> Forwarding can continue for up to about 60 seconds.`)}<p><a class="btn btn-secondary" href="/connect">Connect again</a></p>`
  );
}

export function messagePage(title, message, status = 400, cookies = []) {
  const link = status === 404 ? '<a class="btn btn-secondary" href="/connect">Go to DM Relay</a>' : '<a class="btn btn-primary" href="/connect">Start again</a>';
  return htmlResponse(title, `<h1>${esc(title)}</h1>${banner(status >= 500 ? 'danger' : 'warning', `<p>${esc(message)}</p>`)}<p>${link}</p>`, { status, cookies });
}
