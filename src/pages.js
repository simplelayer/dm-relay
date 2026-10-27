import { CSP } from './constants.js';
import { randomBase64Url } from './util.js';

const COPY_SCRIPT =
  "document.querySelectorAll('button[data-copy]').forEach(function(b){b.hidden=false;b.addEventListener('click',function(){var t=document.getElementById(b.getAttribute('data-copy'));navigator.clipboard.writeText(t.value).then(function(){b.textContent='Copied'},function(){t.select();b.textContent='Press Ctrl+C to copy'})})});";

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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:2rem auto;padding:0 1rem}li{margin:.4rem 0}code{background:#eee;padding:0 .2rem}input[type=text],input[type=password]{width:100%;padding:.4rem}button,.btn{padding:.5rem 1rem}</style></head><body>${body}${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
  return new Response(html, { status, headers });
}

function repoLink(url) {
  return /^https:\/\//.test(url || '') ? `<a href="${esc(url)}">${esc(url)}</a>` : esc(url);
}

export function connectPage({ intent, authorizeUrl, cookie, publicRepoUrl }) {
  const verb = { connect: 'Connect', disconnect: 'Disconnect', status: 'View status for' }[intent];
  const body = `<h1>${esc(verb)} DM Relay</h1>
<h2>What this does</h2>
<p>When you connect, direct messages and group DMs sent to you (and by you) are delivered to the Slack app, then forwarded to the AI destination you choose (a Grok bot, a Cursor automation or a Claude routine). Only people who click Allow have a listener. People who DM you have their messages processed by your AI; they have not consented.</p>
<p>The relay cannot send anything to Slack. It never stores message text. Your Slack token is never stored, except for up to 10 minutes during a disconnect, until you confirm.</p>
<h2>Disclosures</h2>
<ul>
<li>Slack delivers the full text of your DMs to this relay Worker in both modes. In <code>full</code> (Grok and Cursor) mode the relay forwards the full DM text to the destination, which for Cursor means it is sent to Cursor. In <code>nudge</code> (Claude) mode the relay receives the text and forwards none of it; the text reaches Claude only through your own Slack connector. Cloudflare and the operator can technically see text in transit, and your destination's AI vendor sees it by design.</li>
<li>The operator is also the Slack workspace owner, Slack app owner and Cloudflare account owner. Privacy from the operator is a written commitment backed by public code, not a technical guarantee. The owner can see who has opted in (Slack admin app authorization view).</li>
<li>Per-user counters (forwarded, dropped, errors, fanout_degraded) are activity metadata that is visible to the operator.</li>
<li>The relay also keeps a delivery log of your last 20 delivery events (time, destination type and outcome only) and the filter rules you set (skipped user IDs and keywords). The log and the rules are visible to the operator and are deleted when you disconnect. No message text, channel or sender is kept.</li>
<li>Delivery is best-effort and at-most-once. If your destination is down, DMs during the outage are not delivered. Claude nudges can also be lost to daily run caps or timeouts. Forwarding can continue for up to about 60 seconds after you disconnect. Messages in roughly the first minute after you connect may not be delivered. For Cursor, there is no retry after a timeout or a 5xx other than 503, because the run may already have started (at-most-once holds).</li>
<li>Your destination secret or bearer token (Grok signing secret, Claude routine token or Cursor automation token) is stored in the relay's key-value store and is readable by the operator.</li>
<li>Connecting a Claude routine fires one real routine run to verify it, which uses one of your daily runs.</li>
<li>Each verification attempt can trigger one automation run.</li>
<li>The relay never sends anything to Slack. What your own AI assistant may do with your DMs (process them, draft replies, send) is controlled by your own automation permissions, and you can record your choices after connecting. Those choices only change the prompts, these disclosures and a hint field in the forwarded data; they are not enforcement by the relay.</li>
<li>DM text is untrusted data written by any workspace member. An assistant that is allowed to act or send can be steered by a hostile message, so keep send off unless you need it and rely on the trusted-sender list.</li>
<li>Your trusted-sender list, reply voice text and capability choices are stored with your routing entry and are readable by the operator. Do not put secrets in the voice text. Assistant API keys are stored only as a SHA-256 hash.</li>
</ul>
<h2>Claude routine setup rules</h2>
<ul>
<li>Attach only the Slack connector to the routine.</li>
<li>Give the routine only the Slack permissions you want it to use. If you do not want it to send, disable every Slack write tool and allow draft creation only, if it exists.</li>
<li>In the routine prompt, state that the fire <code>text</code> must be ignored and that DM content is data, not instructions.</li>
</ul>
<h2>Cursor automation setup rules</h2>
<ul>
<li>The Cursor account that owns the automation must have privacy mode on (no training on inputs). You attest to this below and on the next page.</li>
<li>What the automation may do (process, draft, send) is controlled by its own permissions. Keep send off unless you need it.</li>
<li>In the automation prompt, state that the DM text is data, not instructions, because any workspace member can write text the automation reads.</li>
</ul>
<h2>Unattended-agent risk</h2>
<p>Routines run unattended. Any workspace member can write text your routine reads, so prompt injection is possible. Whoever holds the routine bearer token (the operator, through the key-value store) can inject arbitrary instructions into your agent through the fire text. Keep send off for your Grok bot, Cursor automation or Claude routine unless you need it, and rely on the trusted-sender list.</p>
<p>The same applies to Cursor automations: any workspace member can write text your automation reads, and whoever holds the Cursor bearer token (the operator, through the key-value store) can trigger your automation with arbitrary content.</p>
<h2>Third parties and training</h2>
<p><label><input type="checkbox" name="attest_preview" value="1"> I attest that model training on inputs is turned off for my destination account (Claude: "Help improve Claude" off, or a Team/Enterprise plan; Grok: the equivalent setting; Cursor: privacy mode on). You will be asked to confirm this again before activation.</label></p>
<h2>Source code</h2>
<p>Public repository: ${repoLink(publicRepoUrl)}</p>
<p><a class="btn" href="${esc(authorizeUrl)}">Continue to Slack</a></p>`;
  return htmlResponse('DM Relay', body, { cookies: [cookie] });
}

