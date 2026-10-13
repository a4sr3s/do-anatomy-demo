/**
 * "anatomy-data" MCP tool server (architecture v4).
 *
 * A second App Platform service, routed at /mcp on the same app, that exposes
 * the demo's data plane as two Model Context Protocol tools the Harness
 * Runtime agent can call (directly, or through the Action Gateway):
 *
 *   search_facts({query, k})  -> pgvector cosine search (same embedder as ingest)
 *   get_document({key})       -> object text from Spaces (facts/ prefix only)
 *
 * Transport: Streamable HTTP, stateless (a fresh transport per request), at
 * POST/GET/DELETE /mcp, protected by `Authorization: Bearer <MCP_AUTH_TOKEN>`.
 * Every tool call is reported to the web backend (TOOL_EVENT_URL) so the
 * anatomy scene can animate the ACTION GATEWAY -> pgvector / Spaces hops.
 *
 * `createMcpApp({ env, deps })` is exported for tests: `deps` lets a test
 * inject a fake database (`query`), a fake object store (`getObject`) and a
 * fake `fetch` for the tool-event webhook.
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { cosineSearch, createPool, embedTexts, embeddingConfig } from '../server/pipeline/retrieval.js';
import { tokenEquals } from '../server/auth.js';

export const SERVER_NAME = 'anatomy-data';
export const MAX_DOC_BYTES = 8 * 1024;
const EVENT_TIMEOUT_MS = 1500;

/** Bearer check; accepts "Bearer <token>" or the raw token (constant-time). */
export const tokenMatches = (header, expected) => tokenEquals(header, expected, { bearer: true });

export function mcpConfig(env) {
  return {
    token: env.MCP_AUTH_TOKEN || '',
    table: env.PGVECTOR_TABLE || 'anatomy_chunks',
    embedding: embeddingConfig(env),
    spaces: {
      key: env.DO_SPACES_KEY,
      secret: env.DO_SPACES_SECRET,
      region: env.DO_SPACES_REGION || 'nyc3',
      bucket: env.DO_SPACES_BUCKET,
      endpoint: env.DO_SPACES_ENDPOINT || `https://${env.DO_SPACES_REGION || 'nyc3'}.digitaloceanspaces.com`,
    },
    toolEventUrl: env.TOOL_EVENT_URL || '',
  };
}

/** Lazily built clients so a misconfigured Spaces/DB only fails the tool that needs it. */
function defaultDeps(env, cfg) {
  let pool = null;
  let s3 = null;
  return {
    async query(sql, params) {
      if (!pool) pool = await createPool(env);
      return pool.query(sql, params);
    },
    async getObject(key) {
      if (!cfg.spaces.key || !cfg.spaces.secret) throw new Error('Spaces credentials missing (DO_SPACES_KEY / DO_SPACES_SECRET)');
      if (!cfg.spaces.bucket) throw new Error('DO_SPACES_BUCKET missing');
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
      if (!s3) s3 = new S3Client({ region: cfg.spaces.region, endpoint: cfg.spaces.endpoint, forcePathStyle: false, credentials: { accessKeyId: cfg.spaces.key, secretAccessKey: cfg.spaces.secret } });
      const out = await s3.send(new GetObjectCommand({ Bucket: cfg.spaces.bucket, Key: key, Range: `bytes=0-${MAX_DOC_BYTES - 1}` }));
      return { text: await out.Body.transformToString('utf8'), bytes: out.ContentLength ?? null };
    },
    fetch: (...a) => fetch(...a),
    embed: (texts) => embedTexts(cfg.embedding, texts),
  };
}

