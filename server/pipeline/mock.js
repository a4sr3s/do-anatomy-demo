import { randomUUID } from 'node:crypto';
import { sleep } from '../bus.js';
import { chunkText, embedLocal } from './embedding.js';
import { MemoryVectorStore } from './store.js';

/**
 * Mock pipeline: simulates every DigitalOcean stage with realistic timing and
 * emits the same events the real pipeline does. Needs no credentials.
 */
export class MockPipeline {
  constructor(bus, { delayScale = 1 } = {}) {
    this.bus = bus;
    this.delayScale = Number.isFinite(delayScale) ? delayScale : 1;
    this.store = new MemoryVectorStore();
    this.mode = 'mock';
  }

  wait(ms) {
    return this.delayScale > 0 ? sleep(ms * this.delayScale) : Promise.resolve();
  }

  describe() {
    return { mode: this.mode, chunks: this.store.size, delayScale: this.delayScale };
  }

  async submitFact(text) {
    const jobId = randomUUID();
    const ev = this.bus.forJob(jobId, 'ingest');
    ev.job('start', { input: text });

    // 1. Spaces: object upload
    const key = `facts/${Date.now()}-${jobId.slice(0, 8)}.txt`;
    ev.stage('spaces', 'start', `PUT ${key} to Spaces bucket`, { key, bytes: Buffer.byteLength(text) });
    await this.wait(600);
    ev.stage('spaces', 'done', 'Object stored; event trigger fired', { key });

    // 2. Functions: chunk + embed
    ev.stage('functions', 'start', 'Function invoked: chunk + embed', { key });
    await this.wait(400);
    const chunks = chunkText(text);
    ev.stage('functions', 'progress', `Chunked into ${chunks.length} chunk${chunks.length === 1 ? '' : 's'}`, {
      step: 'chunk',
      chunks: chunks.length,
    });
    const embeddings = [];
    for (let i = 0; i < chunks.length; i++) {
      await this.wait(350);
      embeddings.push(embedLocal(chunks[i]));
      ev.stage('functions', 'progress', `Embedded chunk ${i + 1}/${chunks.length} (128 dims)`, {
        step: 'embed',
        index: i,
        total: chunks.length,
      });
    }
    await this.wait(200);
    ev.stage('functions', 'done', `Produced ${chunks.length} vector${chunks.length === 1 ? '' : 's'}`, { chunks: chunks.length });

    // 3. pgvector: insert
    ev.stage('vectordb', 'start', `INSERT ${chunks.length} row${chunks.length === 1 ? '' : 's'} into pgvector`, {});
    await this.wait(500);
    chunks.forEach((c, i) => this.store.insert(c, embeddings[i], { key, jobId }));
    ev.stage('vectordb', 'done', `Store now holds ${this.store.size} chunks`, { count: this.store.size, inserted: chunks.length });

    const result = { jobId, key, chunks: chunks.length, total: this.store.size };
    ev.job('done', result);
    return result;
  }

  async ask(question) {
    const jobId = randomUUID();
    const ev = this.bus.forJob(jobId, 'query');
    ev.job('start', { input: question });

    // 1. Knowledge base receives the query and embeds it
    ev.stage('kb', 'start', 'Knowledge Base received query', { question });
    await this.wait(400);
    const qvec = embedLocal(question);
    ev.stage('kb', 'progress', 'Query embedded (128 dims)', { step: 'embed' });

    // 2. Similarity search in pgvector
    ev.stage('vectordb', 'start', 'Cosine similarity search, top 3', { op: 'search' });
    await this.wait(500);
    const hits = this.store.search(qvec, 3).filter((h) => h.score > 0.08);
    ev.stage('vectordb', 'done', `${hits.length} relevant chunk${hits.length === 1 ? '' : 's'} retrieved`, {
      count: this.store.size,
      hits: hits.map((h) => ({ id: h.id, score: Number(h.score.toFixed(3)) })),
      op: 'search',
    });
    await this.wait(200);
    ev.stage('kb', 'done', `Context assembled from ${hits.length} chunk${hits.length === 1 ? '' : 's'}`, { hits: hits.length });

    // 3. Agent builds the prompt
    ev.stage('agent', 'start', 'Agent composing grounded prompt', { contextChunks: hits.length });
    await this.wait(500);
    ev.stage('agent', 'done', 'Prompt ready; calling serverless inference', {});

    // 4. Serverless inference streams tokens
    ev.stage('inference', 'start', 'Serverless inference generating', { model: 'mock-llm' });
    await this.wait(300);
    const answer = this.compose(question, hits);
    const words = answer.split(' ');
    for (let i = 0; i < words.length; i++) {
      await this.wait(45);
      ev.stage('inference', 'progress', '', { token: (i ? ' ' : '') + words[i], index: i, total: words.length });
    }
    ev.stage('inference', 'done', `Generated ${words.length} tokens`, { tokens: words.length });

    const sources = hits.map((h) => ({ id: h.id, chunk: h.chunk, score: Number(h.score.toFixed(3)) }));
    ev.answer(answer, sources);
    ev.job('done', { answer, sources });
    return { jobId, answer, sources };
  }

  compose(question, hits) {
    if (!hits.length) {
      return "I couldn't find anything relevant in the knowledge base yet. Submit a fact first, then ask me about it.";
    }
    const [top, ...rest] = hits;
    let text = `Based on the knowledge base: ${top.chunk}`;
    if (rest.length) text += ` Related: ${rest.map((r) => r.chunk).join(' ')}`;
    return text;
  }
}