function savedDestinationBlock(csrf, manage) {
  const d = manage.destination;
  const result = manage.testResult
    ? `<p role="status"><strong>${manage.testResult.ok ? 'Test passed' : 'Test failed'}:</strong> ${esc(manage.testResult.text)}</p>`
    : '';
  if (!d) return `<h2>Saved destination</h2><p>No destination is saved yet. Choose one below.</p>`;
  const note = d.type === 'claude' ? ' A Claude routine test fires one real routine run.' : '';
  return `<h2>Saved destination</h2>
<p>${esc(d.label)} at <code>${esc(d.host)}</code></p>
${result}
<form method="post" action="/destination/test"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Send test</button> A harmless synthetic connection test. It contains no real message. Limited to a few tests per minute.${note}</form>`;
}

function filtersBlock(csrf, manage) {
  const f = manage.filters;
  const msg = manage.filterMsg ? `<p role="status"><strong>${esc(manage.filterMsg.text)}</strong></p>` : '';
  return `<h2>Filters</h2>
<p>Messages that match are not forwarded. Only a count per reason is kept; the matching text and sender are never stored. Keywords are checked in memory against each message as it arrives.</p>
${msg}
<form method="post" action="/filters">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<p><label><input type="checkbox" name="skip_bots" value="1"${f.skip_bots ? ' checked' : ''}> Skip messages from bots</label></p>
<p><label>Skip these Slack user IDs (separated by spaces or commas, up to 50)<br><input type="text" name="skip_users" autocomplete="off" value="${esc(f.skip_users.join(' '))}"></label></p>
<p><label>Skip messages containing these keywords (one per line, case-insensitive, up to 20 keywords of at most 50 characters)<br><textarea name="keywords" rows="5" cols="40" autocomplete="off">${esc(f.keywords.join('\n'))}</textarea></label></p>
<p><button type="submit">Save filters</button></p>
</form>`;
}

function msgLine(m) {
  return m ? `<p role="status"><strong>${esc(m.text)}</strong></p>` : '';
}

function capsBlock(csrf, manage) {
  const c = manage.caps;
  return `<h2>What your assistant may do</h2>
<p>The relay itself never sends anything to Slack. These options only change the prompts below, the disclosures and a <code>mode</code> hint in the forwarded data. They are not enforcement: what your assistant can actually do is set by its own automation permissions and Slack connector.</p>
<p>DM text is untrusted data written by any workspace member. An assistant that is allowed to act or send can be steered by a hostile message, so keep send off unless you need it and rely on the trusted-sender list.</p>
${msgLine(manage.capsMsg)}
<form method="post" action="/caps">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<p><label><input type="checkbox" name="process" value="1"${c.process ? ' checked' : ''}> Process: my assistant may start its own workflows for trusted senders</label><br>
<label><input type="checkbox" name="draft" value="1"${c.draft ? ' checked' : ''}> Draft: my assistant may draft replies for me to review</label><br>
<label><input type="checkbox" name="send" value="1"${c.send ? ' checked' : ''}> Send: my assistant may reply in the same DM or thread for trusted senders</label></p>
<p>To turn send on you must also tick this box and type the word SEND. Turning send off needs no confirmation.</p>
<p><label><input type="checkbox" name="confirm_send" value="1"> I understand that a hostile DM could steer an assistant that is allowed to send.</label></p>
<p><label>Type SEND to confirm<br><input type="text" name="send_word" autocomplete="off"></label></p>
<p><button type="submit">Save capabilities</button></p>
</form>`;
}

