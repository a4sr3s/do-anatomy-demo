import { randomUUID } from 'node:crypto';
import { chunkText, embedLocal, LOCAL_DIM } from './embedding.js';

/**
 * Real pipeline wired for DigitalOcean. All heavy dependencies are imported
 * lazily so mock mode never loads them. Configuration comes from env vars
 * documented in .env.example.
 */
export class RealPipeline {
  constructor(bus, env = process.env) {
    this.bus = bus;
    this.env = env;
    this.mode = 'real';
    this.cfg = {
      spaces: {
        key: env.DO_SPACES_KEY,
        secret: env.DO_SPACES_SECRET,
        region: env.DO_SPACES_REGION || 'nyc3',
        bucket: env.DO_SPACES_BUCKET,
        endpoint: env.DO_SPACES_ENDPOINT || `https://${env.DO_SPACES_REGION || 'nyc3'}.digitaloceanspaces.com`,
      },
      functionUrl: env.DO_FUNCTION_URL || '',
      databaseUrl: env.DATABASE_URL,
      table: env.PGVECTOR_TABLE || 'anatomy_chunks',
      inference: {
        url: (env.DO_INFERENCE_URL || 'https://inference.do-ai.run/v1').replace(/\/$/, ''),
        key: env.DO_INFERENCE_KEY,
        model: env.DO_INFERENCE_MODEL || 'llama3.3-70b-instruct',
        embeddingModel: env.DO_EMBEDDING_MODEL || '',
      },
      agent: { endpoint: (env.DO_AGENT_ENDPOINT || '').replace(/\/$/, ''), key: env.DO_AGENT_KEY },
      dim: Number(env.VECTOR_DIM) || (env.DO_EMBEDDING_MODEL ? 1024 : LOCAL_DIM),
    };
    this._s3 = null;
    this._pool = null;
    this._ready = null;
    this.count = 0;
  }

  describe() {
    return {
      mode: this.mode,
      chunks: this.count,
      spaces: Boolean(this.cfg.spaces.key && this.cfg.spaces.bucket),
      database: Boolean(this.cfg.databaseUrl),
      inference: Boolean(this.cfg.inference.key),
      agent: Boolean(this.cfg.agent.endpoint),
      embedding: this.cfg.inference.embeddingModel || 'local-hash',
    };
  }

  // ---- lazy clients -------------------------------------------------------
  async s3() {
    if (this._s3) return this._s3;
    const { S3Client } = await import('@aws-sdk/client-s3');
    const { key, secret, region, endpoint } = this.cfg.spaces;
    if (!key || !secret) throw new Error('Spaces credentials missing (DO_SPACES_KEY / DO_SPACES_SECRET)');
    this._s3 = new S3Client({ region, endpoint, forcePathStyle: false, credentials: { accessKeyId: key, secretAccessKey: secret } });
    return this._s3;
  }

  async db() {
    if (this._pool) return this._pool;
    if (!this.cfg.databaseUrl) throw new Error('DATABASE_URL missing');
    const pg = await import('pg');
    const Pool = pg.default?.Pool || pg.Pool;
    this._pool = new Pool({ connectionString: this.cfg.databaseUrl, ssl: /sslmode=require/.test(this.cfg.databaseUrl) ? { rejectUnauthorized: false } : undefined });
    this._ready = (async () => {
      await this._pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await this._pool.query(
        `CREATE TABLE IF NOT EXISTS ${this.cfg.table} (id serial PRIMARY KEY, chunk text NOT NULL, object_key text, embedding vector(${this.cfg.dim}), created_at timestamptz DEFAULT now())`
      );
      const r = await this._pool.query(`SELECT count(*)::int AS n FROM ${this.cfg.table}`);
      this.count = r.rows[0].n;
    })();
    await this._ready;
    return this._pool;
  }

