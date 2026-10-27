export async function wipeUser(deps, userId) {
  try {
    const { hashes } = await deps.userDo(userId).keyHashes();
    for (const h of hashes) await deps.kv.delete(`apikey:${h}`);
  } catch {
    /* a key whose KV entry is left behind fails the Durable Object check once the user is wiped */
  }
  await deps.routing.delete(userId);
  await deps.userDo(userId).wipe();
}
