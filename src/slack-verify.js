import { SLACK_TIMESTAMP_WINDOW_S } from './constants.js';
import { concatBytes, hmacSha256, timingSafeEqual, toHex, utf8 } from './util.js';

export async function verifySlackSignature({ signingSecret, timestamp, signature, rawBody, nowSeconds }) {
  if (!signingSecret || !timestamp || !signature || !(rawBody instanceof Uint8Array)) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > SLACK_TIMESTAMP_WINDOW_S) return false;
  const base = concatBytes(utf8(`v0:${timestamp}:`), rawBody);
  const mac = await hmacSha256(utf8(signingSecret), base);
  return timingSafeEqual(utf8(`v0=${toHex(mac)}`), utf8(signature));
}
