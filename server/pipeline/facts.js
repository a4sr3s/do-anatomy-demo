/**
 * Fact identity shared by both pipelines. A fact is one Spaces object
 * (`facts/<timestamp>-<job>.txt`) plus the pgvector rows whose `object_key`
 * points at it. The public fact id is the key's basename so it travels cleanly
 * in a URL path; a full key (or anything else) is accepted as an id too.
 */
const PREFIX = 'facts/';
const SUFFIX = '.txt';

/** `facts/1760-abcd.txt` -> `1760-abcd` */
export function factId(key) {
  let id = String(key || '');
  if (id.startsWith(PREFIX)) id = id.slice(PREFIX.length);
  if (id.endsWith(SUFFIX)) id = id.slice(0, -SUFFIX.length);
  return id;
}

/** `1760-abcd` -> `facts/1760-abcd.txt`; a value that already looks like a key is returned unchanged. */
export function factKey(id) {
  const s = String(id || '').trim();
  if (!s) return '';
  if (s.includes('/') || s.endsWith(SUFFIX)) return s;
  return `${PREFIX}${s}${SUFFIX}`;
}

export function notFound(id) {
  return Object.assign(new Error(`fact not found: ${id}`), { status: 404 });
}
