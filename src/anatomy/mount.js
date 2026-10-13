/**
 * Wires the backend SSE stream to the machines. Every motion in the scene is
 * triggered here by a backend event (hello / job / stage / answer / replay /
 * recorder / fallback); the frontend never invents pipeline activity.
 *
 * `mountAnatomy(container, ui)` builds the three.js scene inside `container`
 * and talks to the React shell only through the `ui` bridge (see bridge.ts),
 * which exposes the same surface the old 2D overlay (ui.js) had.
 */
import * as THREE from 'three';
import { createScene } from '../scene.js';
import { buildBoard, boardLabel, BOARD } from '../board.js';
import { buildTracks } from '../tracks.js';
import { buildClient } from '../machines/client.js';
import { buildSpaces } from '../machines/spaces.js';
import { buildFunctions } from '../machines/functions.js';
import { buildVectorDb } from '../machines/vectordb.js';
import { buildRouter } from '../machines/router.js';
import { buildInference } from '../machines/inference.js';
import { buildGateway } from '../machines/gateway.js';
import { connectEvents, api } from '../events.js';
import { MACHINES, PARTS, SAMPLE_FACTS, SAMPLE_QUESTIONS } from '../components.js';
import { JOB_COLORS } from '../kit.js';

let active = null;

export function mountAnatomy(container, ui) {
  // the scene is not re-entrant (module-level PARTS carry mesh refs), so a
  // second mount (HMR, remount) tears the previous one down first
  if (active) active.dispose();

  // ---- scene -----------------------------------------------------------------
  const view = createScene(container, {
    onHover: (part) => ui.hover(part),
    onSelect: (part) => ui.select(part),
    onFps: (n) => ui.setFps(n),
  });
  view.scene.add(buildBoard(PARTS));
  const tracks = buildTracks(view.scene, PARTS);
  const machines = {
    client: buildClient(PARTS),
    spaces: buildSpaces(PARTS),
    functions: buildFunctions(PARTS),
    vectordb: buildVectorDb(PARTS),
    router: buildRouter(PARTS),
    gateway: buildGateway(PARTS),
    inference: buildInference(PARTS),
  };
  for (const m of Object.values(machines)) view.scene.add(m.group);
  for (const p of Object.values(PARTS)) if (p.machine) p.machineRef = machines[p.machine];
  // labels on the board (engraved in front of each machine). From the default camera
  // (azimuth 38°, elevation 31°) a machine hides the board behind-left of it, so:
  //  - the gateway's label sits in the gap between its front face (z 1.4) and the harness's
  //    back-right corner (x -1.5, z 2.6), left of the band the inference platters occlude
  //    (x > ~3.7 for z > 0);
  //  - the App Platform label is shifted left of its press (its CHUNK & EMBED sub-line would
  //    otherwise vanish behind the gateway turret) and slightly smaller; further back (z < -2.5)
  //    the press itself hides the name.
  const LABELS = [
    ['CLIENT · APP / CLI', -16.2, 3.4],
    [MACHINES.spaces.label, -7.5, -2.0],
    [MACHINES.functions.label, -3.0, -2.25, { size: 0.46 }],
    [MACHINES.vectordb.label, 7.8, -0.9],
    [MACHINES.gateway.label, 0.7, 1.7],
    [`${MACHINES.router.label} · ${MACHINES.router.sublabel.replace(' · ', ' / ').toUpperCase()}`, -3.8, 7.0],
    [MACHINES.inference.label, 8.5, 7.1],
  ];
  for (const [text, x, z, opts] of LABELS) view.scene.add(boardLabel(text, x, z, opts));
  // register every pickable mesh; parts know their machine for double-click focus
  for (const p of Object.values(PARTS)) {
    p.machine = p.machine ? { ...MACHINES[p.machine], center: machines[p.machine].center, focusZoom: machines[p.machine].focusZoom, key: p.machine } : { center: new THREE.Vector3(BOARD.x, 0, BOARD.z), focusZoom: 1 };
    for (const s of p.solids) view.registerPickable(s);
  }
  view.registerPickable(tracks.group);
  view.fitHome(new THREE.Box3(new THREE.Vector3(BOARD.x - BOARD.w / 2, -1, BOARD.z - BOARD.d / 2), new THREE.Vector3(BOARD.x + BOARD.w / 2, 3, BOARD.z + BOARD.d / 2)));
  const refit = () => view.fitHome(new THREE.Box3(new THREE.Vector3(BOARD.x - BOARD.w / 2, -1, BOARD.z - BOARD.d / 2), new THREE.Vector3(BOARD.x + BOARD.w / 2, 3, BOARD.z + BOARD.d / 2)));
  window.addEventListener('resize', refit);

  view.onTick((dt, t) => {
    for (const m of Object.values(machines)) m.update(dt, t);
    tracks.update(dt, view.camera.zoom);
    // activity glow follows the stage state (one slot per stage; kb (app-side retrieval) and agent (harness) share the router machine)
    for (const a of Object.values(activity)) {
      a.level += (a.target - a.level) * (1 - Math.exp(-dt * 5));
      machines[a.machine].setActive(a.level, a.which);
    }
  });

  // ---- live stats -------------------------------------------------------------
  const stats = {
    client: { facts: 0, questions: 0, deletes: 0, 'last request': '—', 'last answer': '—' },
    spaces: { objects: 0, 'last key': '—', bytes: 0, 'last PUT': '—', deletes: 0 },
    functions: { runs: 0, chunks: 0, embeddings: 0, 'last run': '—' },
    vectordb: { rows: 0, inserts: 0, searches: 0, deletes: 0, 'last hits': '—', 'top score': '—', 'last query': '—' },
    router: { questions: 0, 'tool calls': 0, 'context chunks': 0, session: '—', 'first token': '—', 'last answer': '—', fallbacks: 0 },
    gateway: { 'tool calls': 0, searches: 0, documents: 0, errors: 0, 'last tool': '—', 'last latency': '—' },
    inference: { tokens: 0, model: '—', 'tok/s': '—', 'last generation': '—' },
  };
  ui.setStatsProvider((part) => {
    if (part.key === 'track') return { 'streams in flight': tracks.inFlight, routes: Object.keys(tracks.tracks).length };
    if (part.key === 'board') return { machines: 7, mode: baseMode, 'jobs seen': jobSeq };
    const m = part.machine?.key;
    if (!m) return {};
    const s = { ...stats[m] };
    if (part.key === 'vectordb.cube' || part.key === 'vectordb.chamber') s.chambers = 12;
    return s;
  });

  // ---- event -> animation mapping ---------------------------------------------
  const jobs = new Map(); // jobId -> { flow, color, last, q, input, stageStart: Map }
  const activity = {
    client: { machine: 'client' },
    spaces: { machine: 'spaces' },
    functions: { machine: 'functions' },
    vectordb: { machine: 'vectordb' },
    kb: { machine: 'router', which: 'kb' },
    agent: { machine: 'router', which: 'agent' },
    gateway: { machine: 'gateway' },
    inference: { machine: 'inference' },
  };
  for (const a of Object.values(activity)) Object.assign(a, { level: 0, target: 0 });
  let baseMode = 'mock';
  let jobSeq = 0;
  let recentJobs = [];
  const latencyMs = (ms) => (ms < 1 ? '<1' : Math.round(ms));

  function setActivity(key, on) {
    activity[key].target = on ? 1 : 0;
  }

  /** is any other running job still using this stage? (keeps the glow on for overlapping jobs) */
  function anyActive(stageKey, exceptJobId) {
    for (const [id, j] of jobs) if (id !== exceptJobId && j.stageStart.has(stageKey) && !j.finished) return true;
    return false;
  }

  function getJob(e) {
    let job = jobs.get(e.jobId);
    if (!job) {
      job = { flow: e.flow, color: JOB_COLORS[jobSeq % JOB_COLORS.length], lane: jobSeq % 3, q: Promise.resolve(), input: '', stageStart: new Map(), tokens: 0, tokenAt: 0, pendingAnswer: null, landed: 0, text: '', answered: false, arrived: false, hits: 0 };
      jobSeq++;
      jobs.set(e.jobId, job);
    }
    return job;
  }
  /** queue a step on the job so streams and machine moves stay in order */
  function enqueue(job, fn) {
    job.q = job.q.then(fn).catch((err) => console.warn('step failed', err));
  }

  /** the question packet travels client -> harness once, on whichever stage comes first (kb for app-side retrieval, agent for the tool path) */
  function questionArrives(job) {
    if (job.arrived) return;
    job.arrived = true;
    machines.client.type([1, 3, 5, 7], 60);
    machines.client.screen(`> ASK ${job.input.slice(0, 20)}`, 'question sent…', job.color);
    enqueue(job, async () => {
      setActivity('client', true);
      await tracks.send('client-router', { color: job.color, lane: 0, count: 46 });
      setActivity('client', false);
    });
  }

  function stageStart(e, job) {
    job.stageStart.set(e.stage, e.ts);
    switch (e.stage) {
      case 'spaces': {
        if (e.data?.op === 'delete') {
          // the object(s) behind a deleted fact leave the bucket: open the drawer(s) that hold them
          stats.spaces['last key'] = e.data.all ? `${(e.data.keys || []).length} objects` : e.data.key || '—';
          enqueue(job, async () => {
            setActivity('spaces', true);
            if (e.data.all) for (let i = 0; i < 3; i++) machines.spaces.open(i);
            else job.drawer = machines.spaces.open(machines.spaces.drawerFor(e.data.key));
          });
          break;
        }
        if (e.data?.op === 'tool') {
          // get_document: the gateway reads an object back out of the bucket
          stats.spaces['last key'] = e.data?.args?.key || '—';
          enqueue(job, async () => {
            machines.gateway.port('spaces');
            await tracks.send('gateway-spaces', { color: job.color, lane: 0, count: 36 });
            setActivity('spaces', true);
            job.readDrawer = machines.spaces.open(0);
          });
          break;
        }
        stats.spaces['last key'] = e.data?.key || '—';
        stats.spaces.bytes += e.data?.bytes || 0;
        job.key = e.data?.key || null;
        machines.client.type([0, 4, 8, 2, 6], 60);
        machines.client.screen(`> PUT ${job.input.slice(0, 20)}`, 'posting fact…', job.color);
        enqueue(job, async () => {
          setActivity('client', true);
          await tracks.send('client-spaces', { color: job.color, lane: 0, count: 42 });
          setActivity('client', false);
          setActivity('spaces', true);
          const d = machines.spaces.open();
          job.drawer = d;
        });
        break;
      }
      case 'functions':
        // chunk + embed inside the App Platform app (the `functions` stage name is the wire contract)
        stats.functions.runs++;
        enqueue(job, async () => {
          await tracks.send('spaces-functions', { color: job.color, lane: 0, count: 30 });
          setActivity('functions', true);
          machines.functions.load(job.color);
        });
        break;
      case 'vectordb':
        if (e.data?.op === 'delete') {
          // rows behind a deleted fact: the scanner finds them, then they lift out (on `done`)
          stats.vectordb.deletes++;
          enqueue(job, async () => {
            setActivity('vectordb', true);
            machines.vectordb.startScan();
          });
        } else if (e.data?.op === 'tool') {
          // search_facts routed by the gateway
          stats.vectordb.searches++;
          stats.vectordb['last query'] = '…';
          enqueue(job, async () => {
            machines.gateway.port('pgvector');
            await tracks.send('gateway-vectordb', { color: job.color, lane: 0, count: 24, speed: 10 });
            setActivity('vectordb', true);
            machines.vectordb.startScan();
          });
        } else if (e.data?.op === 'search') {
          stats.vectordb.searches++;
          enqueue(job, async () => {
            await tracks.send('router-vectordb', { color: job.color, lane: 0, count: 34 });
            setActivity('vectordb', true);
            machines.vectordb.startScan();
          });
        } else {
          stats.vectordb.inserts++;
          enqueue(job, async () => {
            await tracks.send('functions-vectordb', { color: job.color, lane: 0, count: 34 });
            setActivity('vectordb', true);
          });
        }
        break;
      case 'kb':
        // app-side retrieval (context-in-prompt fallback): the app embeds + searches itself
        questionArrives(job);
        enqueue(job, async () => {
          setActivity('kb', true);
          machines.router.sweep(true);
        });
        break;
      case 'agent':
        // the Harness Runtime receives the question first and calls tools itself
        stats.router.questions++;
        if (e.data?.session) stats.router.session = e.data.session;
        if (e.data?.fallback) stats.router.fallbacks++;
        questionArrives(job);
        enqueue(job, async () => {
          setActivity('agent', true);
          machines.router.sweep(true);
          machines.router.setSlots(Math.max(1, job.hits || 0));
        });
        break;
      case 'gateway': {
        // a tool call leaves the harness for the gateway, which routes it to pgvector or Spaces
        const target = e.data?.target === 'spaces' ? 'spaces' : 'pgvector';
        stats.gateway['tool calls']++;
        stats.router['tool calls']++;
        if (target === 'spaces') stats.gateway.documents++;
        else stats.gateway.searches++;
        stats.gateway['last tool'] = `${e.data?.tool || 'tool'} → ${target}`;
        enqueue(job, async () => {
          machines.gateway.seek();
          await tracks.send('router-gateway', { color: job.color, lane: 0, count: 30 });
          setActivity('gateway', true);
          machines.gateway.port('harness');
          machines.gateway.route(target);
          machines.gateway.pointAt(target === 'spaces' ? machines.spaces.center : machines.vectordb.center);
        });
        break;
      }
      case 'inference':
        stats.inference.model = e.data?.model || stats.inference.model;
        job.tokens = 0;
        job.tokenAt = e.ts;
        enqueue(job, async () => {
          await tracks.send('router-inference', { color: job.color, lane: 0, count: 40 });
          setActivity('inference', true);
          machines.inference.spinUp(job.color);
        });
        break;
    }
  }

  function stageProgress(e, job) {
    switch (e.stage) {
      case 'functions':
        if (e.data?.step === 'chunk') {
          stats.functions.chunks += e.data.chunks || 0;
          enqueue(job, () => machines.functions.chunk(e.data.chunks || 1, job.color));
        } else if (e.data?.step === 'embed') {
          stats.functions.embeddings++;
          enqueue(job, () => machines.functions.embed(e.data.index || 0));
        }
        break;
      case 'kb':
        if (e.data?.step === 'embed') enqueue(job, () => machines.router.turnKnob());
        break;
      case 'inference':
        if (e.data?.token !== undefined) {
          job.tokens++;
          stats.inference.tokens++;
          const dtSec = Math.max(0.05, (e.ts - job.tokenAt) / 1000);
          stats.inference['tok/s'] = (job.tokens / dtSec).toFixed(1);
          machines.inference.token();
          const token = e.data.token;
          // each token is a short burst on the return track (one lane per job so they land in order);
          // the text lands when the particles do
          tracks.send('inference-client', { color: job.color, lane: job.lane, count: 7, speed: 24, spacing: 0.14, size: 6 }).then(() => {
            if (job.answered) return;
            job.text += token;
            ui.answerAppend(token);
            job.landed++;
            machines.client.screen(`> ${job.input.slice(0, 22)}`, job.text.slice(-24), job.color);
            if (job.pendingAnswer && job.landed >= job.tokens) finishAnswer(job);
          });
        }
        break;
    }
  }

  function stageDone(e, job) {
    const started = job.stageStart.get(e.stage);
    const latency = started != null ? e.ts - started : null;
    switch (e.stage) {
      case 'spaces':
        if (e.data?.op === 'delete') {
          const n = e.data.all ? e.data.removed || 0 : 1;
          stats.spaces.deletes += n;
          stats.spaces.objects = Math.max(0, stats.spaces.objects - n);
          enqueue(job, async () => {
            await wait(350);
            if (e.data.all) machines.spaces.removeAll();
            else machines.spaces.remove(e.data.key);
            machines.spaces.trigger();
            await wait(900);
            if (e.data.all) for (let i = 0; i < 3; i++) machines.spaces.close(i);
            else machines.spaces.close(job.drawer ?? 0);
            setActivity('spaces', false);
            machines.client.screen('> deleted', e.data.all ? `${n} objects removed` : (e.data.key || '').slice(-24), job.color);
          });
          break;
        }
        if (e.data?.op === 'tool') {
          enqueue(job, async () => {
            await wait(400);
            machines.spaces.trigger();
            machines.spaces.close(job.readDrawer ?? 0);
            await tracks.send('gateway-spaces', { color: job.color, lane: 1, count: 30, reverse: true });
            machines.gateway.port('spaces');
            setActivity('spaces', false);
          });
          break;
        }
        stats.spaces.objects++;
        stats.spaces['last PUT'] = `${latencyMs(latency)} ms`;
        enqueue(job, async () => {
          await wait(250);
          machines.spaces.file(job.drawer ?? 0, job.color, job.key);
          machines.spaces.trigger();
          await wait(600);
          machines.spaces.close(job.drawer ?? 0);
          setActivity('spaces', false);
        });
        break;
      case 'functions':
        stats.functions['last run'] = `${latencyMs(latency)} ms`;
        enqueue(job, async () => {
          await wait(700);
          machines.functions.clear();
          setActivity('functions', false);
        });
        break;
      case 'vectordb':
        if (e.data?.count !== undefined) stats.vectordb.rows = e.data.count;
        if (e.data?.op === 'delete') {
          const ids = e.data.ids || [];
          const count = e.data.count;
          enqueue(job, async () => {
            await wait(700); // a visible sweep before the rows are found
            machines.vectordb.stopScan();
            machines.vectordb.hit(ids);
            await wait(350);
            machines.vectordb.remove(ids, count);
            await wait(400);
            setActivity('vectordb', false);
            machines.client.screen('> deleted', `${ids.length} rows · ${count ?? '?'} left`, job.color);
          });
          break;
        }
        if (e.data?.op === 'search' || e.data?.op === 'tool') {
          const viaTool = e.data.op === 'tool';
          const hits = e.data?.hits || [];
          job.hits = hits.length;
          stats.vectordb['last hits'] = hits.length;
          stats.vectordb['top score'] = hits[0]?.score ?? '—';
          stats.vectordb['last query'] = `${latencyMs(e.data?.ms ?? latency)} ms`;
          enqueue(job, async () => {
            await wait(900); // let the scanner make a visible sweep even when the search is instant
            machines.vectordb.stopScan();
            const found = machines.vectordb.hit(hits.map((h) => h.id));
            machines.router.pointAt(found.map((f) => f.pos));
            await tracks.send(viaTool ? 'gateway-vectordb' : 'router-vectordb', { color: job.color, lane: 1, count: viaTool ? 24 : 30, speed: viaTool ? 10 : 14, reverse: true });
            if (viaTool) machines.gateway.port('pgvector');
            setActivity('vectordb', false);
          });
        } else {
          const count = e.data?.count;
          enqueue(job, async () => {
            if (count !== undefined) machines.vectordb.setCount(count, job.color);
            await wait(500);
            setActivity('vectordb', false);
            machines.client.screen('> stored', `${count ?? '?'} rows in pgvector`, job.color);
          });
        }
        break;
      case 'kb':
        stats.router['context chunks'] += e.data?.hits || 0;
        stats.router['last retrieval'] = `${latencyMs(latency)} ms`;
        enqueue(job, async () => {
          machines.router.sweep(false);
          await wait(250);
          setActivity('kb', false);
        });
        break;
      case 'gateway':
        stats.gateway['last latency'] = `${latencyMs(e.data?.ms ?? latency)} ms`;
        stats.router['context chunks'] += e.data?.hits?.length || 0;
        enqueue(job, async () => {
          // the result travels back from the gateway to the harness
          await tracks.send('router-gateway', { color: job.color, lane: 1, count: 30, reverse: true });
          machines.gateway.port('harness');
          machines.router.sweep(false);
          machines.router.setSlots(Math.max(1, job.hits || 0));
          await wait(250);
          setActivity('gateway', false);
          machines.gateway.rest();
        });
        break;
      case 'agent':
        if (e.data?.firstTokenMs != null) stats.router['first token'] = `${latencyMs(e.data.firstTokenMs)} ms`;
        if (e.data?.totalMs != null) stats.router['last answer'] = `${latencyMs(e.data.totalMs)} ms`;
        enqueue(job, async () => {
          await wait(450);
          machines.router.sweep(false);
          machines.router.promptReady();
          await wait(400);
          setActivity('agent', false);
        });
        break;
      case 'inference':
        stats.inference['last generation'] = `${latencyMs(latency)} ms`;
        enqueue(job, async () => {
          await wait(300);
          machines.inference.spinDown();
          setActivity('inference', false);
        });
        break;
    }
    return latency;
  }

  function finishAnswer(job) {
    if (job.answered || !job.pendingAnswer) return;
    const { text, sources } = job.pendingAnswer;
    job.pendingAnswer = null;
    job.answered = true;
    ui.answerSet(text, sources);
    stats.client['last answer'] = text.slice(0, 60);
    machines.client.screen('> answer', text.slice(0, 26), job.color);
    machines.client.setLed(job.color);
    machines.client.type([4], 0);
  }

  const wait = (ms) => view.waitAnim(ms / 1000);

  let catchUpCutoff = 0;
  function handleEvent(e) {
    let latency;
    // the server replays recent history after `hello`; log it, don't re-animate it
    if (e.type !== 'hello' && e.ts && e.ts < catchUpCutoff) {
      ui.log(e, { stale: true });
      return;
    }
    switch (e.type) {
      case 'hello':
        catchUpCutoff = e.ts - 1500;
        baseMode = e.data.mode;
        ui.setMode(`${baseMode} mode`, baseMode === 'real' ? 'ok' : '');
        ui.setRecorderStatus(e.data.recorder);
        if (e.data.pipeline?.chunks !== undefined) {
          stats.vectordb.rows = e.data.pipeline.chunks;
          machines.vectordb.setCount(e.data.pipeline.chunks, '#4dff9a', false);
        }
        refreshFacts({ sync: true });
        break;
      case 'job': {
        const job = getJob(e);
        if (e.status === 'start') {
          job.input = e.data?.input || '';
          if (e.flow === 'ingest') stats.client.facts++;
          else if (e.flow === 'delete') stats.client.deletes++;
          else stats.client.questions++;
          stats.client['last request'] = job.input.slice(0, 50);
          if (e.flow === 'query') ui.answerReset(job.input);
          if (e.flow === 'delete') {
            // the delete request leaves the client for the data plane; the vectordb / spaces stages do the rest
            machines.client.type([2, 6, 8], 60);
            machines.client.screen(`> DEL ${e.data?.all ? 'all facts' : job.input.slice(-20)}`, 'deleting…', job.color);
            enqueue(job, async () => {
              setActivity('client', true);
              await tracks.send('client-spaces', { color: job.color, lane: 1, count: 30 });
              setActivity('client', false);
            });
          }
          machines.client.setLed(job.color);
          recentJobs = [{ flow: e.flow, input: job.input, color: job.color }, ...recentJobs].slice(0, 5);
          ui.setLegend(recentJobs);
        } else {
          job.finished = true;
          if (e.flow === 'ingest' || e.flow === 'delete') refreshFacts();
          if (e.status === 'error') {
            ui.toast(`Pipeline error: ${e.data?.message || 'unknown'}`, 'err');
            for (const k of Object.keys(activity)) setActivity(k, false);
            machines.vectordb.stopScan();
            machines.inference.spinDown();
            machines.router.sweep(false);
            machines.gateway.rest();
          }
          enqueue(job, async () => {
            await wait(1500);
            if (e.flow === 'query') machines.router.rest();
            machines.router.setSlots(0);
            for (const k of Object.keys(activity)) if (!anyActive(k, e.jobId)) setActivity(k, false);
            jobs.delete(e.jobId);
          });
        }
        break;
      }
      case 'stage': {
        const job = getJob(e);
        if (e.status === 'start') stageStart(e, job);
        else if (e.status === 'progress') stageProgress(e, job);
        else if (e.status === 'done') latency = stageDone(e, job);
        else if (e.status === 'error') {
          const started = job.stageStart.get(e.stage);
          latency = started != null ? e.ts - started : undefined;
          if (e.stage === 'gateway') stats.gateway.errors++;
          if (e.stage === 'gateway' || e.data?.op === 'tool') {
            enqueue(job, async () => {
              machines.vectordb.stopScan();
              machines.gateway.rest();
              setActivity(e.stage, false);
            });
          }
          ui.toast(`${e.stage} error: ${e.detail}`, 'err');
        }
        break;
      }
      case 'answer': {
        const job = getJob(e);
        job.pendingAnswer = { text: e.data.text, sources: e.data.sources || [] };
        if (job.landed >= job.tokens) finishAnswer(job);
        else wait(12000).then(() => finishAnswer(job));
        break;
      }
      case 'tool': {
        // the MCP server (or the harness stream) reported a tool call; the gateway/vectordb/spaces
        // stage events carry the animation, this only feeds the counters
        if (e.jobId) getJob(e);
        if (e.data?.source !== 'harness') stats.gateway['last tool'] = `${e.data?.tool || 'tool'} → ${e.data?.target || '?'}${e.data?.phase === 'error' ? ' ✗' : ''}`;
        break;
      }
      case 'fallback':
        if (e.data?.recording) ui.toast(`Live ${e.flow} failed (${e.data.reason}). Replaying "${e.data.recording}".`, 'warn', 7000);
        else ui.toast(`Harness failed (${e.data?.reason || 'unknown'}). Falling back to ${e.data?.to || 'the fallback path'}.`, 'warn', 7000);
        break;
      case 'replay':
        if (e.status === 'start') ui.setMode(`replay · ${e.data.name}`, 'warn');
        else ui.setMode(`${baseMode} mode`, baseMode === 'real' ? 'ok' : '');
        ui.setRecorderStatus({ replaying: e.status === 'start' ? e.data.name : null });
        break;
      case 'recorder':
        refreshRecordings();
        break;
    }
    ui.log(e, { latency: latency != null ? latencyMs(latency) : undefined });
  }

  /** GET /api/facts into the sidebar; with `sync`, slabs for facts not yet in the cabinet are filed instantly (page load) */
  async function refreshFacts({ sync = false } = {}) {
    try {
      const r = await api('/facts');
      const facts = r.facts || [];
      ui.setFacts?.(facts);
      stats.spaces.objects = facts.length;
      if (sync) machines.spaces.sync(facts.map((f) => f.key));
      return facts;
    } catch (err) {
      console.warn('facts', err);
      return [];
    }
  }

  async function refreshRecordings() {
    try {
      const r = await api('/recordings');
      ui.setRecordings(r.recordings, { recording: r.recording, replaying: r.replaying });
    } catch (err) {
      console.warn('recordings', err);
    }
  }

  // ---- auto traffic -----------------------------------------------------------
  let autoTimer = null;
  let autoIdx = 0;
  function setAuto(on) {
    clearInterval(autoTimer);
    autoTimer = null;
    if (!on) return;
    const tick = async () => {
      const i = autoIdx++;
      try {
        if (i % 2 === 0) await api('/facts', { method: 'POST', body: { text: SAMPLE_FACTS[(i / 2) % SAMPLE_FACTS.length] } });
        else await api('/ask', { method: 'POST', body: { question: SAMPLE_QUESTIONS[Math.floor(i / 2) % SAMPLE_QUESTIONS.length] } });
      } catch (err) {
        ui.toast(`auto traffic: ${err.message}`, 'err');
      }
    };
    tick();
    autoTimer = setInterval(tick, 9000);
  }

  // ---- wiring -----------------------------------------------------------------
  const events = connectEvents({ onEvent: handleEvent, onState: (s) => ui.setConn(s) });
  refreshRecordings();
  ui.trackMachineStats?.(stats);

  // the sidebar changes the container size without a window resize
  let resizeRaf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  });
  ro.observe(container);

  const actions = {
    setSpeed: (s) => view.setSpeed(s),
    setAuto,
    /** UnrealBloomPass is skipped by the composer when disabled */
    setBloom: (on) => {
      view.bloom.enabled = Boolean(on);
    },
    resetView: () => view.goHome(),
    replay: async (name, speed) => {
      try {
        await api(`/recordings/${encodeURIComponent(name)}/replay`, { method: 'POST', body: { speed } });
      } catch (err) {
        ui.toast(err.message, 'err');
      }
    },
    stopReplay: () => api('/replay/stop', { method: 'POST' }).catch((e) => ui.toast(e.message, 'err')),
    toggleRecord: async () => {
      try {
        const { recorder } = await api('/health');
        if (recorder.recording) {
          const r = await api('/recordings/stop', { method: 'POST' });
          ui.toast(`Saved recording "${r.name}" (${r.events} events)`);
        } else {
          const r = await api('/recordings/start', { method: 'POST', body: {} });
          ui.toast(`Recording "${r.name}" – submit a fact / ask a question, then stop.`);
        }
        refreshRecordings();
      } catch (err) {
        ui.toast(err.message, 'err');
      }
    },
    refreshRecordings,
    refreshFacts: () => refreshFacts(),
    deleteFact: (id) => api(`/facts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    deleteAllFacts: () => api('/facts', { method: 'DELETE' }),
  };

  function dispose() {
    if (active !== handle) return;
    active = null;
    setAuto(false);
    events.close();
    ro.disconnect();
    window.removeEventListener('resize', refit);
    ui.dispose?.();
    view.renderer.domElement.remove();
  }

  const handle = { view, machines, tracks, stats, jobs, actions, dispose };
  active = handle;
  // debug / verification hook (used by the headless capture scripts)
  window.__anatomy = { machines, tracks, view, jobs, stats, PARTS, actions };
  return handle;
}