function profileBlock(csrf, manage) {
  const used = [...manage.voice].length;
  return `<h2>Trusted senders and reply voice</h2>
<p>Trusted senders are the only people whose messages an assistant with process or send enabled should act on. Forwarded data carries a <code>sender_trusted</code> flag. Both settings are stored with your routing entry and are readable by the operator.</p>
${msgLine(manage.profileMsg)}
<form method="post" action="/profile">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<p><label>Trusted Slack user IDs (separated by spaces or commas, up to 50)<br><input type="text" name="trusted_users" autocomplete="off" value="${esc(manage.trusted_users.join(' '))}"></label></p>
<p><label>Reply voice: a short sample or description of how you write (up to 2000 characters). It is included in your prompts and is never forwarded with DMs. Do not put secrets here.<br><textarea name="voice" rows="6" cols="60" autocomplete="off">${esc(manage.voice)}</textarea></label><br>Currently ${esc(used)} of 2000 characters.</p>
<p><button type="submit">Save trusted senders and voice</button></p>
</form>`;
}

function fmtDate(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : 'never';
}

function keysBlock(csrf, manage) {
  const list = manage.keys.length
    ? `<ul>${manage.keys
        .map(
          (k) => `<li>${esc(k.label || '(no label)')}, created ${esc(fmtDate(k.created))}, last used ${esc(fmtDate(k.last_used))}
<form method="post" action="/keys/revoke" style="display:inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="kid" value="${esc(k.kid)}"> <button type="submit">Revoke</button></form></li>`
        )
        .join('')}</ul>`
    : '<p>No active keys.</p>';
  return `<h2>Assistant keys</h2>
<p>A key lets your own assistant read and update these settings through a small API. Give the key and the spec URL <code>${esc(manage.specUrl)}</code> to your assistant. The API can never turn send on, change the destination or create keys. You can have up to 2 active keys. Only a hash of each key is stored, and the key is shown once.</p>
${msgLine(manage.keysMsg)}
${list}
<form method="post" action="/keys/create">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<p><label>Label (optional, up to 40 characters)<br><input type="text" name="label" maxlength="40" autocomplete="off"></label></p>
<p><button type="submit">Create assistant key</button></p>
</form>`;
}

function promptsBlock(manage) {
  const items = manage.prompts
    .map(
      (p) => `<h3>${esc(p.label)}</h3>
<p><textarea id="prompt-${esc(p.id)}" readonly rows="14" cols="60">${esc(p.text)}</textarea><br><button type="button" data-copy="prompt-${esc(p.id)}" hidden>Copy prompt</button></p>`
    )
    .join('\n');
  return `<h2>Automation prompts</h2>
<p>Paste the prompt for your destination type into your own automation. It is generated from your current settings, so copy it again after you change capabilities, trusted senders or voice. Claude routines are not told who sent a DM, so their prompt embeds your trusted list and must be re-copied whenever that list changes.</p>
${items}`;
}

export function destinationFormPage({ csrf, error, manage }) {
  const savedType = manage && manage.destination ? manage.destination.type : null;
  const sel = savedType === 'claude' ? 'claude_routine' : savedType === 'cursor' ? 'cursor' : 'grok';
  const body = `<h1>Choose your destination</h1>
