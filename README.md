# Anatomy of a DigitalOcean Data Pipeline

An interactive 3D isometric "anatomy" view of a live retrieval-augmented AI pipeline on DigitalOcean, built for the DigitalOcean Solutions conference demo on model building, data, and customization.

Seven DigitalOcean components sit on a rotatable isometric stage as glowing wireframes (architecture **v4**):

```
ingest:   Client ──▶ Spaces ──▶ App Platform ──▶ Managed Postgres (pgvector)
                    (upload)   (chunk+embed,         (vector store)
                                in the web service)

question: Client ──▶ Harness Runtime ──▶ Action Gateway ──▶ anatomy-data MCP server ──▶ pgvector  (search_facts)
                     (OpenCode agent,     (tool policy,      (mcp/, Streamable HTTP)  └─▶ Spaces    (get_document)
                      gpt-oss-20b on       routing)
                      Serverless Inference) ◀────────────── tool results ◀──────────────────┘
                              └──▶ Serverless Inference streams the grounded answer back to the Client
```

- **Submit a fact** and a glowing packet flies Spaces → App Platform (the web service's gears + press chunk and embed it in-process) → pgvector (a cube lands in a chamber).
- **Ask a question** and the packet goes to the **HARNESS RUNTIME** machine. The agent inside decides to call `search_facts`; the packet hops to the **ACTION GATEWAY** (the selector swings towards pgvector, the policy lamps flash), on to pgvector (scanner sweeps, the matching cubes flash), and back. Then **SERVERLESS INFERENCE** (gpt-oss-20b) spins up and every token rides the return track to the client.
- Hover any component for a one-line explainer; click to pin a longer one in the sidebar inspector.
- Every animation is driven by **real backend events over Server-Sent Events**. Nothing is a canned loop: the frontend reacts to `stage`, `tool`, `job` and `answer` events emitted by the pipeline, and the tool events come from the MCP server itself.

## Run locally

Requires Node 20+.

```bash
npm install
npm run dev        # Express API on :8080 + Vite dev server on :5173 (proxying /api)
```

Open <http://localhost:5173>. No credentials needed in the default mock mode.

Production-style run (server serves the built frontend from `dist/`):

```bash
npm run build
npm start          # http://localhost:8080
```

Other scripts:

| Script | What it does |
| --- | --- |
| `npm test` | `node:test` suite: mock pipeline round-trip, HTTP/SSE API, recorder/replay, real pipeline (ingest, tool events, harness-only answers, warm-up), Harness Runtime client (manifest modes, session fingerprint, config-based creation, session resolution and rotation, reasoning effort, tool path, context-in-prompt fallback), MCP server (auth, tools/list, tool calls, tool events) and the internal tool-event / rotate endpoints |
| `npm run start:mcp` | Starts the `anatomy-data` MCP tool server (`mcp/index.js`) on `PORT` (default 8081) |
| `npm run record:samples` | Regenerates `recordings/sample-ingest.json` and `sample-query.json` from the mock pipeline |

## Modes (`PIPELINE_MODE`)

Copy `.env.example` to `.env` and adjust. Every variable is documented there.

### `mock` (default)

No credentials. Each stage is simulated with realistic timing (`MOCK_DELAY_SCALE=1`; set `0` for instant, `2` for slow motion on a big screen). Facts are chunked and embedded in-process (stage `functions`, as in real mode) with a local 128-dim hashed bag-of-words embedding, and stored in memory. Asking about a submitted fact emits the same v4 event sequence as real mode (harness `agent` stage → `gateway`/`tool` events → pgvector search via tool → inference tokens), really retrieves it through cosine similarity, and the "model" composes the answer from the retrieved chunks, streamed word by word.

### `real`

Wired for DigitalOcean. Dependencies are imported lazily, so mock mode never loads them.

| Stage | Service | Implementation |
| --- | --- | --- |
| Spaces | `@aws-sdk/client-s3` | `PutObject` of the fact as `facts/<ts>-<id>.txt` |
| App Platform · chunk & embed | this web service (SSE stage `functions`, the wire name) | Right after the Spaces PUT the server chunks the text and embeds every chunk in-process; no separate DO Function exists |
| Vector DB | `pg` + pgvector | `CREATE EXTENSION vector`, table auto-created, `INSERT ... ::vector`, `ORDER BY embedding <=> $1` |
| Harness Runtime | Managed Agents Harness Runtime (`HARNESS_API_TOKEN` or `DIGITALOCEAN_ACCESS_TOKEN`, `HARNESS_INFERENCE_API_KEY`) | One named session (`HARNESS_SESSION_NAME`, default `alexis-anatomy-harness-v4b`; agent `opencode`, `mars-1vcpu-1gb`, idle timeout 30 m, model `HARNESS_MODEL`) is found by name (or by its `-r<ts>` rotation) or created from the Environment Config `HARNESS_CONFIG_ID` (JSON `{name, config_id}`; the YAML manifest form is only used when the config id is `none`). Each question is one `POST /v2/agents/sessions/{id}/input`; the answer is read from the session's SSE event stream. The prompt tells the agent to call `search_facts` exactly once (and `get_document` only if needed), answer only from tool results and end with one `ANSWER:` line; everything before the marker (gpt-oss thinking) is hidden. When nothing clears the relevance floor `search_facts` returns the plain line `NO_MATCHING_FACTS: answer exactly "I do not know that yet."` and the prompt makes the agent reply exactly that at once, with no further tool calls or reasoning. The prompt is sent with every `input`, not baked into the session manifest, so prompt changes apply to the existing session on the next question. Its very first line can be the gpt-oss Harmony reasoning hint `Reasoning: low` when `HARNESS_REASONING_EFFORT` is `low`, `medium` or `high` (default `off`: no line; `low` was measured to make gpt-oss-20b answer "I do not know" despite a matching search hit); the input API has no reasoning parameter |
| Action Gateway / MCP | `mcp/` service, `HARNESS_TOOLS_MODE` | `inline` (default): the manifest declares the MCP server directly (`tools: - name: anatomy-data, url: MCP_PUBLIC_URL, tools: [search_facts, get_document], auth: {header: Authorization, secret: ANATOMY_MCP_TOKEN}`), with `permissions.default: deny` and allow rules for the two tools. `gateway`: the manifest selects `do.actions` tools (`HARNESS_GATEWAY_TOOLS`, preloaded) after the MCP server was registered as a custom provider. `none`: no tools |
| MCP server | `@modelcontextprotocol/sdk`, Streamable HTTP, stateless | `search_facts({query, k≤5})` embeds the query with the **same** embedder as ingest and runs the pgvector cosine search (score > 0.52 with a hosted model such as bge-m3, > 0.08 with the local hash embedder); `get_document({key})` reads a `facts/` object from Spaces (≤ 8 KB). Bearer auth with `MCP_AUTH_TOKEN`. Every call is reported to the web service (`TOOL_EVENT_URL`, header `x-tool-event-token`), fire-and-forget with a 1.5 s timeout |
| Serverless Inference | gpt-oss-20b inside the harness session (`HARNESS_MODEL`, `HARNESS_INFERENCE_API_KEY`) | The model the OpenCode agent runs on; there is no direct `/chat/completions` call from the app. Answer tokens are forwarded as `inference` `progress` events `{token, index}` |
| Embeddings | `DO_EMBEDDING_MODEL` (`bge-m3` in `.do/app.yaml`, needs `DO_INFERENCE_KEY` or falls back to `HARNESS_INFERENCE_API_KEY`) | OpenAI-compatible `/embeddings`; bge-m3 is multilingual (1024 dims, `VECTOR_DIM=1024`), so a Spanish question finds an English fact. Leave empty to use the local embedder (`VECTOR_DIM=128`), which needs no key at all. The MCP service must use the same setting |
| Embedding migration | `server/pipeline/migrate.js`, `npm run migrate:embeddings` | At boot the web service compares the pgvector column's `vector(n)` with `VECTOR_DIM`; on a mismatch it recreates the column and re-embeds every row (batches of 16), and rows whose embedding is `NULL` are always re-embedded, so an interrupted run resumes. Logged as `[migrate] facts=N rows=M dim=D` and shown in `GET /api/health` as `migration`. Errors never stop the server. The MCP service never migrates. The script runs the same thing by hand (`-- --force` recreates the column anyway) |

**The UI toggle (two answer paths, 2026-10-14).** The ask box offers **Fast · direct inference** (default) and **Agent · Harness + Action Gateway**, sent as `POST /api/ask {question, mode: "fast" | "agent"}` (no secret needed; `GET /api/ask/modes` lists the presets). `fast` resolves to `search-first` on the `direct` backend with reasoning `low`; `agent` to `ANSWER_MODE=tool`. A request without `mode` still gets the configured server default. The scene is driven by the events of the path that actually ran: on the fast path the question travels CLIENT → APP PLATFORM (stage `kb` with `mode: "search-first", backend: "direct"`: the press stamps the query vector, the service searches pgvector over its own track and sends the prompt from its front face to SERVERLESS INFERENCE, stage `inference` `via: "direct"`); the Harness and the Gateway machines stay dark. On the agent path the question goes to the HARNESS RUNTIME, the tool call lights the ACTION GATEWAY → PGVECTOR (or SPACES for `get_document`), then inference streams. The `job done` event and the `/api/ask` response carry `preset` and `timing` (`firstTokenMs`, `totalMs`, `toolCalls`, …); the answer card shows the measured latency of each answer and the last fast / agent pair side by side. Switching the toggle to Agent calls `POST /api/harness/warm` (public, throttled to one wake-up per 10 s, no model run): it thaws a `PAUSED` session (`POST /sessions/{id}/resume`), keeps its event stream attached, runs the idle-rotation check and primes the MCP health, so the first agent question is not the one that wakes the harness. Measurements: `bench/MODE_TOGGLE.md` in the benchmark workspace.

How a question is answered. `ANSWER_MODE` picks the path (`search-first`, the default since 2026-10-14, or `tool`, the agent-with-tools path described in steps 1-5 below); a holder of `MCP_AUTH_TOKEN` can override it per question with `POST /api/ask {question, mode, backend, effort}` plus the `x-tool-event-token` header (used by the benchmarks). The `/api/ask` response carries `answerMode`, `backend` (`harness` or `direct`) and `timing`.

**`ANSWER_MODE=search-first`** (default; one model round, first token ≈0.6 s with a cached query embedding, ≈0.9 s cold, measured live with `SEARCH_FIRST_BACKEND=direct` and `SEARCH_FIRST_REASONING_EFFORT=low`, the defaults): the app embeds the question (query-embedding cache, `EMBED_CACHE_SIZE`) and runs the pgvector search immediately (stages `kb` → `vectordb` `op: "search"` → `kb`), then exactly one model round writes the answer with the facts in the prompt (`buildPrompt`). `SEARCH_FIRST_BACKEND=harness` runs that round in the Harness Runtime session (stage `agent` + `inference`, session rotation applies); `SEARCH_FIRST_BACKEND=direct` streams it from Serverless Inference (`/chat/completions`, `server/pipeline/direct.js`, keep-alive connection, stage `inference` only: no harness is involved, so the Harness machine stays dark). `SEARCH_FIRST_REASONING_EFFORT=low` sends gpt-oss' `reasoning_effort` (direct) or the `Reasoning: low` prompt line (harness). The model still writes every answer, including `I do not know that yet.` / `Todavía no lo sé.` from an empty context; the ANSWER-only filter and the no-`ANSWER:`-line rule are the same as on the tool path. A direct round that fails before its first token is retried once in the harness (`fallback: "harness"`); anything else fails the question (replay fallback upstream). Measurements and the choice of default: `bench/SEARCH_FIRST.md` in the benchmark workspace.

**`ANSWER_MODE=tool`** (the Harness Runtime agent retrieves through the Action Gateway; ≈3.7 s to the first token, and gpt-oss-20b sometimes answers the Spanish question "Todavía no lo sé." despite a hit):

1. Pre-flight `GET <MCP_PUBLIC_URL>/health` (1.5 s timeout) is off the critical path: primed at warm-up, cached for `MCP_HEALTH_TTL_MS` (30 s) and refreshed in the background. Stage `agent` "Harness Runtime (OpenCode, openai-gpt-oss-20b) answering with tools (inline)".
2. The agent calls `search_facts`. The MCP server reports `start`/`done` → the web service emits stage `gateway` (start/done), stage `vectordb` (or `spaces` for `get_document`) with `op: "tool"`, and a `tool` event. The `answer` event's `sources` are the hits the tools returned.
3. Guard (2026-10-14): when the agent writes the fixed "don't know" line although `search_facts` returned hits (seen on gpt-oss-20b with Spanish questions, 0/4 live before the guard), the hits are passed in the prompt for exactly one more model run (`fallback: "context-retry"`, `reason: "don't know despite N hits"`, no second search); unknown questions have no hits and never retry.
4. Tokens stream as `inference` `progress`; stage `agent` `done` carries `firstTokenMs`, `totalMs`, `toolCalls`, `reasoningTokens` (the `reasoning_tokens` of the run's `run.usage_recorded` events). The `/api/ask` response has `timing` and `backend` (`"harness"`) plus `fallback` when the context-in-prompt path was used.
4. **Context-in-prompt fallback** (`fallback: "context"`, still inside the harness): health check failed or `HARNESS_TOOLS_MODE=none` → the app retrieves itself (stages `kb` → `vectordb` → `kb`) and sends the context in the prompt; the stage detail says *Tool path unavailable, context passed in prompt*. If a tool run ends with no usable tool result (a tool error) **and** a "don't know" answer, it is re-run once this way (`fallback: "context-retry"`). Both prompts tell the agent that facts can be added or deleted at any time and earlier turns are stale, to pass the question to `search_facts` exactly as written (no translating; the embedder is multilingual) and to answer in the question's language: a Spanish question gets a Spanish answer and, when nothing matches, `Todavía no lo sé.` instead of `I do not know that yet.` (the app-side guard picks the same text with a small Spanish heuristic). The `ANSWER:` marker never changes.
5. **No-tool-call guard.** The session keeps its conversation history, so on the tool path answer tokens are held back until a tool call has been observed (MCP report or harness stream); a run that completes with **zero** tool calls is treated as ungrounded (it may recall a fact deleted since) and its answer is discarded unseen (stage `agent` progress with `discarded: true`, `guard: "search"`). The app then runs `search_facts` itself and reports it through the same `tool` / `gateway` / `vectordb` events the MCP server would send (`source: "app"`, Logs tab: *run by the app: harness skipped the tool*), so the scene animates the search. With no hits the answer is `I do not know that yet.` instantly, with no second model run (`fallback: "guard"`, `reason: "no tool call, no matching facts"`); with hits there is exactly one more model run with the context passed in the prompt (`fallback: "context"`, `reason: "no tool call"`). The app-side search is not counted in `timing.toolCalls`.
5. If the harness fails before streaming its first answer token (error, or nothing within `HARNESS_FIRST_TOKEN_TIMEOUT_MS`, default 15 s), or anything else goes wrong, the question fails with a clear error; with `REPLAY_FALLBACK=true` the server replays the last good query recording instead. There is no other model backend.

**Event stream.** The session's SSE feed (`GET /v2/agents/sessions/{id}/events`) is attached once per session and kept open across questions (`SessionStream` in `server/pipeline/harness.js`): `POST /input` is sent at once and the run's events are routed by `run_id` (events of a run nobody follows yet are buffered, duplicates dropped by `event_id`). The stream is only re-attached when it actually drops, with `Last-Event-ID` (`HARNESS_ATTACH_TIMEOUT_MS` for the attach, `HARNESS_STREAM_IDLE_MS` of silence triggers a re-attach; a run that times out without a single event forces one too). Opening a fresh attach per question used to cost 3–4 s and sometimes hung, which was the 45 s stall (`bench/INVESTIGATION.md`). An empty `run_id` from `POST /input` is an error (the run could not be followed). `GET /api/health` shows the stream as `harnessStream` (`state`, `attaches`, `drops`, `events`, `lastError`) and the cached MCP check as `mcpHealth`.

`GET /api/health` reports `pipeline.inferenceVia` as `"harness"` (token configured) or `null`, plus `toolsMode`, `pipeline.embedding` / `vectorDim` / `scoreFloor`, the session hygiene state (`harnessSession`, `harnessSessionId`, `harnessConfigId`, `harnessReasoningEffort`, `harnessQuestions`, `harnessRotateAfter`, `harnessRotateIdleMs`, `harnessRotations`, `harnessRotating`, `harnessLastRotation`, `harnessLastRotationError`), and `migration` (the last boot-time embedding migration: `{ ok, facts, rows, dim, previousDim, recreated, reembedded }` or `{ ok: false, error }`; `null` in mock mode).

On boot the server warms the harness up in the background: it finds or creates the named session (`[warm-up] …` in the logs) so the first question on stage does not pay for session creation. Failures are only logged; the first question retries.

**Session hygiene (rotation).** A long-lived session keeps its conversation history and drifts (gpt-oss-20b starts skipping or mangling tool calls), so with `HARNESS_CONFIG_ID` set (default: the config of `alexis-anatomy-harness-v4b`) the session is rotated in the background: after `HARNESS_ROTATE_AFTER` questions (default 15, `0` disables) or when it sat idle longer than `HARNESS_ROTATE_IDLE_MS` before a question (default 20 min, `0` disables), a new session `<name>-r<timestamp>` is created from the config (JSON `{name, config_id}`, so no new config is persisted), polled until `READY`, warmed with one tiny run, then switched in between questions (the switch rides the per-session queue) and the old session is deleted. Questions never wait for a rotation: they keep using the old session until the switch. If the warm-up fails the new session is deleted, the old one keeps serving, `harnessLastRotationError` is set and nothing is retried for 5 minutes. On boot the newest live session named `<name>` or `<name>-r…` created from the config is picked up (older duplicates are deleted in the background), which is how a restart finds the current session. If the session is gone (404) the question creates a fresh `<name>-r…` session and retries. `POST /api/harness/rotate` (header `x-tool-event-token: MCP_AUTH_TOKEN`) starts a rotation by hand and answers `{ ok, started }` at once.

Session manifest fingerprint (only when `HARNESS_CONFIG_ID=none`): the non-secret manifest parts (agent, size, model, tools mode, MCP URL / gateway tools) are hashed into the session label `manifest`. If the named session exists with a different label the app creates `<name>-<hash>` instead of reusing a stale config (nothing is ever deleted). The sessions API currently returns no labels, so in practice an existing base session is reused by name; change `HARNESS_SESSION_NAME` after a manifest change. If the base session is gone, an existing `<name>-<hash>` is reused before anything new is created. The session keeps its conversation history, so a long-lived session can drift (gpt-oss-20b starts skipping or mangling tool calls); renaming the session gives the demo a clean one.

Getting the credentials:

- **Model Access Keys** (`DO_INFERENCE_KEY`, only needed for a remote `DO_EMBEDDING_MODEL`) can only be created in the control panel under *Serverless Inference → Model access keys*; `doctl` and the API cannot mint them. If your account has none, `HARNESS_INFERENCE_API_KEY` is used for `/embeddings` as well; with neither, clear `DO_EMBEDDING_MODEL` and set `VECTOR_DIM=128` to keep the local embedder.
- **Spaces** key pair and a Managed Postgres `DATABASE_URL` (pgvector is enabled automatically on first use).
- **Harness Runtime**: a DigitalOcean API token with Managed Agents access (`HARNESS_API_TOKEN`) and a Serverless Inference key for the model inside the session (`HARNESS_INFERENCE_API_KEY`). The session is created at boot (warm-up) or on the first question; `doctl harness-runtime` lists it.
- **MCP_AUTH_TOKEN**: any long random string, set identically on the web and mcp services.

#### Registering the MCP server as an Action Gateway custom provider (`HARNESS_TOOLS_MODE=gateway`)

The inline mode needs no registration. To route the same tools through the Action Gateway catalog instead:

1. Deploy the `mcp` service and check `https://<app>/mcp/health` returns `{"ok":true}`.
2. In the [Control Panel](https://cloud.digitalocean.com/managed-agents/action-gateway/tools) open **Managed Agents → Action Gateway → Tools → Add custom provider**. Server name `anatomy-data` (the gateway prefixes tool slugs with it), endpoint URL `https://<app>/mcp`, authentication **API key credential** with the value `Bearer <MCP_AUTH_TOKEN>` (the server also accepts the raw token). Click **Connect and discover tools** and enable `search_facts` and `get_document`.
3. Set `HARNESS_TOOLS_MODE=gateway` and `HARNESS_GATEWAY_TOOLS=anatomy-data_search_facts,anatomy-data_get_document` (check the exact slugs on the provider's page) on the web service. The next question creates a new session (the manifest fingerprint changes) whose manifest selects `do.actions` tools with `preload_tools` and allow rules `do.actions/<slug>`; no MCP secret is needed in the manifest because the gateway holds the credential.
4. Tool events still come from the MCP server, so the scene animates exactly the same way.

### Replay

Events can be recorded to `recordings/<name>.json` and replayed with their original timing, so the stage demo keeps working even if Wi-Fi dies.

- **UI:** top bar → `● Record`, run a fact/question, `■ Stop rec`. Pick a recording and `▶ Replay` at 0.5×–4×.
- **Automatic fallback:** when `REPLAY_FALLBACK=true` (default) and a real-mode stage fails with a network/credential error, the server replays the latest successful job of the same flow (`recordings/auto-ingest.json` / `auto-query.json`), or the bundled `sample-*.json`, and tells the UI with a toast. The API response carries `fallback: true`.
- Replayed events are flagged `replay: true`; the mode badge switches to "replay" for the duration.

## API

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | Mode, pipeline description, recorder status |
| `GET /api/events` | SSE stream. Event names: `hello`, `job`, `stage`, `tool`, `answer`, `recorder`, `replay`, `fallback`. Supports `Last-Event-ID` / `?since=` catch-up |
| `POST /api/facts` `{text}` | Ingest a fact; resolves when the pipeline finishes |
| `GET /api/facts` | Stored facts `{facts: [{id, key, text, createdAt, chunks}], total, chunks}` (one per Spaces object; `id` is the key's basename) |
| `DELETE /api/facts/:id` | Remove one fact: its pgvector rows, then its Spaces object. Emits a `delete` flow (`vectordb` / `spaces` stages with `op: "delete"`); 404 if unknown |
| `DELETE /api/facts` | Remove every fact (all rows, then all objects) in one `delete` job |
| `POST /api/ask` `{question, mode?}` | Ask; `mode: "fast"` (search-first, direct inference, reasoning low) or `"agent"` (tool path in the Harness Runtime), no secret needed; without `mode` the configured default. Resolves with `{answer, sources, preset, answerMode, backend, timing: {firstTokenMs, totalMs, toolCalls, …}, fallback?}` |
| `GET /api/ask/modes` | The two presets and the configured default |
| `POST /api/harness/warm` | Agent-mode readiness: thaws a paused harness session, keeps its stream attached, runs the idle-rotation check (throttled, no model run; 202 in mock mode) |
| `POST /api/internal/tool-event` | Called by the MCP server for every tool call (`x-tool-event-token: MCP_AUTH_TOKEN`, 401 otherwise). Body `{phase, callId, tool, args, target, ms?, summary?, hits?, error?}`; attributed to the running question job |
| `GET /api/recordings` | List recordings and recorder status |
| `POST /api/recordings/start` `{name?}` | Start recording live events |
| `POST /api/recordings/stop` | Stop and save |
| `GET /api/recordings/:name` | Download a recording |
| `DELETE /api/recordings/:name` | Remove a recording |
| `POST /api/recordings/:name/replay` `{speed?, wait?}` | Replay (background unless `wait: true`) |
| `POST /api/replay/stop` | Cancel the running replay |

Event shape:

```json
{ "id": 42, "ts": 1791819727712, "type": "stage", "flow": "ingest", "jobId": "…",
  "stage": "functions", "status": "progress", "detail": "Embedded chunk 1/2 (128 dims)",
  "data": { "step": "embed", "index": 0, "total": 2 } }
```

Stages: `spaces`, `functions`, `vectordb`, `kb`, `agent` (Harness Runtime), `gateway` (Action Gateway / MCP), `inference`. Statuses: `start`, `progress`, `done`, `error`. Tool-routed `vectordb` / `spaces` stages carry `data.op: "tool"`, `data.tool`, `data.callId`, `data.args`, `data.hits`, `data.ms`. A `tool` event looks like:

```json
{ "type": "tool", "flow": "query", "jobId": "…",
  "data": { "tool": "search_facts", "phase": "done", "args": { "query": "…", "k": 3 }, "target": "pgvector",
            "summary": "3 hits", "hits": 3, "ms": 120, "callId": "…", "source": "mcp" } }
```

The Logs tab renders it as `TOOL done search_facts(query="…", k=3) → pgvector · 3 hits · 120 ms`.

## Deploy to DigitalOcean App Platform

`.do/app.yaml` describes two Node services on one app: `web` (builds the frontend, serves it from Express on port 8080, route `/`, health check `/api/health`) and `mcp` (`npm run start:mcp` on port 8081, route `/mcp` with `preserve_path_prefix: true`, health check `/mcp/health`). The mcp service reports tool calls to `http://web:8080/api/internal/tool-event` over the app's internal network.

```bash
# 1. push this repo to GitHub and edit github.repo in .do/app.yaml
doctl apps create --spec .do/app.yaml
# later updates
doctl apps update <APP_ID> --spec .do/app.yaml
```

The committed spec targets `a4sr3s/do-anatomy-demo`, runs `PIPELINE_MODE=real` with `HARNESS_TOOLS_MODE=inline`, `MCP_PUBLIC_URL=https://do-anatomy-demo-lfmw4.ondigitalocean.app/mcp`, `REPLAY_FALLBACK=true`, Spaces bucket `alexis-anatomy-demo` in `nyc3`, and leaves every `SECRET` value empty. Fill the secrets in the control panel (or with `doctl apps update`): the Spaces key pair and `DATABASE_URL` on **both** services, `MCP_AUTH_TOKEN` on both (same value), and `HARNESS_API_TOKEN` + `HARNESS_INFERENCE_API_KEY` on web. If a real stage fails the server falls back to replaying a recording, so the stage demo never goes dark. You can also attach a Managed Postgres component in the spec and bind `DATABASE_URL` to `${db.DATABASE_URL}` on both services.

Note: App Platform's filesystem is ephemeral, so recordings made in production live until the next deploy. Commit any recording you want to keep (the bundled `sample-*.json` files are committed; `auto-*.json` snapshots are git-ignored).

## Stage demo script (≈6 minutes)

1. **Set the scene (30s).** Open the app full-screen, slowly drag to rotate. "This is the anatomy of a RAG pipeline on DigitalOcean. Every part you see is a real managed service; every glow you'll see is a real event from the backend."
2. **Tour the organs (60s).** Hover each component left to right along the back row and the front row; read the one-liners. Click Managed Postgres to pin its explainer: "pgvector lets us do similarity search with one SQL `ORDER BY`."
3. **Feed it a fact (90s).** Type: *"Our customer Acme Robotics runs 40 GPU droplets in SFO3 and renews in March."* Press Ingest. Narrate the packet: object lands in Spaces, the App Platform press spins while the web service chunks and embeds, the vector store fills. Point at the live event log on the right.
4. **Ask it (90s).** Type: *"Where does Acme Robotics run their droplets?"* Narrate: the question lands in the Harness Runtime, the agent decides to call `search_facts`, the packet hops through the Action Gateway (watch the selector swing to pgvector and the policy lamps allow it), pgvector's scanner finds the chunk, the result rides back to the harness, and Serverless Inference streams the answer token by token. Open the Logs tab to show the `TOOL search_facts(...) → pgvector · 1 hit · … ms` line. Ask a question about something you never submitted to show the honest "I do not know that yet" answer.
5. **Customize live (60s).** Add a second fact that changes the story ("Acme Robotics moved to NYC3 last week"), ask again, show the answer updates. "Customization here is data, not retraining."
6. **Safety net (30s, optional).** Mention the replay controls: everything you just saw was recorded; if the venue network dies, `▶ Replay` plays the same events, and real mode falls back to a replay automatically.

Tips: run with `MOCK_DELAY_SCALE=1.5` on a projector so the packets are easy to follow; record a clean run beforehand with `● Record` so you have a named recording ready; the `Ctrl/⌘+Enter` shortcut submits the fact box.

## Project layout

```
server/            Express app, SSE bus, recorder, pipelines (mock / real), auth.js (shared token check)
  pipeline/        mock.js, real.js, harness.js (Harness Runtime client + manifest), retrieval.js (pgvector + embeddings shared with mcp/),
                   embedding.js (local hash embedder), migrate.js (boot-time embedding migration), store.js
mcp/               anatomy-data MCP tool server (index.js entry, server.js app factory)
src/               Vite + React + three.js frontend (scene, machines incl. machines/gateway.js, tracks, sidebar sections)
recordings/        JSON event recordings for replay
test/              node:test suites
.do/app.yaml       App Platform spec
```
