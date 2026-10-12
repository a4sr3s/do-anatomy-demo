/** 2D overlay: controls, inspector + answer stream, event log, badges, legend, toast. */
import { MACHINES, PARTS } from './components.js';

const $ = (id) => document.getElementById(id);
const escape = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function createUI(handlers) {
  const el = {
    fps: $('fps'), mode: $('mode-badge'), conn: $('conn-badge'),
    factInput: $('fact-input'), factBtn: $('fact-btn'), askInput: $('ask-input'), askBtn: $('ask-btn'), formStatus: $('form-status'),
    speed: $('speed'), auto: $('auto'),
    recSelect: $('rec-select'), playBtn: $('play-btn'), stopBtn: $('stop-btn'), recBtn: $('rec-btn'), resetBtn: $('reset-btn'),
    inspTitle: $('insp-title'), inspSub: $('insp-sub'), inspDesc: $('insp-desc'), inspStats: $('insp-stats'),
    answer: $('answer-text'), log: $('event-log'), logCount: $('log-count'), legend: $('legend'), toast: $('toast'),
  };
  let pinned = null;
  let shown = null;
  let logCount = 0;
  let toastTimer;
  let speed = 1;
  let statsProvider = () => ({});

  // ---- forms --------------------------------------------------------------
  async function submit(kind) {
    const input = kind === 'fact' ? el.factInput : el.askInput;
    const btn = kind === 'fact' ? el.factBtn : el.askBtn;
    const text = input.value.trim();
    if (!text) return input.focus();
    btn.disabled = true;
    el.formStatus.textContent = kind === 'fact' ? 'uploading…' : 'asking…';
    try {
      const r = await (kind === 'fact' ? handlers.onSubmitFact(text) : handlers.onAsk(text));
      el.formStatus.textContent = r.fallback ? `replayed "${r.recording}" (fallback)` : kind === 'fact' ? `stored ${r.chunks} chunk${r.chunks === 1 ? '' : 's'} · ${r.total} rows` : `${(r.sources || []).length} source${(r.sources || []).length === 1 ? '' : 's'}`;
      input.value = '';
    } catch (err) {
      el.formStatus.textContent = `error: ${err.message}`;
      toast(err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }
  el.factBtn.addEventListener('click', () => submit('fact'));
  el.askBtn.addEventListener('click', () => submit('ask'));
  el.factInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit('fact'));
  el.askInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit('ask'));
  el.speed.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    speed = Number(b.dataset.speed);
    [...el.speed.children].forEach((c) => c.classList.toggle('on', c === b));
    handlers.onSpeed(speed);
  });
  el.auto.addEventListener('change', () => handlers.onAuto(el.auto.checked));
  el.resetBtn.addEventListener('click', () => handlers.onResetView());
  el.recBtn.addEventListener('click', () => handlers.onRecordToggle());
  el.playBtn.addEventListener('click', () => el.recSelect.value && handlers.onReplay(el.recSelect.value, speed));
  el.stopBtn.addEventListener('click', () => handlers.onStopReplay());

  // ---- inspector ----------------------------------------------------------
  function show(part) {
    const p = part || pinned;
    shown = p;
    if (!p) {
      el.inspTitle.textContent = 'Hover or click any part';
      el.inspSub.textContent = '';
      el.inspDesc.textContent = 'Six machines on one board: a fact goes CLIENT → SPACES → FUNCTIONS → VECTOR DB; a question goes CLIENT → KNOWLEDGE BASE → VECTOR DB → AGENT → INFERENCE → CLIENT. Every motion is a backend event.';
      renderStats({});
      return;
    }
    const m = p.machine ? MACHINES[p.machine] : null;
    el.inspTitle.textContent = m ? `${m.title} · ${p.title}` : p.title;
    el.inspSub.textContent = pinned === p ? 'pinned · click empty space to unpin' : m ? m.label : '';
    el.inspDesc.textContent = `${m ? m.desc + ' ' : ''}${p.desc}`;
    renderStats(statsProvider(p));
  }
  function renderStats(stats) {
    const entries = Object.entries(stats);
    el.inspStats.innerHTML = entries.map(([k, v]) => `<div><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`).join('');
  }
  function hover(part) {
    if (pinned) return;
    show(part);
  }
  function select(part) {
    pinned = part || null;
    show(part);
  }
  setInterval(() => {
    if (shown) renderStats(statsProvider(shown));
  }, 300);

  // ---- answer -------------------------------------------------------------
  let answerText = '';
  function answerReset(question) {
    answerText = '';
    el.answer.textContent = question ? `? ${question}` : '';
    el.answer.className = 'streaming';
  }
  function answerAppend(token) {
    answerText += token;
    el.answer.textContent = answerText;
    el.answer.className = 'streaming';
  }
  function answerSet(text, sources = []) {
    answerText = text;
    el.answer.innerHTML = `${escape(text)} <span class="src">[${sources.length} source${sources.length === 1 ? '' : 's'}]</span>`;
    el.answer.className = '';
  }

  // ---- log ----------------------------------------------------------------
  function log(e, { latency, stale } = {}) {
    if (e.type === 'stage' && e.status === 'progress' && e.data?.token !== undefined) return; // one line per token is too chatty
    const li = document.createElement('li');
    li.className = `${e.replay ? 'replay' : ''}${stale ? ' stale' : ''}`;
    const d = new Date(e.ts || Date.now());
    const t = `${d.toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    const who = e.stage || e.type;
    let what = '';
    let status = e.status || '';
    if (e.type === 'hello') what = `connected · ${e.data?.mode} mode · ${e.data?.pipeline?.chunks ?? 0} rows`;
    else if (e.type === 'stage') what = e.detail || '';
    else if (e.type === 'job') what = `${e.flow}${e.data?.input ? ` "${e.data.input.slice(0, 70)}"` : ''}${e.data?.message ? ` ${e.data.message}` : ''}`;
    else if (e.type === 'answer') what = `${e.data?.sources?.length || 0} sources`;
    else if (e.type === 'fallback') what = `${e.flow} → replaying ${e.data?.recording}`;
    else if (e.type === 'replay') what = e.data?.name || '';
    else what = e.detail || JSON.stringify(e.data || {}).slice(0, 80);
    li.innerHTML = `<span class="t">${t}</span><span class="s-${escape(who)}">${escape(who)}</span><span class="d${status === 'progress' ? ' muted' : ''}"><span class="status-${escape(status)}">${escape(status)}</span> ${escape(what)}</span><span class="ms">${latency != null ? `${latency} ms` : ''}</span>`;
    el.log.prepend(li);
    while (el.log.children.length > 200) el.log.lastChild.remove();
    el.logCount.textContent = `${++logCount}`;
  }

  // ---- badges / legend / toast -------------------------------------------
  function setFps(n) {
    el.fps.textContent = `${n} fps`;
  }
  function setMode(text, cls = '') {
    el.mode.textContent = text;
    el.mode.className = `chip ${cls}`;
  }
  function setConn(state) {
    el.conn.textContent = state === 'open' ? 'sse live' : 'sse reconnecting';
    el.conn.className = `chip ${state === 'open' ? 'ok' : 'warn'}`;
  }
  function setLegend(jobs) {
    el.legend.innerHTML = jobs.map((j) => `<span style="--c:${j.color}">${escape(j.flow === 'ingest' ? 'fact' : 'question')} · ${escape(j.input.slice(0, 28))}${j.input.length > 28 ? '…' : ''}</span>`).join('');
  }
  function toast(msg, cls = '', ms = 4500) {
    el.toast.textContent = msg;
    el.toast.className = `toast ${cls}`;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
  }
  function setRecordings(list, status = {}) {
    const cur = el.recSelect.value;
    el.recSelect.innerHTML = list.length ? list.map((r) => `<option value="${escape(r.name)}">${escape(r.name)} · ${r.events} ev · ${(r.duration / 1000).toFixed(1)}s</option>`).join('') : '<option value="">no recordings</option>';
    if (list.some((r) => r.name === cur)) el.recSelect.value = cur;
    setRecorderStatus(status);
  }
  function setRecorderStatus({ recording, replaying } = {}) {
    if (recording !== undefined) {
      el.recBtn.textContent = recording ? `■ STOP REC` : '● REC';
      el.recBtn.classList.toggle('active', Boolean(recording));
    }
    if (replaying !== undefined) {
      el.playBtn.hidden = Boolean(replaying);
      el.stopBtn.hidden = !replaying;
    }
    el.playBtn.disabled = !el.recSelect.value;
  }
  function setAuto(on) {
    el.auto.checked = on;
  }

  return { hover, select, show, setStatsProvider: (fn) => (statsProvider = fn), answerReset, answerAppend, answerSet, log, setFps, setMode, setConn, setLegend, toast, setRecordings, setRecorderStatus, setAuto, get pinned() { return pinned; }, get speed() { return speed; } };
}

export { PARTS };
