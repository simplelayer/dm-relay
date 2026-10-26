import { WAIT_UNTIL_BUDGET_MS } from './constants.js';
import { forwardCursor, forwardGrok } from './destinations.js';
import { buildForwardPayload, checkEnvelope, filterMessageEvent } from './filter.js';
import { resolveRecipients } from './fanout.js';
import { isUserId } from './routes.js';
import { verifySlackSignature } from './slack-verify.js';

function textResponse(body, status) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function deliver(recipient, payload, deps, deadlineMs) {
  const { userId, entry } = recipient;
  const userDo = deps.userDo(userId);
  try {
    if ((await userDo.check()).disconnected) {
      await userDo.increment({ name: 'dropped' });
      return;
    }
    if (entry.dest_type === 'claude_routine') {
      await userDo.noteActivity({ userId, channelId: payload.event.channel, ts: payload.event.ts });
      return;
    }
    if (entry.dest_type !== 'grok' && entry.dest_type !== 'cursor') {
      await userDo.increment({ name: 'dropped' });
      return;
    }
    const forward = entry.dest_type === 'cursor' ? forwardCursor : forwardGrok;
    const result = await forward({
      entry,
      forwardPayload: buildForwardPayload(payload, deps.now()),
      recipientId: userId,
      fetchImpl: deps.fetchImpl,
      now: deps.now,
      deadlineMs,
      validateOpts: deps.validateOpts
    });
    if (result.kind === 'ok') await userDo.increment({ name: 'forwarded' });
    else if (result.kind === 'invalid') await userDo.increment({ name: 'dropped' });
    else await userDo.increment({ name: 'errors' });
  } catch {
    console.error('E_DELIVER');
  }
}

async function handleRevocation(event, deps) {
  if (event.type === 'tokens_revoked') {
    const ids = Array.isArray(event.tokens && event.tokens.oauth) ? event.tokens.oauth : [];
    for (const id of ids) {
      if (!isUserId(id)) continue;
      await deps.routing.delete(id);
      await deps.userDo(id).wipe();
    }
  } else if (event.type === 'app_uninstalled') {
    for (const id of await deps.routing.listIds()) {
      await deps.routing.delete(id);
      await deps.userDo(id).wipe();
    }
  }
}

export async function processEvent(payload, deps) {
  const startMs = deps.now();
  const event = payload.event;
  if (event && (event.type === 'tokens_revoked' || event.type === 'app_uninstalled')) {
    await handleRevocation(event, deps);
    return;
  }
  if (!filterMessageEvent(payload).forward) return;

  const { recipients, degraded } = await resolveRecipients({
    payload,
    routing: deps.routing,
    routedSample: deps.routedSample,
    nowMs: startMs,
    appToken: deps.config.appToken,
    fetchImpl: deps.fetchImpl
  });
  if (degraded) {
    await Promise.allSettled(recipients.map((r) => deps.userDo(r.userId).increment({ name: 'fanout_degraded' })));
  }
  const deadlineMs = startMs + WAIT_UNTIL_BUDGET_MS;
  await Promise.allSettled(recipients.map((r) => deliver(r, payload, deps, deadlineMs)));
}

export async function handleSlackEvents(request, deps, waitUntil) {
  const rawBody = new Uint8Array(await request.arrayBuffer());
  const ok = await verifySlackSignature({
    signingSecret: deps.config.signingSecret,
    timestamp: request.headers.get('x-slack-request-timestamp'),
    signature: request.headers.get('x-slack-signature'),
    rawBody,
    nowSeconds: Math.floor(deps.now() / 1000)
  });
  if (!ok) {
    console.error('E_SIG');
    return textResponse('invalid signature', 401);
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    console.error('E_BODY');
    return textResponse('bad request', 400);
  }
  if (!payload || typeof payload !== 'object') return textResponse('bad request', 400);

  if (payload.type === 'url_verification') {
    return new Response(JSON.stringify({ challenge: String(payload.challenge ?? '') }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  }
  if (!checkEnvelope(payload, { teamId: deps.config.teamId, appId: deps.config.appId })) {
    console.error('E_ENVELOPE');
    return textResponse('ok', 200);
  }
  if (payload.type === 'app_rate_limited') {
    console.error('E_APP_RATE_LIMITED');
    return textResponse('ok', 200);
  }
  if (payload.type === 'event_callback') {
    waitUntil(
      processEvent(payload, deps).catch(() => {
        console.error('E_PROCESS');
      })
    );
  }
  return textResponse('ok', 200);
}