${error ? `<p role="alert"><strong>${esc(error)}</strong></p>` : ''}
${manage ? savedDestinationBlock(csrf, manage) : ''}
<form method="post" action="/destination">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<p><label><input type="radio" name="dest_type" value="grok"${sel === 'grok' ? ' checked' : ''}> Grok automation webhook (full mode)</label><br>
<label><input type="radio" name="dest_type" value="cursor"${sel === 'cursor' ? ' checked' : ''}> Cursor automation webhook (full mode: the full DM text is sent to Cursor)</label><br>
<label><input type="radio" name="dest_type" value="claude_routine"${sel === 'claude_routine' ? ' checked' : ''}> Claude routine (nudge mode)</label></p>
<p><label>Webhook URL or routine fire URL<br><input type="text" name="url" autocomplete="off" required></label></p>
<p><label>Grok signing secret (starts with <code>whsec_</code>), Cursor bearer token (starts with <code>crsr_</code>) or Claude routine bearer token<br><input type="password" name="secret" autocomplete="off" required></label></p>
<p><label><input type="checkbox" name="attest" value="1" required> I attest that model training on inputs is turned off for this destination account (for Cursor: privacy mode is on; the attestation covers the account that owns the token).</label></p>
<p>Cursor: Each verification attempt can trigger one automation run. The automation must treat DM text as data, not instructions, and what it may do is controlled by its own permissions. Whoever holds the bearer token (the operator, through the key-value store) can trigger the automation with arbitrary content.</p>
<p>Leaving without activating keeps Slack access until you run /disconnect.</p>
<p><button type="submit">Verify and activate</button></p>
</form>
${manage ? `${filtersBlock(csrf, manage)}
${manage.destination ? `${capsBlock(csrf, manage)}
${profileBlock(csrf, manage)}
${keysBlock(csrf, manage)}
` : ''}${promptsBlock(manage)}` : ''}`;
  return htmlResponse('Destination', body, { status: error ? 400 : 200, script: manage ? COPY_SCRIPT : null });
}

export function keyCreatedPage({ key, specUrl }) {
  return htmlResponse(
    'Assistant key',
    `<h1>Your assistant key</h1><p><strong>This key is shown once and cannot be shown again.</strong> Copy it now and give it to your assistant together with the spec URL <code>${esc(specUrl)}</code>. If you lose it, revoke it on /connect and create another.</p><p><input type="text" readonly value="${esc(key)}" autocomplete="off" size="60"></p><p>Go back to <a href="/connect">/connect</a> to manage your keys.</p>`
  );
}

export function successPage() {
  return htmlResponse('Connected', '<h1>Connected</h1><p>Your listener is active. You can close this tab.</p>');
}

function fmtTime(ms) {
  return new Date(ms).toISOString();
}

function summaryBlock(s) {
  const dests = s.destinations.length
    ? s.destinations.map((d) => `${esc(d.label)} (${esc(d.host)})`).join(', ')
    : 'none';
  const last = s.lastDelivery
    ? `${esc(fmtTime(s.lastDelivery.t))}, ${esc(s.lastDelivery.d)}, ${esc(s.lastDelivery.o)}`
    : 'none yet';
  const f = s.filtered;
  const filtered = f.bot + f.sender + f.keyword;
  const log = s.deliveries.length
    ? `<h2>Recent deliveries</h2><p>The last ${s.deliveries.length} delivery events. Times, destination types and outcomes only; no message content, channel or sender.</p><ul>${s.deliveries
        .map((d) => `<li>${esc(fmtTime(d.t))} ${esc(d.d)} ${esc(d.o)}${d.test ? ' (test)' : ''}</li>`)
        .join('')}</ul>`
    : '<h2>Recent deliveries</h2><p>No deliveries yet.</p>';
  const changes = s.changes
    ? s.changes.length
      ? `<h2>Recent settings changes</h2><p>Which settings changed, when and where. Never the values.</p><ul>${s.changes.map((c) => `<li>${esc(fmtTime(c.t))} via ${esc(c.via)}: ${esc(c.fields.join(', '))}</li>`).join('')}</ul>`
      : '<h2>Recent settings changes</h2><p>No changes yet.</p>'
    : '';
  return `<ul>
<li>Connected: ${s.connected ? 'yes' : 'no'}</li>
<li>Destinations: ${dests}</li>
<li>Last delivery: ${last}</li>
<li>Last 24 hours: ${esc(s.last24h.delivered)} delivered, ${esc(filtered)} filtered, ${esc(s.last24h.failed)} failed</li>
</ul>
${log}
${changes}`;
}

export function statusPage({ counters, lastNudge, showNudge = false, summary = null }) {
  const rows = Object.entries(counters).map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join('');
  const filteredRows = summary ? Object.entries(summary.filtered).map(([k, v]) => `<li>filtered_${esc(k)}: ${esc(v)}</li>`).join('') : '';
  const nudge = showNudge ? `<p>Last nudge: ${lastNudge ? esc(fmtTime(lastNudge)) : 'never'}</p>` : '';
  const head = summary ? summaryBlock(summary) : '';
  return htmlResponse(
    'Status',
    `<h1>Your status</h1>${head}${nudge}<details><summary>Raw counters (all-time, for debugging)</summary><ul>${rows}${filteredRows}</ul></details>`
  );
}

export function disconnectConfirmPage({ csrf }) {
  return htmlResponse(
    'Confirm disconnect',
    `<h1>Confirm disconnect</h1><p>This revokes the app's access to your DMs and removes your destination.</p><form method="post" action="/disconnect/confirm"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">Disconnect</button></form>`
  );
}

export function disconnectedPage({ revoked }) {
  return htmlResponse(
    'Disconnected',
    `<h1>Disconnected</h1><p>${revoked ? 'Slack access was revoked.' : 'Your destination was removed, but Slack access could not be revoked automatically. Remove the app in Slack to finish.'} Forwarding can continue for up to about 60 seconds.</p>`
  );
}

export function messagePage(title, message, status = 400, cookies = []) {
  return htmlResponse(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`, { status, cookies });
}