/** Build the MCP server with both tools bound to `deps`. One instance per request (stateless). */
export function buildMcpServer(cfg, deps, emit) {
  const server = new McpServer({ name: SERVER_NAME, version: '4.0.0' }, { instructions: 'Tools over the anatomy demo facts stored in pgvector and Spaces. Call search_facts first with the user question; call get_document only when a hit needs its full source object.' });

  server.registerTool(
    'search_facts',
    {
      title: 'Search facts (pgvector)',
      description:
        'Semantic search over the submitted facts stored in Managed Postgres with pgvector. ' +
        'Pass the user question as `query`; returns the most similar fact chunks as JSON [{id, object_key, chunk, score}], best first. ' +
        'An empty list means nothing relevant is known yet. Always call this before answering.',
      inputSchema: { query: z.string().min(1).max(2000).describe('The question or search text'), k: z.number().int().min(1).max(5).optional().describe('Max results, 1-5 (default 3)') },
    },
    async ({ query, k }) => {
      const callId = randomUUID();
      const args = { query, k: k ?? 3 };
      const t0 = Date.now();
      emit({ phase: 'start', callId, tool: 'search_facts', args, target: 'pgvector' });
      try {
        const [qvec] = await deps.embed([query]);
        const hits = await cosineSearch(deps, cfg.table, qvec, args.k);
        const ms = Date.now() - t0;
        emit({ phase: 'done', callId, tool: 'search_facts', args, target: 'pgvector', ms, hits: hits.map((h) => ({ id: h.id, score: h.score, chunk: h.chunk, object_key: h.object_key })), summary: `${hits.length} hit${hits.length === 1 ? '' : 's'}` });
        return { content: [{ type: 'text', text: JSON.stringify(hits) }], structuredContent: { hits } };
      } catch (err) {
        emit({ phase: 'error', callId, tool: 'search_facts', args, target: 'pgvector', ms: Date.now() - t0, error: err.message });
        return { isError: true, content: [{ type: 'text', text: `search_facts failed: ${err.message}` }] };
      }
    }
  );

  server.registerTool(
    'get_document',
    {
      title: 'Get document (Spaces)',
      description:
        'Fetch the full text of one stored fact object from DigitalOcean Spaces by its `object_key` (as returned by search_facts, always under the facts/ prefix). ' +
        'Only needed when a search hit is truncated or you need surrounding context; at most 8 KB is returned.',
      inputSchema: { key: z.string().min(1).max(512).describe('Object key from search_facts, e.g. facts/1712345678-abcd1234.txt') },
    },
    async ({ key }) => {
      const callId = randomUUID();
      const args = { key };
      const t0 = Date.now();
      emit({ phase: 'start', callId, tool: 'get_document', args, target: 'spaces' });
      try {
        if (!/^facts\/[A-Za-z0-9._\-\/]+$/.test(key) || key.includes('..')) throw new Error('only keys under facts/ can be read');
        const { text, bytes } = await deps.getObject(key);
        const body = text.length > MAX_DOC_BYTES ? text.slice(0, MAX_DOC_BYTES) : text;
        const ms = Date.now() - t0;
        emit({ phase: 'done', callId, tool: 'get_document', args, target: 'spaces', ms, summary: `${body.length} chars`, hits: [{ id: key, object_key: key, chunk: body.slice(0, 220), score: null }] });
        return { content: [{ type: 'text', text: body }], structuredContent: { key, text: body, bytes: bytes ?? body.length } };
      } catch (err) {
        emit({ phase: 'error', callId, tool: 'get_document', args, target: 'spaces', ms: Date.now() - t0, error: err.message });
        return { isError: true, content: [{ type: 'text', text: `get_document failed: ${err.message}` }] };
      }
    }
  );
  return server;
}

/** Fire-and-forget POST to the web backend; never throws, 1.5 s timeout. */
export function toolEventEmitter(cfg, fetchImpl, log = console) {
  if (!cfg.toolEventUrl) return () => {};
  return (event) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), EVENT_TIMEOUT_MS);
    Promise.resolve()
      .then(() =>
        fetchImpl(cfg.toolEventUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-tool-event-token': cfg.token },
          body: JSON.stringify({ ts: Date.now(), ...event }),
          signal: ac.signal,
        })
      )
      .then((res) => {
        if (res && !res.ok) log.warn?.(`[mcp] tool-event ${event.phase} ${event.tool}: HTTP ${res.status}`);
      })
      .catch((err) => log.warn?.(`[mcp] tool-event ${event.phase} ${event.tool}: ${err.message}`))
      .finally(() => clearTimeout(timer));
  };
}

export function createMcpApp({ env = process.env, deps, log = console } = {}) {
  const cfg = mcpConfig(env);
  const d = { ...defaultDeps(env, cfg), ...(deps || {}) };
  const emit = toolEventEmitter(cfg, (...a) => d.fetch(...a), log);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  app.get('/mcp/health', (req, res) => res.json({ ok: true, server: SERVER_NAME, tools: ['search_facts', 'get_document'] }));
  app.get('/health', (req, res) => res.json({ ok: true, server: SERVER_NAME }));

  const auth = (req, res, next) => {
    if (!tokenMatches(req.get('authorization'), cfg.token)) {
      return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    }
    next();
  };

  // Stateless Streamable HTTP: a new server + transport per request, closed when the response ends.
  const handle = async (req, res) => {
    const server = buildMcpServer(cfg, d, emit);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error?.('[mcp] request failed:', err.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  };
  app.post('/mcp', auth, handle);
  app.get('/mcp', auth, handle);
  app.delete('/mcp', auth, handle);
  app.use((req, res) => res.status(404).json({ ok: false, error: 'not found' }));
  return { app, cfg, deps: d, emit };
}
