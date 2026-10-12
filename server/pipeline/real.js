import { randomUUID } from 'node:crypto';
import { chunkText } from './embedding.js';
import { HarnessClient, harnessConfig, buildPrompt, buildToolPrompt, isDontKnow, normalizeToolName, toolTarget } from './harness.js';
import { pgPoolConfig, embeddingConfig, embedTexts, toVector, cosineSearch } from './retrieval.js';
import { factId, factKey, notFound } from './facts.js';

export { pgPoolConfig };

const MCP_HEALTH_TIMEOUT_MS = 1500;
const DONT_KNOW_TEXT = 'I do not know that yet.';

/** Short, log-safe rendering of tool arguments: search_facts(query=…) */
export function fmtArgs(args = {}) {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}…` : v) : JSON.stringify(v)}`)
    .join(', ');
}

/**
 * Real pipeline wired for DigitalOcean. All heavy dependencies are imported
 * lazily so mock mode never loads them. Configuration comes from env vars
 * documented in .env.example.
 *
 * Architecture v4 question flow (ANSWER_BACKEND=harness, the default):
 *   client -> Harness Runtime session (OpenCode + gpt-oss on Serverless Inference)
 *          -> Action Gateway / inline MCP -> anatomy-data MCP server (mcp/)
 *          -> pgvector (search_facts) / Spaces (get_document)
 *   The MCP server reports each tool call to POST /api/internal/tool-event,
 *   which lands in handleToolEvent() below and is attributed to the active
 *   question job so the scene can animate it.
 * Fallback 1: tool path unavailable (MCP health check fails, HARNESS_TOOLS_MODE=none,
 *   the agent answered without calling any tool, or it answered "don't know"
 *   without any usable tool result): the app retrieves itself and passes the
 *   context in the prompt. The session keeps its history, so an answer without a
 *   tool call is treated as ungrounded (it may describe a fact deleted since) and
 *   is never shown: on the tool path answer tokens are held back until a tool
 *   call has been observed.
 * Fallback 2: the harness fails before producing anything: the old Managed
 *   Agent path (DO_AGENT_ENDPOINT) answers with app-side retrieval.
 */
