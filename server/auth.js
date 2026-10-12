import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time shared-secret check used by the internal tool-event endpoint
 * (web) and the MCP server's bearer auth. With `bearer: true` a leading
 * "Bearer " prefix is stripped first, so both the raw token and the
 * Authorization-header form are accepted.
 */
export function tokenEquals(given, expected, { bearer = false } = {}) {
  if (!expected || typeof given !== 'string') return false;
  const value = (bearer ? given.replace(/^Bearer\s+/i, '') : given).trim();
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
