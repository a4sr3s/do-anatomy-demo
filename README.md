# Anatomy of a DigitalOcean Data Pipeline

An interactive 3D isometric "anatomy" view of a live retrieval-augmented AI pipeline on DigitalOcean, built for the DigitalOcean Solutions conference demo on model building, data, and customization.

Six DigitalOcean components sit on a rotatable isometric stage as glowing wireframes:

```
Spaces ──▶ Functions ──▶ Managed Postgres (pgvector) ──▶ Knowledge Base ──▶ Managed Agent ──▶ Serverless Inference
(upload)   (chunk+embed)        (vector store)              (retrieval)      (orchestration)     (OpenAI-compatible)
```

- **Submit a fact** and a glowing packet flies Spaces → Functions (the icosahedron spins while chunking and embedding) → pgvector (the cylinder fills up).
- **Ask a question** and a packet flows Knowledge Base → pgvector search → back to KB → Agent → Inference, where the halo pulses as tokens stream into the answer panel.
- Hover any component for a one-line explainer; click to pin a longer one in the side panel.
- Every animation is driven by **real backend events over Server-Sent Events**. Nothing is a canned loop: the frontend simply reacts to `stage`, `job`, and `answer` events emitted by the pipeline.

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
| `npm test` | `node:test` suite: mock pipeline round-trip (submit fact → ask returns it), HTTP/SSE API, recorder and replay fallback |
| `npm run record:samples` | Regenerates `recordings/sample-ingest.json` and `sample-query.json` from the mock pipeline |

## Modes (`PIPELINE_MODE`)

Copy `.env.example` to `.env` and adjust. Every variable is documented there.

### `mock` (default)

No credentials. Each stage is simulated with realistic timing (`MOCK_DELAY_SCALE=1`; set `0` for instant, `2` for slow motion on a big screen). Facts are chunked, embedded with a local 128-dim hashed bag-of-words embedding, and stored in memory. Asking about a submitted fact really retrieves it through cosine similarity and the "model" composes the answer from the retrieved chunks, streamed word by word.

### `real`

Wired for DigitalOcean. Dependencies are imported lazily, so mock mode never loads them.

| Stage | Service | Implementation |
| --- | --- | --- |
| Spaces | `@aws-sdk/client-s3` | `PutObject` of the fact as `facts/<ts>-<id>.txt` |
| Functions | `DO_FUNCTION_URL` (optional) | POST `{key, text}` expecting `{chunks, embeddings}`; if unset the server chunks and embeds in-process |
| Vector DB | `pg` + pgvector | `CREATE EXTENSION vector`, table auto-created, `INSERT ... ::vector`, `ORDER BY embedding <=> $1` |
| Knowledge Base | pgvector, always | Every question is embedded and searched (cosine, top 3) against our own table first, so a fact you just submitted is answerable instantly. If a Managed Agent answers and its own Knowledge Base returns chunks, those are merged in as extra sources |
| Agent | GenAI Platform Managed Agent (`DO_AGENT_ENDPOINT` + `DO_AGENT_KEY`) | Preferred when set: POST `<endpoint>/api/v1/chat/completions` with `stream: true`, `include_retrieval_info: true`, the grounding guidance, retrieved context and question folded into one user message. `reasoning_content` deltas are ignored, only `content` is streamed |
| Inference | Serverless Inference (`DO_INFERENCE_URL` + `DO_INFERENCE_KEY`) | Used directly when no agent endpoint is set: OpenAI-compatible `/chat/completions` with `stream: true`. In both paths tokens are forwarded as `inference` `progress` events `{token, index}` |
| Embeddings | `DO_EMBEDDING_MODEL` (optional, needs `DO_INFERENCE_KEY`) | OpenAI-compatible `/embeddings`; leave empty to use the local embedder (`VECTOR_DIM=128`), which needs no key at all |

How a question is answered, in order:

1. Retrieve from pgvector (stages `kb` → `vectordb` → `kb`).
2. If `DO_AGENT_ENDPOINT` is set: stage `agent` "Managed Agent (KB + model) answering", stage `inference` "Serverless inference via agent", tokens stream.
3. Else if `DO_INFERENCE_KEY` is set: existing direct Serverless Inference path.
4. Else the query fails with a clear error; with `REPLAY_FALLBACK=true` the server replays the last good query recording instead.

`GET /api/health` reports which one is active as `pipeline.inferenceVia`: `"agent"`, `"serverless"` or `null`.

Getting the credentials:

- **Model Access Keys** (`DO_INFERENCE_KEY`) can only be created in the control panel under *GenAI Platform → Model access keys*; `doctl` and the API cannot mint them. If your account has none, skip it and use an agent.
- **Managed Agent**: create an agent in *GenAI Platform*, copy its endpoint URL (`https://<id>.agents.do-ai.run`) into `DO_AGENT_ENDPOINT` and create an endpoint access key for `DO_AGENT_KEY`. Optionally give the agent a **Knowledge Base that indexes the Spaces bucket's `facts/` prefix** (data source: Spaces, bucket `alexis-anatomy-demo`, path `facts/`), then re-index after a demo run. KB indexing is periodic, which is exactly why pgvector retrieval always runs first.
- **Spaces** key pair and a Managed Postgres `DATABASE_URL` (pgvector is enabled automatically on first use).

