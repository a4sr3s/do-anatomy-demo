import { createHash } from 'node:crypto';

/**
 * Tiny dependency-free "embedding": hashed bag-of-words with sign hashing,
 * L2-normalised. Good enough for a demo store so that asking about a fact you
 * just submitted really retrieves it. Also used in real mode when no hosted
 * embedding model is configured.
 */
export const LOCAL_DIM = 128;

const STOP = new Set(
  'a an and are as at be by for from has have in is it its of on or that the to was were will with what who when where why how does do did which this these those tell me about'.split(' ')
);

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));
}

export function embedLocal(text, dim = LOCAL_DIM) {
  const v = new Array(dim).fill(0);
  const toks = tokenize(text);
  const add = (tok, weight) => {
    const h = createHash('sha1').update(tok).digest();
    const idx = h.readUInt32BE(0) % dim;
    const sign = h[4] & 1 ? 1 : -1;
    v[idx] += sign * weight;
  };
  toks.forEach((t) => add(t, 1));
  for (let i = 0; i < toks.length - 1; i++) add(`${toks[i]}_${toks[i + 1]}`, 0.5);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // inputs are unit vectors
}

/** Split text into roughly sentence-aligned chunks of <= maxLen chars. */
export function chunkText(text, maxLen = 220) {
  const sentences = String(text).replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*\s*/g) || [String(text)];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if ((cur + s).length > maxLen && cur) {
      chunks.push(cur.trim());
      cur = s;
    } else cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}
