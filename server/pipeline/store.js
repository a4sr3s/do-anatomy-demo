import { cosine, embedLocal } from './embedding.js';

/** In-memory vector store standing in for pgvector in mock mode. */
export class MemoryVectorStore {
  constructor() {
    this.rows = [];
    this.nextId = 1;
  }
  get size() {
    return this.rows.length;
  }
  insert(chunk, embedding, meta = {}) {
    const row = { id: this.nextId++, chunk, embedding, meta, createdAt: Date.now() };
    this.rows.push(row);
    return row;
  }
  search(embedding, k = 3) {
    return this.rows
      .map((r) => ({ id: r.id, chunk: r.chunk, meta: r.meta, score: cosine(embedding, r.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
  searchText(text, k = 3) {
    return this.search(embedLocal(text), k);
  }
  /** Remove every row whose meta.key matches; returns the removed row ids (ascending). */
  removeByKey(key) {
    const ids = [];
    this.rows = this.rows.filter((r) => {
      if (r.meta?.key !== key) return true;
      ids.push(r.id);
      return false;
    });
    return ids;
  }
  idsForKey(key) {
    return this.rows.filter((r) => r.meta?.key === key).map((r) => r.id);
  }
  clear() {
    const ids = this.rows.map((r) => r.id);
    this.rows = [];
    return ids;
  }
}
