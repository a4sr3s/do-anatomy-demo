import { randomUUID } from 'node:crypto';
import { chunkText, embedLocal, LOCAL_DIM } from './embedding.js';

/**
 * Build the `pg.Pool` config for DATABASE_URL.
 *
 * pg >= 8.x treats `sslmode=require` (and `prefer` / `verify-ca`) in the
 * connection string as `verify-full`, and the parsed connection string wins
 * over an explicit `ssl` option. Against DigitalOcean Managed Postgres, whose
 * server certificate is signed by a per-cluster CA, that fails with
 * "self-signed certificate in certificate chain". So the sslmode parameter is
 * stripped here and TLS is configured explicitly:
 *   - DATABASE_CA_CERT set   -> verify the chain against that CA (secure)
 *   - otherwise, sslmode=prefer / require / verify-* -> TLS without chain verification
 *   - no sslmode (or disable) -> leave ssl to pg's defaults / PGSSLMODE
 * DATABASE_CA_CERT may contain literal "\n" sequences (App Platform secrets
 * are single-line), which are converted back to newlines.
 */
export function pgPoolConfig(databaseUrl, caCert) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    return { connectionString: databaseUrl };
  }
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  const connectionString = url.toString();
  const ca = typeof caCert === 'string' && caCert.trim() ? caCert.trim().replace(/\\n/g, '\n') : '';
  if (ca) return { connectionString, ssl: { ca, rejectUnauthorized: true } };
  if (sslmode && /^(prefer|require|verify-ca|verify-full)$/.test(sslmode)) return { connectionString, ssl: { rejectUnauthorized: false } };
  if (sslmode === 'disable') return { connectionString, ssl: false };
  return { connectionString };
}

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
      inferenceVia: this.inferenceVia(),
      embedding: this.cfg.inference.embeddingModel || 'local-hash',
    };
  }

  /** Which service answers questions: a Managed Agent, direct Serverless Inference, or nothing configured. */
  inferenceVia() {
    if (this.cfg.agent.endpoint) return 'agent';
    if (this.cfg.inference.key) return 'serverless';
    return null;
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
    const pool = new Pool(pgPoolConfig(this.cfg.databaseUrl, this.env.DATABASE_CA_CERT));
    this._pool = pool;
    this._ready = (async () => {
      await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
      await pool.query(
        `CREATE TABLE IF NOT EXISTS ${this.cfg.table} (id serial PRIMARY KEY, chunk text NOT NULL, object_key text, embedding vector(${this.cfg.dim}), created_at timestamptz DEFAULT now())`
      );
      const r = await pool.query(`SELECT count(*)::int AS n FROM ${this.cfg.table}`);
      this.count = r.rows[0].n;
    })();
    try {
      await this._ready;
    } catch (err) {
      // Do not cache a pool whose schema setup failed (bad TLS config, wrong
      // credentials...) so the next request retries from scratch.
      this._pool = null;
      this._ready = null;
      pool.end().catch(() => {});
      throw err;
    }
    return pool;
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
  /**
   * Answer a question. Retrieval always runs against pgvector first so a fact
   * submitted seconds ago is answerable immediately, even when a Managed Agent
   * (with its own, periodically indexed Knowledge Base) produces the answer.
   * Generation goes through DO_AGENT_ENDPOINT when set, otherwise directly to
   * Serverless Inference with DO_INFERENCE_KEY.
   */
  async ask(question) {
    const jobId = randomUUID();
    const ev = this.bus.forJob(jobId, 'query');
    ev.job('start', { input: question });
    try {
      const via = this.inferenceVia();
      if (!via) throw new Error('DO_INFERENCE_KEY missing and no DO_AGENT_ENDPOINT configured: set a Managed Agent endpoint + key, or a Model Access Key');
      if (via === 'agent' && !this.cfg.agent.key) throw new Error('DO_AGENT_KEY missing (required with DO_AGENT_ENDPOINT)');

      // 1. retrieval over our own vector store, always
      const sources = await this.retrieve(question, ev);
      const context = sources.map((s, i) => `[${i + 1}] ${s.chunk}`).join('\n');
      const guidance = 'Answer using only the provided context. If the context is empty or does not cover the question, say you do not know yet. Be concise.';
      const onToken = (token, index) => ev.stage('inference', 'progress', '', { token, index });
      let answer;

      if (via === 'agent') {
        // 2. Managed Agent: it owns a Knowledge Base and calls the model for us.
        const { endpoint, key } = this.cfg.agent;
        ev.stage('agent', 'start', 'Managed Agent (KB + model) answering', { contextChunks: sources.length, via });
        // Agent endpoints apply their own system instructions, so the grounding guidance travels inside the user turn.
        const messages = [{ role: 'user', content: `${guidance}\n\nContext:\n${context || '(none)'}\n\nQuestion: ${question}` }];
        ev.stage('inference', 'start', 'Serverless inference via agent', { via });
        const agentSources = [];
        const onRetrieval = (retrieved) => {
          const extra = retrieved
            .map((r, i) => ({ id: r.id ?? `kb-${agentSources.length + i + 1}`, chunk: r.text || r.content || r.chunk || '', score: r.score ?? null, origin: 'agent-kb' }))
            .filter((r) => r.chunk);
          if (!extra.length) return;
          agentSources.push(...extra);
          ev.stage('kb', 'progress', `Agent Knowledge Base returned ${agentSources.length} chunk${agentSources.length === 1 ? '' : 's'}`, { step: 'agent-kb', hits: agentSources.length });
        };
        const out = await this.streamChat(messages, onToken, {
          url: `${endpoint}/api/v1`,
          key,
          model: null,
          body: { include_retrieval_info: true },
          onRetrieval,
        });
        answer = out.text;
        // merge agent KB hits after our own pgvector hits, skipping duplicate text
        const seen = new Set(sources.map((s) => s.chunk.trim()));
        for (const s of agentSources) if (!seen.has(s.chunk.trim())) { seen.add(s.chunk.trim()); sources.push(s); }
        ev.stage('inference', 'done', 'Completed', { model: out.model || undefined, tokens: out.tokens, via });
        ev.stage('agent', 'done', `Agent responded with ${agentSources.length} KB chunk${agentSources.length === 1 ? '' : 's'}`, { kbHits: agentSources.length });
      } else {
        // 3. direct Serverless Inference with a Model Access Key
        ev.stage('agent', 'start', 'Composing grounded prompt', { contextChunks: sources.length, via });
        const messages = [
          { role: 'system', content: guidance },
          { role: 'user', content: `Context:\n${context || '(none)'}\n\nQuestion: ${question}` },
        ];
        ev.stage('agent', 'done', 'Prompt ready; calling serverless inference', {});
        ev.stage('inference', 'start', `Serverless inference: ${this.cfg.inference.model}`, { model: this.cfg.inference.model, via });
        const out = await this.streamChat(messages, onToken);
        answer = out.text;
        ev.stage('inference', 'done', 'Completed', { model: out.model || this.cfg.inference.model, tokens: out.tokens, via });
      }

      ev.answer(answer, sources);
      ev.job('done', { answer, sources });
      return { jobId, answer, sources };
    } catch (err) {
      ev.job('error', { message: err.message });
      throw Object.assign(err, { jobId, flow: 'query' });
    }
  }

  /** Embed the question and run a cosine top-3 search in pgvector, emitting kb/vectordb stage events. */
  async retrieve(question, ev) {
    ev.stage('kb', 'start', 'Knowledge Base received query', { question });
    const [qvec] = await this.embed([question]);
    ev.stage('kb', 'progress', 'Query embedded', { step: 'embed' });
    ev.stage('vectordb', 'start', 'pgvector cosine search, top 3', { op: 'search' });
    const pool = await this.db();
    const r = await pool.query(
      `SELECT id, chunk, 1 - (embedding <=> $1::vector) AS score FROM ${this.cfg.table} ORDER BY embedding <=> $1::vector LIMIT 3`,
      [this.toVector(qvec)]
    );
    const sources = r.rows.filter((x) => x.score > 0.08).map((x) => ({ id: x.id, chunk: x.chunk, score: Number(Number(x.score).toFixed(3)) }));
    ev.stage('vectordb', 'done', `${sources.length} relevant chunk${sources.length === 1 ? '' : 's'} retrieved`, { count: this.count, hits: sources.map((s) => ({ id: s.id, score: s.score })), op: 'search' });
    ev.stage('kb', 'done', `Context assembled from ${sources.length} chunk${sources.length === 1 ? '' : 's'}`, { hits: sources.length });
    return sources;
  }

  /**
   * OpenAI-compatible streaming chat completion (SSE). Works against Serverless
   * Inference (default) or a Managed Agent endpoint via `opts`:
   *   url    base URL ending in /v1 (default DO_INFERENCE_URL)
   *   key    bearer token (default DO_INFERENCE_KEY)
   *   model  model id; null omits the field (agents pick their own model)
   *   body   extra request fields, e.g. { include_retrieval_info: true }
   *   onRetrieval(retrieved_data[]) called when a chunk carries agent KB retrieval info
   * Only `delta.content` is streamed; `delta.reasoning_content` from reasoning
   * models is ignored. Resolves { text, model, tokens }.
   */
  async streamChat(messages, onToken, opts = {}) {
    const url = (opts.url || this.cfg.inference.url).replace(/\/$/, '');
    const key = opts.key ?? this.cfg.inference.key;
    const model = opts.model === undefined ? this.cfg.inference.model : opts.model;
    if (!key) throw new Error(opts.url ? 'DO_AGENT_KEY missing' : 'DO_INFERENCE_KEY missing');
    const payload = { messages, stream: true, temperature: 0.2, ...(model ? { model } : {}), ...(opts.body || {}) };
    const res = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`${opts.url ? 'Agent' : 'Inference'} request failed: ${res.status} ${await res.text()}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let text = '';
    let modelSeen = '';
    let i = 0;
    const handle = (line) => {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m || m[1].trim() === '[DONE]' || !m[1].trim()) return;
      let json;
      try {
        json = JSON.parse(m[1]);
      } catch {
        return; /* ignore partial / non-JSON lines */
      }
      if (json.model && !modelSeen) modelSeen = json.model;
      const retrieved = json.retrieval?.retrieved_data;
      if (Array.isArray(retrieved) && retrieved.length && opts.onRetrieval) opts.onRetrieval(retrieved);
      const delta = json.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) {
        text += delta;
        onToken(delta, i++);
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) handle(line);
    }
    if (buf) handle(buf);
    return { text, model: modelSeen, tokens: i };
  }
}