  async embed(texts) {
    const { url, key, embeddingModel } = this.cfg.inference;
    if (!embeddingModel) return texts.map((t) => embedLocal(t, this.cfg.dim));
    const res = await fetch(`${url}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: embeddingModel, input: texts }),
    });
    if (!res.ok) throw new Error(`Embedding request failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  toVector(arr) {
    return `[${arr.map((x) => Number(x).toFixed(6)).join(',')}]`;
  }

  // ---- ingest -------------------------------------------------------------
  async submitFact(text) {
    const jobId = randomUUID();
    const ev = this.bus.forJob(jobId, 'ingest');
    ev.job('start', { input: text });
    const key = `facts/${Date.now()}-${jobId.slice(0, 8)}.txt`;
    try {
      ev.stage('spaces', 'start', `PUT ${key} to ${this.cfg.spaces.bucket}`, { key, bytes: Buffer.byteLength(text) });
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const s3 = await this.s3();
      await s3.send(new PutObjectCommand({ Bucket: this.cfg.spaces.bucket, Key: key, Body: text, ContentType: 'text/plain' }));
      ev.stage('spaces', 'done', 'Object stored in Spaces', { key });

      let chunks, embeddings;
      if (this.cfg.functionUrl) {
        ev.stage('functions', 'start', 'Invoking DigitalOcean Function', { key });
        const res = await fetch(this.cfg.functionUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, text }) });
        if (!res.ok) throw new Error(`Function returned ${res.status}`);
        ({ chunks, embeddings } = await res.json());
        ev.stage('functions', 'progress', `Function returned ${chunks.length} chunks`, { step: 'chunk', chunks: chunks.length });
      } else {
        ev.stage('functions', 'start', 'Chunk + embed (in-process, DO_FUNCTION_URL not set)', { key });
        chunks = chunkText(text);
        ev.stage('functions', 'progress', `Chunked into ${chunks.length} chunks`, { step: 'chunk', chunks: chunks.length });
        embeddings = await this.embed(chunks);
        chunks.forEach((_, i) => ev.stage('functions', 'progress', `Embedded chunk ${i + 1}/${chunks.length}`, { step: 'embed', index: i, total: chunks.length }));
      }
      ev.stage('functions', 'done', `Produced ${chunks.length} vectors`, { chunks: chunks.length });

      ev.stage('vectordb', 'start', `INSERT ${chunks.length} rows into ${this.cfg.table}`, {});
      const pool = await this.db();
      for (let i = 0; i < chunks.length; i++) {
        await pool.query(`INSERT INTO ${this.cfg.table} (chunk, object_key, embedding) VALUES ($1, $2, $3::vector)`, [chunks[i], key, this.toVector(embeddings[i])]);
      }
      this.count += chunks.length;
      ev.stage('vectordb', 'done', `Table now holds ${this.count} chunks`, { count: this.count, inserted: chunks.length });
      const result = { jobId, key, chunks: chunks.length, total: this.count };
      ev.job('done', result);
      return result;
    } catch (err) {
      ev.job('error', { message: err.message });
      throw Object.assign(err, { jobId, flow: 'ingest' });
    }
  }

  // ---- query --------------------------------------------------------------
  async ask(question) {
    const jobId = randomUUID();
    const ev = this.bus.forJob(jobId, 'query');
    ev.job('start', { input: question });
    try {
      let sources = [];
      let answer;
      if (this.cfg.agent.endpoint) {
        ev.stage('kb', 'start', 'Managed Agent queries its Knowledge Base', { question });
        ev.stage('agent', 'start', 'Calling GenAI Platform agent', {});
        const res = await fetch(`${this.cfg.agent.endpoint}/api/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.agent.key}` },
          body: JSON.stringify({ messages: [{ role: 'user', content: question }], include_retrieval_info: true }),
        });
        if (!res.ok) throw new Error(`Agent returned ${res.status}`);
        const json = await res.json();
        const retrieved = json.retrieval?.retrieved_data || [];
        ev.stage('kb', 'done', `${retrieved.length} chunks retrieved by agent KB`, { hits: retrieved.length });
        sources = retrieved.map((r, i) => ({ id: r.id || i, chunk: r.text || r.content || '', score: r.score ?? null }));
        ev.stage('agent', 'done', 'Agent responded', {});
        ev.stage('inference', 'start', 'Inference (via agent)', { model: json.model });
        answer = json.choices?.[0]?.message?.content || '';
        ev.stage('inference', 'done', 'Completed', {});
      } else {
        ev.stage('kb', 'start', 'Knowledge Base received query', { question });
        const [qvec] = await this.embed([question]);
        ev.stage('kb', 'progress', 'Query embedded', { step: 'embed' });
        ev.stage('vectordb', 'start', 'pgvector cosine search, top 3', { op: 'search' });
        const pool = await this.db();
        const r = await pool.query(
          `SELECT id, chunk, 1 - (embedding <=> $1::vector) AS score FROM ${this.cfg.table} ORDER BY embedding <=> $1::vector LIMIT 3`,
          [this.toVector(qvec)]
        );
        sources = r.rows.filter((x) => x.score > 0.08).map((x) => ({ id: x.id, chunk: x.chunk, score: Number(Number(x.score).toFixed(3)) }));
        ev.stage('vectordb', 'done', `${sources.length} relevant chunks retrieved`, { count: this.count, hits: sources.map((s) => ({ id: s.id, score: s.score })), op: 'search' });
        ev.stage('kb', 'done', `Context assembled from ${sources.length} chunks`, { hits: sources.length });

        ev.stage('agent', 'start', 'Composing grounded prompt', { contextChunks: sources.length });
        const context = sources.map((s, i) => `[${i + 1}] ${s.chunk}`).join('\n');
        const messages = [
          { role: 'system', content: 'Answer using only the provided context. If the context is empty, say you do not know yet.' },
          { role: 'user', content: `Context:\n${context || '(none)'}\n\nQuestion: ${question}` },
        ];
        ev.stage('agent', 'done', 'Prompt ready; calling serverless inference', {});

        ev.stage('inference', 'start', `Serverless inference: ${this.cfg.inference.model}`, { model: this.cfg.inference.model });
        answer = await this.streamChat(messages, (token, i) => ev.stage('inference', 'progress', '', { token, index: i }));
        ev.stage('inference', 'done', 'Completed', {});
      }
      ev.answer(answer, sources);
      ev.job('done', { answer, sources });
      return { jobId, answer, sources };
    } catch (err) {
      ev.job('error', { message: err.message });
      throw Object.assign(err, { jobId, flow: 'query' });
    }
  }

  /** OpenAI-compatible streaming chat completion. */
  async streamChat(messages, onToken) {
    const { url, key, model } = this.cfg.inference;
    if (!key) throw new Error('DO_INFERENCE_KEY missing');
    const res = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages, stream: true, temperature: 0.2 }),
    });
    if (!res.ok) throw new Error(`Inference request failed: ${res.status} ${await res.text()}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let i = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^data:\s*(.*)$/);
        if (!m || m[1] === '[DONE]') continue;
        try {
          const delta = JSON.parse(m[1]).choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            onToken(delta, i++);
          }
        } catch {
          /* ignore partial lines */
        }
      }
    }
    return text;
  }
}