### Replay

Events can be recorded to `recordings/<name>.json` and replayed with their original timing, so the stage demo keeps working even if Wi-Fi dies.

- **UI:** top bar → `● Record`, run a fact/question, `■ Stop rec`. Pick a recording and `▶ Replay` at 0.5×–4×.
- **Automatic fallback:** when `REPLAY_FALLBACK=true` (default) and a real-mode stage fails with a network/credential error, the server replays the latest successful job of the same flow (`recordings/auto-ingest.json` / `auto-query.json`), or the bundled `sample-*.json`, and tells the UI with a toast. The API response carries `fallback: true`.
- Replayed events are flagged `replay: true`; the mode badge switches to "replay" for the duration.

## API

| Method & path | Purpose |
| --- | --- |
| `GET /api/health` | Mode, pipeline description, recorder status |
| `GET /api/events` | SSE stream. Event names: `hello`, `job`, `stage`, `answer`, `recorder`, `replay`, `fallback`. Supports `Last-Event-ID` / `?since=` catch-up |
| `POST /api/facts` `{text}` | Ingest a fact; resolves when the pipeline finishes |
| `POST /api/ask` `{question}` | Ask; resolves with `{answer, sources}` |
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

Stages: `spaces`, `functions`, `vectordb`, `kb`, `agent`, `inference`. Statuses: `start`, `progress`, `done`, `error`.

## Deploy to DigitalOcean App Platform

`.do/app.yaml` describes a single Node service that builds the frontend and serves it from Express on port 8080 with `/api/health` as the health check.

```bash
# 1. push this repo to GitHub and edit github.repo in .do/app.yaml
doctl apps create --spec .do/app.yaml
# later updates
doctl apps update <APP_ID> --spec .do/app.yaml
```

The committed spec targets `a4sr3s/do-anatomy-demo`, runs `PIPELINE_MODE=real` with `REPLAY_FALLBACK=true`, Spaces bucket `alexis-anatomy-demo` in `nyc3`, and leaves every `SECRET` value empty. Fill the secrets in the control panel (or with `doctl apps update`): the Spaces key pair, `DATABASE_URL` of a Managed Postgres with pgvector, and either `DO_AGENT_ENDPOINT` + `DO_AGENT_KEY` (agent path) or `DO_INFERENCE_KEY` (a Model Access Key, control panel only). `DO_AGENT_ENDPOINT` is stored as a secret too. If a real stage fails the server falls back to replaying a recording, so the stage demo never goes dark. You can also attach a Managed Postgres component in the spec and bind `DATABASE_URL` to `${db.DATABASE_URL}`.

Note: App Platform's filesystem is ephemeral, so recordings made in production live until the next deploy. Commit any recording you want to keep (the bundled `sample-*.json` files are committed; `auto-*.json` snapshots are git-ignored).

## Stage demo script (≈6 minutes)

1. **Set the scene (30s).** Open the app full-screen, slowly drag to rotate. "This is the anatomy of a RAG pipeline on DigitalOcean. Every part you see is a real managed service; every glow you'll see is a real event from the backend."
2. **Tour the organs (60s).** Hover each component left to right along the back row and the front row; read the one-liners. Click Managed Postgres to pin its explainer: "pgvector lets us do similarity search with one SQL `ORDER BY`."
3. **Feed it a fact (90s).** Type: *"Our customer Acme Robotics runs 40 GPU droplets in SFO3 and renews in March."* Press Ingest. Narrate the packet: object lands in Spaces, the Function spins while chunking and embedding, the vector store fills. Point at the live event log on the right.
4. **Ask it (90s).** Type: *"Where does Acme Robotics run their droplets?"* Narrate: Knowledge Base embeds the question, the packet bounces to pgvector and back with the matching chunk, the Agent builds a grounded prompt, Serverless Inference streams the answer token by token. Show the source chunk under the answer. Ask a question about something you never submitted to show the honest "I couldn't find anything" answer.
5. **Customize live (60s).** Add a second fact that changes the story ("Acme Robotics moved to NYC3 last week"), ask again, show the answer updates. "Customization here is data, not retraining."
6. **Safety net (30s, optional).** Mention the replay controls: everything you just saw was recorded; if the venue network dies, `▶ Replay` plays the same events, and real mode falls back to a replay automatically.

Tips: run with `MOCK_DELAY_SCALE=1.5` on a projector so the packets are easy to follow; record a clean run beforehand with `● Record` so you have a named recording ready; the `Ctrl/⌘+Enter` shortcut submits the fact box.

## Project layout

```
server/            Express app, SSE bus, recorder, pipelines (mock / real)
  pipeline/        mock.js, real.js, embedding.js (local hash embedder), store.js
src/               Vite + three.js frontend (scene, shapes, packets, ui, events)
recordings/        JSON event recordings for replay
test/              node:test suites
.do/app.yaml       App Platform spec
```
