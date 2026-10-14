import { randomUUID } from 'node:crypto';
import { chunkText } from './embedding.js';
import { HarnessClient, harnessConfig, buildPrompt, buildToolPrompt, isDontKnow, normalizeToolName, toolTarget, dontKnowText } from './harness.js';
import { pgPoolConfig, embeddingConfig, embedTexts, toVector, cosineSearch, scoreFloor } from './retrieval.js';
import { migrate } from './migrate.js';
import { factId, factKey, notFound } from './facts.js';

export { pgPoolConfig };

const MCP_HEALTH_TIMEOUT_MS = 1500;
/** A health result younger than this is reused; a stale one is reused while a refresh runs in the background. */
const DEFAULT_MCP_HEALTH_TTL_MS = 30000;
const SEARCH_K = 3;

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
 * Ingest: client -> Spaces (PutObject) -> chunk + embed in this App Platform
 *   web service (stage `functions`, kept as the wire name) -> pgvector INSERT.
 *
 * Question flow (the only answer path):
 *   client -> Harness Runtime session (OpenCode + gpt-oss-20b on Serverless Inference)
 *          -> Action Gateway / inline MCP -> anatomy-data MCP server (mcp/)
 *          -> pgvector (search_facts) / Spaces (get_document)
 *   The MCP server reports each tool call to POST /api/internal/tool-event,
 *   which lands in handleToolEvent() below and is attributed to the active
 *   question job so the scene can animate it.
 *   search_facts answers NO_MATCHING_FACTS when nothing clears the relevance
 *   floor and the prompt makes the agent reply "I do not know that yet." at once.
 * Context-in-prompt fallback (still inside the harness): tool path unavailable
 *   (MCP health check fails, HARNESS_TOOLS_MODE=none, or the agent answered
 *   "don't know" after a failed tool call): the app retrieves itself (stages
 *   kb -> vectordb) and passes the context in the prompt.
 * Guard (no tool call / no ANSWER: line / invalid tool call): the session keeps
 *   its history, so an answer produced without any tool call is ungrounded (it
 *   may describe a fact deleted since) and is never shown: on the tool path
 *   answer tokens are held back until a tool call has been observed. Malformed
 *   or failed harness tool calls (OpenCode's `invalid` tool) never count as one.
 *   Text before ANSWER: is reasoning and is never streamed; a run that ends
 *   without an ANSWER: line has no answer at all. In each case the model text is
 *   discarded and the app runs search_facts itself, reporting it through the
 *   same tool / gateway / vectordb events the MCP server would send (source
 *   'app') so the scene animates the search. With no hits the answer is "I do
 *   not know that yet." instantly (no second model run, `fallback: "guard"`);
 *   with hits there is exactly one more model run with the context in the prompt
 *   (`fallback: "context"`, `reason: "no tool call" | "no ANSWER: line" |
 *   "invalid tool call"`). That run is held to the same rule: no ANSWER: line
 *   means "I do not know that yet."
 * Anything else surfaces as an error; server/app.js then replays a recording
 *   (REPLAY_FALLBACK). There is no other model backend.
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
      databaseUrl: env.DATABASE_URL,
      table: env.PGVECTOR_TABLE || 'anatomy_chunks',
      // DO_INFERENCE_URL / DO_INFERENCE_KEY only serve the optional remote embedding model;
      // answer generation always happens inside the harness session.
      inference: {
        url: embedding.url,
        key: embedding.key,
        embeddingModel: embedding.embeddingModel,
      },
      embedding,
      scoreFloor: scoreFloor(embedding),
      harness: harnessConfig(env),
      mcpToken: env.MCP_AUTH_TOKEN || '',
      mcpHealthTtlMs: Number(env.MCP_HEALTH_TTL_MS) >= 0 ? Number(env.MCP_HEALTH_TTL_MS) : DEFAULT_MCP_HEALTH_TTL_MS,
      dim: embedding.dim,
    };
    this.harness = new HarnessClient(this.cfg.harness);
    this._s3 = null;
    this._pool = null;
    this._ready = null;
    this.count = 0;
    this.migration = null; // result of the last embedding migration run at boot (see db()); shown in /api/health
    this.activeRun = null; // the question job currently running in the harness (tool events attach to it)
    this.askQueue = Promise.resolve();
    this.mcpHealth = null; // last MCP health check { ok, reason?, at }; primed at warm-up, refreshed in the background (see mcpHealthy)
    this.mcpHealthRefresh = null;
  }

  describe() {
    const h = this.cfg.harness;
    return {
      mode: this.mode,
      chunks: this.count,
      spaces: Boolean(this.cfg.spaces.key && this.cfg.spaces.bucket),
      database: Boolean(this.cfg.databaseUrl),
      inference: Boolean(this.cfg.inference.key),
      harness: Boolean(h.token),
      harnessModel: h.model,
      harnessSession: this.harness.sessionName || h.sessionName,
      harnessSessionId: this.harness.sessionId,
      harnessConfigId: h.configId || null,
      harnessReasoningEffort: h.reasoningEffort,
      // session hygiene (see HarnessClient.rotate)
      harnessQuestions: this.harness.questionCount,
      harnessRotateAfter: h.rotateAfter,
      harnessRotateIdleMs: h.rotateIdleMs,
      harnessRotations: this.harness.rotations,
      harnessRotating: Boolean(this.harness.rotating),
      harnessLastRotation: this.harness.lastRotation,
      harnessLastRotationError: this.harness.lastRotationError,
      // the persistent event stream of the current session (see HarnessClient.SessionStream)
      harnessStream: this.harness.streamStatus(),
      harnessFirstTokenTimeoutMs: h.firstTokenTimeoutMs,
      mcpHealth: this.mcpHealth,
      toolsMode: h.toolsMode,
      mcp: Boolean(h.mcpUrl),
      inferenceVia: this.inferenceVia(),
      embedding: this.cfg.inference.embeddingModel || 'local-hash',
      vectorDim: this.cfg.dim,
      scoreFloor: this.cfg.scoreFloor,
    };
  }

  /** How the model is reached: `harness` (Serverless Inference inside the Harness Runtime session) or nothing configured. */
  inferenceVia() {
    return this.cfg.harness.token ? 'harness' : null;
  }

  /**
   * Session hygiene test hook (POST /api/harness/rotate): start a background rotation of the
   * harness session. Returns { started, skipped? } at once; questions never wait on it.
   */
  rotateSession(reason = 'manual') {
    const { started, skipped } = this.harness.rotate(reason);
    return { started, ...(skipped ? { skipped } : {}) };
  }

  /**
   * Startup warm-up: find or create the harness session now so the first
   * question of the demo does not pay for session creation / resume. Never
   * throws; errors are logged (the first question retries from scratch).
   * Resolves { ok, skipped?, session?, created?, error? }.
   */
  async warmUp(log = console) {
    if (!this.cfg.harness.token) {
      log.log('[warm-up] skipped: HARNESS_API_TOKEN not set');
      return { ok: false, skipped: true, reason: 'HARNESS_API_TOKEN not set' };
    }
    const t0 = Date.now();
    // prime the MCP health cache now, so no question ever waits for it (never throws)
    if (this.cfg.harness.toolsMode !== 'none') this.mcpHealthy().catch(() => {});
    try {
      const s = await this.harness.ensureSession();
      const h = this.cfg.harness;
      const hygiene = h.configId ? ` · config ${h.configId} · rotate after ${h.rotateAfter || '∞'} questions / ${h.rotateIdleMs ? `${Math.round(h.rotateIdleMs / 60000)} min idle` : 'never idle'}` : '';
      log.log(`[warm-up] harness session ${s.name} ${s.created ? 'created' : 'resumed'} (${s.id}) in ${Date.now() - t0} ms${s.stale ? ' · base session has a stale manifest' : ''}${hygiene}`);
      return { ok: true, session: s.name, sessionId: s.id, created: s.created, ms: Date.now() - t0 };
    } catch (err) {
      log.error(`[warm-up] harness session not ready: ${err.message}`);
      return { ok: false, error: err.message };
    }
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
      // Embedding migration (only the web service runs it; the MCP server never touches the schema):
      // an existing table whose vector(dim) differs from the configured embedder is recreated and
      // every NULL embedding is re-embedded. Never fatal: a failure is logged and shown in /api/health.
      await this.migrateEmbeddings(pool);
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

  /** Run the idempotent embedding migration on `pool`; records the result (or the error) on `this.migration`. */
  async migrateEmbeddings(pool, log = console) {
    const cfg = this.cfg.embedding;
    const startedAt = new Date().toISOString();
    try {
      const out = await migrate(pool, cfg, (texts) => this.embed(texts), { table: this.cfg.table, log });
      this.migration = { ok: true, startedAt, embedding: cfg.embeddingModel || 'local-hash', ...out };
    } catch (err) {
      log.error(`[migrate] failed: ${err.message}`);
      this.migration = { ok: false, startedAt, embedding: cfg.embeddingModel || 'local-hash', dim: cfg.dim, error: err.message };
    }
    return this.migration;
  }

  /**
   * Boot-time database preparation: open the pool now (creating the table and
   * running the embedding migration) instead of on the first request. Never
   * throws; resolves { ok, skipped?, migration?, error? }.
   */
  async prepareDb(log = console) {
    if (!this.cfg.databaseUrl) {
      log.log('[migrate] skipped: DATABASE_URL not set');
      return { ok: false, skipped: true, reason: 'DATABASE_URL not set' };
    }
    try {
      await this.db();
      return { ok: Boolean(this.migration?.ok), migration: this.migration };
    } catch (err) {
      log.error(`[migrate] database not ready: ${err.message}`);
      return { ok: false, error: err.message, migration: this.migration };
    }
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

      // chunk + embed happen right here, in the App Platform web service (no DO Function involved);
      // the stage keeps its wire name `functions` so recordings and the frontend contract stay stable
      ev.stage('functions', 'start', 'App Platform: chunk + embed in-process', { key, where: 'app-platform' });
      const chunks = chunkText(text);
      ev.stage('functions', 'progress', `Chunked into ${chunks.length} chunks`, { step: 'chunk', chunks: chunks.length });
      const embeddings = await this.embed(chunks);
      chunks.forEach((_, i) => ev.stage('functions', 'progress', `Embedded chunk ${i + 1}/${chunks.length} (${this.cfg.dim} dims)`, { step: 'embed', index: i, total: chunks.length }));
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
   * Answer a question through the Harness Runtime: the agent retrieves through
   * the MCP tools itself (see class docs), falling back to context in the
   * prompt when the tool path is unavailable. Resolves
   * { jobId, answer, sources, timing: {firstTokenMs, totalMs, toolCalls, reasoningTokens}, backend: 'harness', fallback?, reason? }.
   */
  async ask(question) {
    const jobId = randomUUID();
    const ev = this.bus.forJob(jobId, 'query');
    const t0 = Date.now();
    ev.job('start', { input: question });
    try {
      if (!this.inferenceVia()) throw new Error('HARNESS_API_TOKEN missing (or DIGITALOCEAN_ACCESS_TOKEN): questions are answered by the Harness Runtime session');
      // one harness run at a time so tool events are attributed to the right job
      const run = this.askQueue.then(() => this.askViaHarness(question, ev, jobId, t0));
      this.askQueue = run.catch(() => {});
      const result = await run;
      const { answer, sources } = result;
      ev.answer(answer, sources);
      ev.job('done', { answer, sources, timing: result.timing, backend: result.backend, fallback: result.fallback, reason: result.reason });
      return { jobId, ...result };
    } catch (err) {
      ev.job('error', { message: err.message });
      throw Object.assign(err, { jobId, flow: 'query' });
    }
  }

  /** `GET <MCP_PUBLIC_URL>/health` with a short timeout: is the tool path reachable? Uncached. */
  async mcpHealthCheck() {
    const url = this.cfg.harness.mcpUrl;
    const done = (r) => { this.mcpHealth = { ...r, at: Date.now() }; return this.mcpHealth; };
    if (!url) return done({ ok: false, reason: 'MCP_PUBLIC_URL not set' });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), MCP_HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`${url}/health`, { signal: ac.signal });
      if (!res.ok) return done({ ok: false, reason: `MCP health HTTP ${res.status}` });
      return done({ ok: true });
    } catch (err) {
      return done({ ok: false, reason: `MCP health ${ac.signal.aborted ? 'timed out' : err.message}` });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * MCP health off the critical path: a result younger than MCP_HEALTH_TTL_MS is reused; an older
   * one is reused too while one refresh runs in the background. Only the very first check (no
   * result at all, i.e. the warm-up did not run) is waited for.
   */
  async mcpHealthy() {
    const h = this.mcpHealth;
    if (!h) return this.mcpHealthRefresh || (this.mcpHealthRefresh = this.mcpHealthCheck().finally(() => { this.mcpHealthRefresh = null; }));
    if (Date.now() - h.at >= this.cfg.mcpHealthTtlMs && !this.mcpHealthRefresh) {
      this.mcpHealthRefresh = this.mcpHealthCheck().finally(() => { this.mcpHealthRefresh = null; });
    }
    return h;
  }

  /**
   * Answer flow through the Harness Runtime. Returns
   * { answer, sources, backend: 'harness', timing, fallback, reason }.
   */
  async askViaHarness(question, ev, jobId, t0) {
    const h = this.cfg.harness;
    const dontKnow = dontKnowText(question); // the fixed answer in the question's language (Spanish or English)
    const run = { jobId, ev, toolCalls: 0, toolDone: 0, toolErrors: 0, harnessToolEvents: 0, invalidToolEvents: 0, hits: [], seen: new Set() };
    this.activeRun = run;
    let firstTokenMs = null;
    let streamed = 0;
    let reasoningTokens = 0; // run.usage_recorded reasoning_tokens summed over this question's harness runs
    const askHarness = async (prompt, hk) => {
      const out = await this.harness.ask(prompt, hk);
      reasoningTokens += out.reasoningTokens || 0;
      return out;
    };
    // A tool call "observed" for this run: reported by the MCP server (primary) or seen on the harness SSE stream.
    // Malformed / failed harness tool calls (tool `invalid`, run.tool_call_failed) are counted apart and never count as seen.
    const toolSeen = () => run.toolCalls > 0 || run.harnessToolEvents > 0;
    // A clean answer: the model wrote an ANSWER: line (MarkerFilter returns '' + noMarker when it never did).
    const clean = (out) => Boolean(out && out.text && !out.noMarker);
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
    const timing = () => ({ firstTokenMs, totalMs: Date.now() - t0, toolCalls: run.toolCalls, reasoningTokens });
    let sources = [];
    let answer = '';
    const backend = 'harness';
    let fallback = null;
    let reason = null;
    let harnessOut = null;
    const describe = (s) => ev.stage('agent', 'progress', s.created ? `Harness session ${s.name} created (manifest ${s.hash})` : `Harness session ${s.name} ready${s.stale ? ' (base session has a stale manifest)' : ''}`, { step: 'session', created: s.created, name: s.name, via: 'harness', toolsMode: s.toolsMode, hash: s.hash });
    const hooks = (label) => ({
      onSession: describe,
      onStarted: (ms) => ev.stage('agent', 'progress', `Harness run started (+${ms} ms)${label ? ` · ${label}` : ''}`, { step: 'run', ms, via: 'harness' }),
      onToolEvent: (t) => {
        if (t.invalid) run.invalidToolEvents++;
        else run.harnessToolEvents++;
        ev.tool({ ...this.harnessToolEvent(run, t), invalid: Boolean(t.invalid) });
      },
      onToken,
    });
    const contextRun = async (detail, why, because, found = null) => {
      // context-in-prompt fallback: the app retrieves itself (unless the guard search already did) and passes the context in the prompt
      gate.enabled = false;
      gate.held.length = 0;
      sources = found || (await this.retrieve(question, ev));
      const context = sources.map((s, i) => `[${i + 1}] ${s.chunk}`).join('\n');
      ev.stage('inference', 'start', `Serverless inference via harness: ${h.model}`, { model: h.model, via: 'harness', toolsMode: 'none' });
      harnessOut = await askHarness(buildPrompt(question, context, { effort: h.reasoningEffort }), hooks(detail));
      fallback = why;
      reason = because || null;
      if (clean(harnessOut)) { answer = harnessOut.text; return; }
      // same rule as the tool path: no ANSWER: line means no answer; reasoning is never shown
      ev.stage('agent', 'progress', `Context run produced no ANSWER: line: answering "${dontKnow}"`, { fallback, reason, noMarker: true, via: 'harness' });
      if (streamed === 0) forward(dontKnow, 0);
      answer = dontKnow;
    };

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
        harnessOut = await askHarness(buildToolPrompt(question, { gateway: h.toolsMode === 'gateway', effort: h.reasoningEffort }), hooks('tool path'));
        answer = harnessOut.text;
        sources = run.hits.slice();
        if (!toolSeen() || !clean(harnessOut)) {
          // GUARD: no (valid) tool call at all -> the answer is ungrounded (likely recalled from an earlier
          // turn, possibly about a fact that has since been deleted); no ANSWER: line (the model only
          // reasoned, or rambled after a malformed tool call) -> there is no answer at all. Either way the
          // model text is discarded and the app runs the search itself.
          const why = run.invalidToolEvents > 0 && !clean(harnessOut) ? 'invalid tool call' : !toolSeen() ? 'no tool call' : 'no ANSWER: line';
          const held = gate.held.length;
          gate.held.length = 0;
          gate.enabled = false;
          const what = streamed > 0 ? 'the ungrounded answer already streamed was discarded; the final answer replaces it' : held ? `ungrounded answer discarded unseen (${held} held token${held === 1 ? '' : 's'})` : 'nothing after ANSWER: was produced, so nothing was streamed';
          const lead = why === 'no tool call' ? 'Harness answered without calling any tool' : why === 'invalid tool call' ? `Harness made ${run.invalidToolEvents} invalid/failed tool call${run.invalidToolEvents === 1 ? '' : 's'} and no clean answer` : 'Harness finished without an ANSWER: line';
          ev.stage('agent', 'progress', `${lead}: ${what}; the app runs search_facts itself`, { guard: 'search', reason: why, discarded: true, streamed, held, invalidTool: run.invalidToolEvents, noMarker: Boolean(harnessOut.noMarker), via: 'harness' });
          answer = '';
          const found = await this.guardSearch(question, run);
          if (!found.length) {
            // nothing stored matches: the answer is known without a second model run
            fallback = 'guard';
            reason = `${why}, no matching facts`;
            sources = [];
            ev.stage('agent', 'progress', `No matching facts: answering "${dontKnow}" without a second model run`, { fallback, reason, via: 'harness' });
            forward(dontKnow, 0);
            answer = dontKnow;
          } else {
            ev.stage('agent', 'progress', `${found.length} matching chunk${found.length === 1 ? '' : 's'}: one model run with the context passed in prompt`, { fallback: 'context', reason: why, hits: found.length, via: 'harness' });
            await contextRun(`context (${why})`, 'context', why, found);
          }
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
      ev.stage('inference', 'done', fallback === 'guard' ? 'Completed without a second model run (no matching facts)' : 'Completed', { model: harnessOut.model || h.model, tokens: fallback === 'guard' ? 1 : harnessOut.tokens, via: 'harness', ...t });
      ev.stage('agent', 'done', `Harness answered (first token ${t.firstTokenMs ?? '—'} ms, total ${t.totalMs} ms, ${t.toolCalls} tool call${t.toolCalls === 1 ? '' : 's'}${t.reasoningTokens ? `, ${t.reasoningTokens} reasoning tokens` : ''})`, { via: 'harness', ...t, runId: harnessOut.runId, backend, fallback, reason });
      if (!answer) answer = dontKnow;
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
    this.reportTool(run, body, 'mcp');
    return run ? { accepted: true, jobId: run.jobId } : { accepted: false };
  }

  /**
   * Publish one tool-call phase (`start` / `done` / `error`) as a `tool` event plus
   * `gateway` and target (`vectordb` / `spaces`) stage events on `run`'s job.
   * `source` is `mcp` for calls the MCP server reported (they count as the
   * model's tool calls) or `app` for the guard search the app ran itself after
   * the model skipped the tool (same events, so the scene animates it the same
   * way, but counted apart so timing.toolCalls stays honest).
   */
  reportTool(run, body = {}, source = 'mcp') {
    const tool = String(body.tool || 'unknown');
    const phase = ['start', 'done', 'error'].includes(body.phase) ? body.phase : 'done';
    const target = body.target === 'spaces' || body.target === 'pgvector' ? body.target : tool === 'get_document' ? 'spaces' : 'pgvector';
    const stage = target === 'spaces' ? 'spaces' : 'vectordb';
    const args = body.args && typeof body.args === 'object' ? body.args : {};
    const hits = Array.isArray(body.hits) ? body.hits : [];
    const ms = Number.isFinite(body.ms) ? body.ms : undefined;
    const data = { tool, phase, args, summary: body.summary, ms, target, callId: body.callId, hits: hits.length, error: body.error, source };
    if (!run) {
      this.bus.publish({ type: 'tool', flow: 'query', jobId: null, data });
      return data;
    }
    const { ev } = run;
    const byApp = source === 'app';
    ev.tool(data);
    const base = { tool, callId: body.callId, args, op: 'tool', target, source };
    if (phase === 'start') {
      if (byApp) run.guardSearches = (run.guardSearches || 0) + 1;
      else run.toolCalls++;
      ev.stage('gateway', 'start', `TOOL ${tool}(${fmtArgs(args)}) → ${target}${byApp ? ' · run by the app (harness skipped the tool)' : ''}`, base);
      ev.stage(stage, 'start', byApp ? `${tool} run by the app via the gateway path (harness skipped the tool)` : `${tool} via Action Gateway`, base);
    } else if (phase === 'done') {
      if (!byApp) run.toolDone++;
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
      if (!byApp) run.toolErrors++;
      ev.stage(stage, 'error', `${tool} failed: ${body.error || 'unknown error'}`);
      ev.stage('gateway', 'error', `TOOL ${tool}(${fmtArgs(args)}) → ${target} failed: ${body.error || 'unknown error'}`);
    }
    return data;
  }

  /**
   * GUARD search: the model skipped search_facts, so the app runs the same
   * pgvector search itself and reports it through the same tool / gateway /
   * vectordb events the MCP server would have sent (source `app`). Resolves the
   * hits as sources (also collected on `run.hits`); a database error propagates
   * (the job fails; server/app.js may then replay a recording).
   */
  async guardSearch(question, run) {
    const callId = randomUUID();
    const args = { query: question, k: SEARCH_K };
    const call = { callId, tool: 'search_facts', args, target: 'pgvector' };
    const t0 = Date.now();
    this.reportTool(run, { ...call, phase: 'start' }, 'app');
    try {
      const [qvec] = await this.embed([question]);
      const pool = await this.db();
      const hits = await cosineSearch(pool, this.cfg.table, qvec, SEARCH_K, this.cfg.scoreFloor);
      this.reportTool(run, { ...call, phase: 'done', ms: Date.now() - t0, hits, summary: `${hits.length} hit${hits.length === 1 ? '' : 's'}` }, 'app');
      return hits.map((h) => ({ id: h.id, chunk: h.chunk, score: h.score, object_key: h.object_key, origin: 'search_facts' }));
    } catch (err) {
      this.reportTool(run, { ...call, phase: 'error', ms: Date.now() - t0, error: err.message }, 'app');
      throw err;
    }
  }

  /** Embed the question and run a cosine top-3 search in pgvector, emitting kb/vectordb stage events (app-side retrieval). */
  async retrieve(question, ev) {
    ev.stage('kb', 'start', 'App-side retrieval: embedding the question', { question });
    const [qvec] = await this.embed([question]);
    ev.stage('kb', 'progress', 'Query embedded', { step: 'embed' });
    ev.stage('vectordb', 'start', 'pgvector cosine search, top 3', { op: 'search' });
    const pool = await this.db();
    const sources = await cosineSearch(pool, this.cfg.table, qvec, 3, this.cfg.scoreFloor);
    ev.stage('vectordb', 'done', `${sources.length} relevant chunk${sources.length === 1 ? '' : 's'} retrieved`, { count: this.count, hits: sources.map((s) => ({ id: s.id, score: s.score })), op: 'search' });
    ev.stage('kb', 'done', `Context assembled from ${sources.length} chunk${sources.length === 1 ? '' : 's'}`, { hits: sources.length });
    return sources;
  }
}
