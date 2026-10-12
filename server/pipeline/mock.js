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
    const t0 = Date.now();
    ev.job('start', { input: question });

    // v4: the question goes straight to the Harness Runtime agent, which retrieves
    // through the anatomy-data MCP tools (search_facts) via the Action Gateway.
    ev.stage('agent', 'start', 'Harness Runtime (OpenCode, mock-llm) answering with tools (inline)', { via: 'harness', toolsMode: 'inline', model: 'mock-llm', session: 'mock-harness' });
    await this.wait(350);
    ev.stage('agent', 'progress', 'Harness session mock-harness ready', { step: 'session', created: false, via: 'harness' });
    await this.wait(350);

    // 1. tool call: search_facts -> pgvector (reported by the MCP server in real mode)
    const callId = randomUUID();
    const args = { query: question, k: 3 };
    const target = 'pgvector';
    const tool = 'search_facts';
    const base = { tool, callId, args, op: 'tool', target };
    ev.tool({ tool, phase: 'start', args, target, callId, source: 'mcp' });
    ev.stage('gateway', 'start', `TOOL ${tool}(query=${JSON.stringify(question.slice(0, 57))}) → ${target}`, base);
    await this.wait(300);
    ev.stage('vectordb', 'start', `${tool} via Action Gateway: cosine similarity search, top 3`, base);
    const tq = Date.now();
    await this.wait(500);
    const qvec = embedLocal(question);
    const hits = this.store.search(qvec, 3).filter((h) => h.score > 0.08);
    const short = hits.map((h) => ({ id: h.id, score: Number(h.score.toFixed(3)) }));
    const ms = Math.max(1, Date.now() - tq);
    const summary = `${hits.length} hit${hits.length === 1 ? '' : 's'}`;
    ev.stage('vectordb', 'done', `${tool}: ${summary} · ${ms} ms`, { ...base, count: this.store.size, hits: short, ms });
    ev.stage('gateway', 'done', `TOOL ${tool}(query=${JSON.stringify(question.slice(0, 57))}) → ${target} · ${summary} · ${ms} ms`, { ...base, hits: short, ms });
    ev.tool({ tool, phase: 'done', args, target, callId, ms, summary, hits: hits.length, source: 'mcp' });
    await this.wait(250);

    // 2. Serverless inference streams tokens back through the harness
    ev.stage('inference', 'start', 'Serverless inference via harness: mock-llm', { model: 'mock-llm', via: 'harness', toolsMode: 'inline' });
    await this.wait(300);
    const answer = this.compose(question, hits);
    const words = answer.split(' ');
    let firstTokenMs = null;
    for (let i = 0; i < words.length; i++) {
      await this.wait(45);
      if (firstTokenMs == null) firstTokenMs = Date.now() - t0;
      ev.stage('inference', 'progress', '', { token: (i ? ' ' : '') + words[i], index: i, total: words.length });
    }
    const timing = { firstTokenMs, totalMs: Date.now() - t0, toolCalls: 1 };
    ev.stage('inference', 'done', `Generated ${words.length} tokens`, { tokens: words.length, via: 'harness', ...timing });
    ev.stage('agent', 'done', `Harness answered (first token ${firstTokenMs} ms, total ${timing.totalMs} ms, 1 tool call)`, { via: 'harness', ...timing, backend: 'harness' });

    const sources = hits.map((h) => ({ id: h.id, chunk: h.chunk, score: Number(h.score.toFixed(3)), origin: tool }));
    ev.answer(answer, sources);
    ev.job('done', { answer, sources, timing, backend: 'harness' });
    return { jobId, answer, sources, timing, backend: 'harness' };
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