export class RealPipeline {
  constructor(bus, env = process.env) {
    this.bus = bus;
    this.env = env;
    this.mode = 'real';
    const embedding = embeddingConfig(env);
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
        url: embedding.url,
        key: env.DO_INFERENCE_KEY,
        model: env.DO_INFERENCE_MODEL || 'llama3.3-70b-instruct',
        embeddingModel: embedding.embeddingModel,
      },
      embedding,
      agent: { endpoint: (env.DO_AGENT_ENDPOINT || '').replace(/\/$/, ''), key: env.DO_AGENT_KEY },
      // ANSWER_BACKEND=harness|agent picks who answers questions (see README).
      answerBackend: (env.ANSWER_BACKEND || 'harness').toLowerCase(),
      harness: harnessConfig(env),
      mcpToken: env.MCP_AUTH_TOKEN || '',
      dim: embedding.dim,
    };
    this.harness = new HarnessClient(this.cfg.harness);
    this._s3 = null;
    this._pool = null;
    this._ready = null;
    this.count = 0;
    this.activeRun = null; // the question job currently running in the harness (tool events attach to it)
    this.askQueue = Promise.resolve();
  }

  describe() {
    const h = this.cfg.harness;
    return {
      mode: this.mode,
      chunks: this.count,
      spaces: Boolean(this.cfg.spaces.key && this.cfg.spaces.bucket),
      database: Boolean(this.cfg.databaseUrl),
      inference: Boolean(this.cfg.inference.key),
      agent: Boolean(this.cfg.agent.endpoint),
      harness: Boolean(h.token),
      harnessModel: h.model,
      harnessSession: h.sessionName,
      toolsMode: h.toolsMode,
      mcp: Boolean(h.mcpUrl),
      answerBackend: this.cfg.answerBackend,
      inferenceVia: this.inferenceVia(),
      embedding: this.cfg.inference.embeddingModel || 'local-hash',
    };
  }

  /** Which service answers questions: the Harness Runtime, a Managed Agent, direct Serverless Inference, or nothing configured. */
  inferenceVia() {
    if (this.cfg.answerBackend === 'harness' && this.cfg.harness.token) return 'harness';
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
    return embedTexts(this.cfg.embedding, texts);
  }

  toVector(arr) {
    return toVector(arr);
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

  // ---- facts: list / delete -------------------------------------------------
  /** Re-read the row count after a change so the readout never drifts. */
  async recount(pool) {
    const r = await pool.query(`SELECT count(*)::int AS n FROM ${this.cfg.table}`);
    this.count = r.rows[0].n;
    return this.count;
  }

  /**
   * Stored facts, newest first: one entry per Spaces object key, with the chunk
   * texts re-joined in insertion order. Rows without an object_key (legacy)
   * are not listed; "clear all" still removes them.
   */
  async listFacts() {
    const pool = await this.db();
    const r = await pool.query(
      `SELECT object_key AS key, count(*)::int AS chunks, min(created_at) AS created_at, min(id)::int AS first_id, string_agg(chunk, ' ' ORDER BY id) AS text FROM ${this.cfg.table} WHERE object_key IS NOT NULL GROUP BY object_key ORDER BY min(id) DESC`
    );
    return r.rows.map((x) => ({
      id: factId(x.key),
      key: x.key,
      text: x.text || '',
      createdAt: x.created_at ? new Date(x.created_at).getTime() : null,
      chunks: x.chunks,
    }));
  }

  /** Delete one fact: its pgvector rows (`WHERE object_key = $1`), then the Spaces object. Emits a `delete` flow. */
  async deleteFact(id) {
    const key = factKey(id);
    if (!key) throw notFound(id);
    const pool = await this.db();
    const found = await pool.query(`SELECT id FROM ${this.cfg.table} WHERE object_key = $1 ORDER BY id`, [key]);
    if (!found.rows.length) throw notFound(id);
    const ids = found.rows.map((r) => r.id);
    const jobId = randomUUID();
    const ev = this.bus.forJob(jobId, 'delete');
    ev.job('start', { input: key, key, id: factId(key) });
    try {
      ev.stage('vectordb', 'start', `DELETE ${ids.length} row${ids.length === 1 ? '' : 's'} FROM ${this.cfg.table} WHERE object_key = ${key}`, { op: 'delete', key, ids });
      const del = await pool.query(`DELETE FROM ${this.cfg.table} WHERE object_key = $1 RETURNING id`, [key]);
      const removed = del.rows.map((r) => r.id);
      await this.recount(pool);
      ev.stage('vectordb', 'done', `Removed ${removed.length} row${removed.length === 1 ? '' : 's'}; table now holds ${this.count} chunks`, { op: 'delete', key, ids: removed, removed: removed.length, count: this.count });

      ev.stage('spaces', 'start', `DELETE ${key} from ${this.cfg.spaces.bucket}`, { op: 'delete', key });
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const s3 = await this.s3();
      await s3.send(new DeleteObjectCommand({ Bucket: this.cfg.spaces.bucket, Key: key }));
      ev.stage('spaces', 'done', 'Object removed from Spaces', { op: 'delete', key });

      const result = { jobId, id: factId(key), key, removed: removed.length, total: this.count };
      ev.job('done', result);
      return result;
    } catch (err) {
      ev.job('error', { message: err.message });
      throw Object.assign(err, { jobId, flow: 'delete' });
    }
  }

  /**
   * Delete every fact: all rows of the table (those pointing at a known object
   * plus legacy rows without a key), then every object those rows pointed at.
   */
  async deleteAllFacts() {
    const pool = await this.db();
    const keyRows = await pool.query(`SELECT DISTINCT object_key AS key FROM ${this.cfg.table} WHERE object_key IS NOT NULL ORDER BY object_key`);
    const keys = keyRows.rows.map((r) => r.key);
    const idRows = await pool.query(`SELECT id FROM ${this.cfg.table} ORDER BY id`);
    const ids = idRows.rows.map((r) => r.id);
    const jobId = randomUUID();
    const ev = this.bus.forJob(jobId, 'delete');
    ev.job('start', { input: `all facts (${keys.length})`, all: true, keys });
    try {
      ev.stage('vectordb', 'start', `DELETE all ${ids.length} row${ids.length === 1 ? '' : 's'} FROM ${this.cfg.table}`, { op: 'delete', all: true, keys, ids });
      const del = await pool.query(`DELETE FROM ${this.cfg.table} WHERE object_key = ANY($1::text[]) OR object_key IS NULL RETURNING id`, [keys]);
      const removed = del.rows.map((r) => r.id);
      await this.recount(pool);
      ev.stage('vectordb', 'done', `Removed ${removed.length} row${removed.length === 1 ? '' : 's'}; table now holds ${this.count} chunks`, { op: 'delete', all: true, keys, ids: removed, removed: removed.length, count: this.count });

      ev.stage('spaces', 'start', `DELETE ${keys.length} object${keys.length === 1 ? '' : 's'} from ${this.cfg.spaces.bucket}`, { op: 'delete', all: true, keys });
      if (keys.length) {
        const { DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
        const s3 = await this.s3();
        for (let i = 0; i < keys.length; i += 1000) {
          const batch = keys.slice(i, i + 1000);
          const out = await s3.send(new DeleteObjectsCommand({ Bucket: this.cfg.spaces.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
          if (out?.Errors?.length) throw new Error(`Spaces refused ${out.Errors.length} delete${out.Errors.length === 1 ? '' : 's'}: ${out.Errors[0].Key} ${out.Errors[0].Message || out.Errors[0].Code || ''}`.trim());
        }
      }
      ev.stage('spaces', 'done', `${keys.length} object${keys.length === 1 ? '' : 's'} removed`, { op: 'delete', all: true, keys, removed: keys.length });

      const result = { jobId, facts: keys.length, keys, removed: removed.length, total: this.count };
      ev.job('done', result);
      return result;
    } catch (err) {
      ev.job('error', { message: err.message });
      throw Object.assign(err, { jobId, flow: 'delete' });
    }
  }

  // ---- query --------------------------------------------------------------
  /**
   * Answer a question. With ANSWER_BACKEND=harness (default) the Harness
   * Runtime agent retrieves through the MCP tools itself (see class docs);
   * the legacy backends retrieve from pgvector first and then generate via the
   * Managed Agent (DO_AGENT_ENDPOINT) or Serverless Inference (DO_INFERENCE_KEY).
   * Resolves { jobId, answer, sources, timing: {firstTokenMs, totalMs, toolCalls}, backend, fallback?, reason? }.
   */
  async ask(question) {
    const jobId = randomUUID();
    const ev = this.bus.forJob(jobId, 'query');
    const t0 = Date.now();
    ev.job('start', { input: question });
    try {
      const via = this.inferenceVia();
      if (!via) throw new Error('DO_INFERENCE_KEY missing and no DO_AGENT_ENDPOINT configured (nor HARNESS_API_TOKEN with ANSWER_BACKEND=harness): set a Harness Runtime token, a Managed Agent endpoint + key, or a Model Access Key');
      if (via === 'agent' && !this.cfg.agent.key) throw new Error('DO_AGENT_KEY missing (required with DO_AGENT_ENDPOINT)');

      let result;
      if (via === 'harness') {
        // one harness run at a time so tool events are attributed to the right job
        const run = this.askQueue.then(() => this.askViaHarness(question, ev, jobId, t0));
        this.askQueue = run.catch(() => {});
        result = await run;
      } else {
        // legacy: retrieval over our own vector store first, then generate
        const sources = await this.retrieve(question, ev);
        const context = sources.map((s, i) => `[${i + 1}] ${s.chunk}`).join('\n');
        const guidance = 'Answer using only the provided context. If the context is empty or does not cover the question, say you do not know yet. Be concise.';
        let firstTokenMs = null;
        const onToken = (token, index) => {
          if (firstTokenMs == null) firstTokenMs = Date.now() - t0;
          ev.stage('inference', 'progress', '', { token, index });
        };
        let answer;
        if (via === 'agent') answer = await this.askAgent(question, context, guidance, sources, ev, onToken);
        else {
          // direct Serverless Inference with a Model Access Key
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
        result = { answer, sources, backend: via, timing: { firstTokenMs, totalMs: Date.now() - t0, toolCalls: 0 } };
      }

      const { answer, sources } = result;
      ev.answer(answer, sources);
      ev.job('done', { answer, sources, timing: result.timing, backend: result.backend, fallback: result.fallback, reason: result.reason });
      return { jobId, ...result };
    } catch (err) {
      ev.job('error', { message: err.message });
      throw Object.assign(err, { jobId, flow: 'query' });
    }
  }

  /** `GET <MCP_PUBLIC_URL>/health` with a short timeout: is the tool path reachable? */
  async mcpHealthy() {
    const url = this.cfg.harness.mcpUrl;
    if (!url) return { ok: false, reason: 'MCP_PUBLIC_URL not set' };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MCP_HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`${url}/health`, { signal: ac.signal });
      if (!res.ok) return { ok: false, reason: `MCP health HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `MCP health ${ac.signal.aborted ? 'timed out' : err.message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * v4 answer flow through the Harness Runtime. Returns
   * { answer, sources, backend, timing, fallback }.
   */
  async askViaHarness(question, ev, jobId, t0) {
    const h = this.cfg.harness;
    const run = { jobId, ev, toolCalls: 0, toolDone: 0, toolErrors: 0, harnessToolEvents: 0, hits: [], seen: new Set() };
    this.activeRun = run;
    let firstTokenMs = null;
    let streamed = 0;
    // A tool call "observed" for this run: reported by the MCP server (primary) or seen on the harness SSE stream.
    const toolSeen = () => run.toolCalls > 0 || run.harnessToolEvents > 0;
    // Tool path: the warm session keeps its conversation history, so an answer produced without any tool
    // call may be a stale earlier turn (e.g. a fact deleted since). Answer tokens are held back until a
    // tool call has been seen; if the run completes without one, the held answer is discarded unseen.
    const gate = { enabled: false, held: [] };
    const forward = (token, index) => {
      if (firstTokenMs == null) firstTokenMs = Date.now() - t0;
      streamed++;
      ev.stage('inference', 'progress', '', { token, index });
    };
    const flushHeld = () => {
      const held = gate.held.splice(0);
      for (const [token, index] of held) forward(token, index);
    };
    const onToken = (token, index) => {
      if (gate.enabled && !toolSeen()) { gate.held.push([token, index]); return; }
      if (gate.held.length) flushHeld();
      forward(token, index);
    };
    const timing = () => ({ firstTokenMs, totalMs: Date.now() - t0, toolCalls: run.toolCalls });
    let sources = [];
    let answer = '';
    let backend = 'harness';
    let fallback = null;
    let reason = null;
    let harnessOut = null;
    const describe = (s) => ev.stage('agent', 'progress', s.created ? `Harness session ${s.name} created (manifest ${s.hash})` : `Harness session ${s.name} ready${s.stale ? ' (base session has a stale manifest)' : ''}`, { step: 'session', created: s.created, name: s.name, via: 'harness', toolsMode: s.toolsMode, hash: s.hash });
    const hooks = (label) => ({
      onSession: describe,
      onStarted: (ms) => ev.stage('agent', 'progress', `Harness run started (+${ms} ms)${label ? ` · ${label}` : ''}`, { step: 'run', ms, via: 'harness' }),
      onToolEvent: (t) => { run.harnessToolEvents++; ev.tool(this.harnessToolEvent(run, t)); },
      onToken,
    });
    const contextRun = async (detail, why, because) => {
      // FALLBACK 1: the app retrieves itself and passes the context in the prompt
      gate.enabled = false;
      gate.held.length = 0;
      sources = await this.retrieve(question, ev);
      const context = sources.map((s, i) => `[${i + 1}] ${s.chunk}`).join('\n');
      ev.stage('inference', 'start', `Serverless inference via harness: ${h.model}`, { model: h.model, via: 'harness', toolsMode: 'none' });
      harnessOut = await this.harness.ask(buildPrompt(question, context), hooks(detail));
      answer = harnessOut.text;
      fallback = why;
      reason = because || null;
    };

    try {
      try {
        let toolPath = h.toolsMode !== 'none';
        let unavailable = h.toolsMode === 'none' ? 'HARNESS_TOOLS_MODE=none' : '';
        if (toolPath) {
          const health = await this.mcpHealthy();
          if (!health.ok) { toolPath = false; unavailable = health.reason; }
        }
        if (toolPath) {
          ev.stage('agent', 'start', `Harness Runtime (OpenCode, ${h.model}) answering with tools (${h.toolsMode})`, { via: 'harness', session: h.sessionName, toolsMode: h.toolsMode, model: h.model });
          ev.stage('inference', 'start', `Serverless inference via harness: ${h.model}`, { model: h.model, via: 'harness', toolsMode: h.toolsMode });
          gate.enabled = true;
          harnessOut = await this.harness.ask(buildToolPrompt(question, { gateway: h.toolsMode === 'gateway' }), hooks('tool path'));
          answer = harnessOut.text;
          sources = run.hits.slice();
          if (!toolSeen()) {
            // GUARD: no tool call at all -> the answer is ungrounded (likely recalled from an earlier turn,
            // possibly about a fact that has since been deleted). Discard it and re-ask with fresh context.
            const held = gate.held.length;
            gate.held.length = 0;
            const what = streamed > 0 ? 'the ungrounded answer already streamed was discarded; the final answer replaces it' : `ungrounded answer discarded unseen (${held} held token${held === 1 ? '' : 's'})`;
            ev.stage('agent', 'progress', `Harness answered without calling any tool: ${what}; re-asking with context passed in prompt`, { fallback: 'context', reason: 'no tool call', discarded: true, streamed, held, via: 'harness' });
            answer = '';
            sources = [];
            await contextRun('context (no tool call)', 'context', 'no tool call');
          } else {
            if (gate.held.length) flushHeld();
            gate.enabled = false;
            if ((run.toolDone === 0 || run.toolErrors > 0) && isDontKnow(answer)) {
              // the agent never got a usable tool result: retry once with context in the prompt
              ev.stage('agent', 'progress', `No usable tool result (${run.toolDone} done, ${run.toolErrors} failed); retrying with context passed in prompt`, { fallback: 'context', via: 'harness' });
              await contextRun('context retry', 'context-retry');
            }
          }
        } else {
          ev.stage('agent', 'start', `Harness Runtime (OpenCode, ${h.model}) answering · Tool path unavailable, context passed in prompt (${unavailable})`, { via: 'harness', session: h.sessionName, toolsMode: 'none', model: h.model, fallback: 'context', reason: unavailable });
          await contextRun('context in prompt', 'context', unavailable);
        }
        const t = timing();
        ev.stage('inference', 'done', 'Completed', { model: harnessOut.model || h.model, tokens: harnessOut.tokens, via: 'harness', ...t });
        ev.stage('agent', 'done', `Harness answered (first token ${t.firstTokenMs ?? '—'} ms, total ${t.totalMs} ms, ${t.toolCalls} tool call${t.toolCalls === 1 ? '' : 's'})`, { via: 'harness', ...t, runId: harnessOut.runId, backend, fallback, reason });
      } catch (err) {
        // FALLBACK 2: the harness failed before producing anything -> old Managed Agent path
        if (streamed > 0 || err.beforeFirstToken === false || !this.cfg.agent.endpoint || !this.cfg.agent.key) throw err;
        this.bus.publish({ type: 'fallback', flow: 'query', jobId, data: { reason: err.message, to: 'agent', from: 'harness' } });
        ev.stage('agent', 'progress', `Harness failed before first token (${err.message}); falling back to Managed Agent`, { fallback: 'agent', via: 'harness' });
        if (!sources.length) sources = await this.retrieve(question, ev);
        const context = sources.map((s, i) => `[${i + 1}] ${s.chunk}`).join('\n');
        const guidance = 'Answer using only the provided context. If the context is empty or does not cover the question, say you do not know yet. Be concise.';
        answer = await this.askAgent(question, context, guidance, sources, ev, onToken);
        backend = 'agent';
        fallback = 'agent';
        reason = err.message;
      }
      if (!answer) answer = DONT_KNOW_TEXT;
      return { answer, sources, backend, timing: timing(), fallback, reason };
    } finally {
      if (this.activeRun === run) this.activeRun = null;
    }
  }

  /**
   * Shape a harness-side tool event (`run.tool_call*` on the session SSE stream)
   * into the same `tool` payload the MCP server reports. Names arrive as gateway
   * slugs (`do_actions_anatomy-data_search_facts`) and completion events often
   * carry no name at all, so started calls are remembered on the run (by call id
   * when present) and reused for the matching completed/failed event.
   */
  harnessToolEvent(run, t) {
    const d = t.data || {};
    const type = String(t.type || '');
    const phase = /complet|done|result|finish/i.test(type) ? 'done' : /fail|error/i.test(type) ? 'error' : 'start';
    const callId = d.call_id ?? d.callId ?? d.tool_call_id ?? d.id ?? undefined;
    let tool = normalizeToolName(d.tool || d.name || d.tool_name);
    let args = d.input || d.args || d.arguments;
    if (args && typeof args !== 'object') args = undefined;
    if (!run.harnessCalls) run.harnessCalls = [];
    if (phase === 'start') {
      run.harnessCalls.push({ callId, tool, args });
    } else {
      const idx = callId != null ? run.harnessCalls.findIndex((c) => c.callId === callId) : run.harnessCalls.length - 1;
      const started = idx >= 0 ? run.harnessCalls.splice(idx, 1)[0] : null;
      if (started) {
        if (!tool) tool = started.tool;
        if (!args) args = started.args;
      }
    }
    const target = toolTarget(tool);
    const slug = String(d.tool || d.name || d.tool_name || '') || undefined;
    const err = phase === 'error' ? d.error || d.message : undefined;
    const error = err == null ? undefined : typeof err === 'string' ? err : err.message || JSON.stringify(err);
    const data = { source: 'harness', phase, tool: tool || type, args, callId, harnessType: type, slug, error };
    if (target) data.target = target;
    return data;
  }

  /**
   * A tool call reported by the MCP server (POST /api/internal/tool-event).
   * Publishes a `tool` event plus `gateway` and target (`vectordb` / `spaces`)
   * stage events attributed to the active question job.
   */
  handleToolEvent(body = {}) {
    const run = this.activeRun;
    const tool = String(body.tool || 'unknown');
    const phase = ['start', 'done', 'error'].includes(body.phase) ? body.phase : 'done';
    const target = body.target === 'spaces' || body.target === 'pgvector' ? body.target : tool === 'get_document' ? 'spaces' : 'pgvector';
    const stage = target === 'spaces' ? 'spaces' : 'vectordb';
    const args = body.args && typeof body.args === 'object' ? body.args : {};
    const hits = Array.isArray(body.hits) ? body.hits : [];
    const ms = Number.isFinite(body.ms) ? body.ms : undefined;
    const data = { tool, phase, args, summary: body.summary, ms, target, callId: body.callId, hits: hits.length, error: body.error, source: 'mcp' };
    if (!run) {
      this.bus.publish({ type: 'tool', flow: 'query', jobId: null, data });
      return { accepted: false };
    }
    const { ev } = run;
    ev.tool(data);
    const base = { tool, callId: body.callId, args, op: 'tool', target };
    if (phase === 'start') {
      run.toolCalls++;
      ev.stage('gateway', 'start', `TOOL ${tool}(${fmtArgs(args)}) → ${target}`, base);
      ev.stage(stage, 'start', `${tool} via Action Gateway`, base);
    } else if (phase === 'done') {
      run.toolDone++;
      for (const hit of hits) {
        const id = hit?.id ?? hit?.object_key;
        if (id == null || run.seen.has(id)) continue;
        run.seen.add(id);
        run.hits.push({ id, chunk: hit.chunk || '', score: hit.score ?? null, object_key: hit.object_key ?? null, origin: tool });
      }
      const short = hits.map((h) => ({ id: h?.id, score: h?.score ?? null }));
      ev.stage(stage, 'done', `${tool}: ${body.summary || `${hits.length} hits`}${ms != null ? ` · ${ms} ms` : ''}`, { ...base, hits: short, ms, ...(stage === 'vectordb' ? { count: this.count } : {}) });
      ev.stage('gateway', 'done', `TOOL ${tool}(${fmtArgs(args)}) → ${target} · ${body.summary || `${hits.length} hits`}${ms != null ? ` · ${ms} ms` : ''}`, { ...base, hits: short, ms });
    } else {
      run.toolErrors++;
      ev.stage(stage, 'error', `${tool} failed: ${body.error || 'unknown error'}`);
      ev.stage('gateway', 'error', `TOOL ${tool}(${fmtArgs(args)}) → ${target} failed: ${body.error || 'unknown error'}`);
    }
    return { accepted: true, jobId: run.jobId };
  }

  /** Managed Agent path (DO_AGENT_ENDPOINT): the agent owns a KB and calls the model. Mutates `sources`. */
  async askAgent(question, context, guidance, sources, ev, onToken) {
    const via = 'agent';
    let answer;
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
    return answer;
  }

  /** Embed the question and run a cosine top-3 search in pgvector, emitting kb/vectordb stage events (app-side retrieval). */
  async retrieve(question, ev) {
    ev.stage('kb', 'start', 'App-side retrieval: embedding the question', { question });
    const [qvec] = await this.embed([question]);
    ev.stage('kb', 'progress', 'Query embedded', { step: 'embed' });
    ev.stage('vectordb', 'start', 'pgvector cosine search, top 3', { op: 'search' });
    const pool = await this.db();
    const sources = await cosineSearch(pool, this.cfg.table, qvec, 3);
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
