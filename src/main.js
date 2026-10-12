import { createScene } from './scene.js';
import { createPacketSystem } from './packets.js';
import { createUI } from './ui.js';
import { connectEvents, api } from './events.js';
import { NODES } from './components.js';

const FILL_FULL_AT = 12; // chunks needed to show the vector DB "full"

const ui = createUI({
  onSubmitFact: (text) => api('/facts', { method: 'POST', body: { text } }),
  onAsk: (question) => api('/ask', { method: 'POST', body: { question } }),
  onReplay: async (name, speed) => {
    try {
      await api(`/recordings/${encodeURIComponent(name)}/replay`, { method: 'POST', body: { speed } });
    } catch (err) {
      ui.toast(err.message, 'err');
    }
  },
  onStopReplay: () => api('/replay/stop', { method: 'POST' }).catch((e) => ui.toast(e.message, 'err')),
  onRecordToggle: async () => {
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
});

const view = createScene(document.getElementById('scene'), {
  onHover: (key, x, y) => ui.hover(key, x, y),
  onSelect: (key) => ui.showExplainer(key, true),
});
const packets = createPacketSystem(view.scene);
view.onTick((dt) => packets.update(dt));

// ---- event -> animation mapping -------------------------------------------
const jobs = new Map(); // jobId -> { flow, last: stageKey }
let baseMode = 'mock';
let resetTimer;

function stageStart(e) {
  const job = jobs.get(e.jobId) || { flow: e.flow, last: null };
  jobs.set(e.jobId, job);
  const color = NODES[e.stage]?.color;
  const to = view.nodePosition(e.stage);
  const arrive = () => {
    view.setActivity(e.stage, 1);
    view.pulse(e.stage, 0.8);
  };
  if (job.last && job.last !== e.stage) packets.fly(view.nodePosition(job.last), to, { color, onArrive: arrive });
  else packets.dropIn(to, { color, onArrive: arrive });
  view.setActivity(e.stage, 0.55);
  job.last = e.stage;
  view.setPill(e.stage, e.detail);
  ui.setStageStatus(e.stage, e.detail);
}

function handleEvent(e) {
  ui.log(e);
  switch (e.type) {
    case 'hello':
      baseMode = e.data.mode;
      ui.setMode(`${baseMode} mode`, baseMode === 'real' ? 'ok' : '');
      ui.setRecorderStatus(e.data.recorder);
      if (e.data.pipeline?.chunks) view.setFill(e.data.pipeline.chunks / FILL_FULL_AT);
      break;
    case 'job':
      if (e.status === 'start') {
        clearTimeout(resetTimer);
        jobs.set(e.jobId, { flow: e.flow, last: null });
        if (e.flow === 'query') ui.answerReset();
      } else {
        const job = jobs.get(e.jobId);
        jobs.delete(e.jobId);
        if (e.status === 'done' && job?.last === 'inference') packets.flyUp(view.nodePosition('inference'), { color: NODES.inference.color });
        if (e.status === 'error') ui.toast(`Pipeline error: ${e.data?.message || 'unknown'}`, 'err');
        resetTimer = setTimeout(() => { if (!jobs.size) view.resetAll(); }, 2500);
      }
      break;
    case 'stage':
      if (e.status === 'start') stageStart(e);
      else if (e.status === 'progress') {
        if (e.stage === 'functions') view.setSpin('functions', true);
        if (e.data?.token !== undefined) {
          ui.answerAppend(e.data.token);
          view.pulse('inference', 0.5);
        } else if (e.detail) {
          view.setPill(e.stage, e.detail);
          ui.setStageStatus(e.stage, e.detail);
        }
      } else if (e.status === 'done') {
        view.setActivity(e.stage, 0.3);
        view.setSpin(e.stage, false);
        if (e.detail) { view.setPill(e.stage, e.detail); ui.setStageStatus(e.stage, e.detail); }
        if (e.stage === 'vectordb') {
          if (e.data?.count !== undefined) view.setFill(e.data.count / FILL_FULL_AT);
          view.pulse('vectordb', 1);
          // packet returns from DB to KB after a search
          if (e.data?.op === 'search' && jobs.get(e.jobId)) {
            packets.fly(view.nodePosition('vectordb'), view.nodePosition('kb'), { color: NODES.kb.color, onArrive: () => view.pulse('kb', 0.6) });
            jobs.get(e.jobId).last = 'kb';
          }
        }
      } else if (e.status === 'error') {
        view.setPill(e.stage, `✖ ${e.detail}`);
        ui.setStageStatus(e.stage, `error: ${e.detail}`);
      }
      break;
    case 'answer':
      ui.answerSet(e.data.text, e.data.sources);
      break;
    case 'fallback':
      ui.toast(`Live ${e.flow} failed (${e.data.reason}). Replaying "${e.data.recording}".`, 'warn', 7000);
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
}

async function refreshRecordings() {
  try {
    const r = await api('/recordings');
    ui.setRecordings(r.recordings, { recording: r.recording, replaying: r.replaying });
  } catch (err) {
    console.warn('recordings', err);
  }
}

connectEvents({ onEvent: handleEvent, onState: (s) => ui.setConn(s) });
refreshRecordings();
