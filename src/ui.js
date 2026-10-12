import { NODES } from './components.js';

const $ = (id) => document.getElementById(id);

/** DOM panels: forms, answer, explainer, tooltip, event log, replay controls. */
export function createUI(handlers) {
  const el = {
    mode: $('mode-badge'), conn: $('conn-badge'),
    factInput: $('fact-input'), factBtn: $('fact-btn'), factStatus: $('fact-status'),
    askInput: $('ask-input'), askBtn: $('ask-btn'), askStatus: $('ask-status'),
    answer: $('answer-text'), sources: $('answer-sources'),
    exTitle: $('explainer-title'), exSub: $('explainer-sub'), exBody: $('explainer-body'), exStatus: $('explainer-status'),
    log: $('event-log'), logCount: $('log-count'), tooltip: $('tooltip'), toast: $('toast'),
    recBtn: $('rec-btn'), recSelect: $('rec-select'), recSpeed: $('rec-speed'), playBtn: $('play-btn'), stopBtn: $('stop-btn'),
  };
  let pinned = null;
  let logCount = 0;
  let toastTimer;
  const stageStatus = {};

  // ---- forms --------------------------------------------------------------
  const submitFact = async () => {
    const text = el.factInput.value.trim();
    if (!text) return el.factInput.focus();
    setBusy('fact', true, 'uploading…');
    try {
      const r = await handlers.onSubmitFact(text);
      el.factStatus.textContent = r.fallback ? `replayed "${r.recording}" (fallback)` : `stored ${r.chunks} chunk${r.chunks === 1 ? '' : 's'} · ${r.total} total`;
      el.factInput.value = '';
    } catch (err) {
      el.factStatus.textContent = `error: ${err.message}`;
      toast(err.message, 'err');
    } finally {
      setBusy('fact', false);
    }
  };
  const ask = async () => {
    const question = el.askInput.value.trim();
    if (!question) return el.askInput.focus();
    setBusy('ask', true, 'thinking…');
    answerReset();
    try {
      const r = await handlers.onAsk(question);
      if (r.answer) answerSet(r.answer, r.sources || []);
      el.askStatus.textContent = r.fallback ? `replayed "${r.recording}" (fallback)` : `${(r.sources || []).length} source${(r.sources || []).length === 1 ? '' : 's'}`;
    } catch (err) {
      el.askStatus.textContent = `error: ${err.message}`;
      toast(err.message, 'err');
    } finally {
      setBusy('ask', false);
    }
  };
  el.factBtn.addEventListener('click', submitFact);
  el.askBtn.addEventListener('click', ask);
  el.factInput.addEventListener('keydown', (e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && submitFact());
  el.askInput.addEventListener('keydown', (e) => e.key === 'Enter' && ask());

  function setBusy(which, busy, text = '') {
    const btn = which === 'fact' ? el.factBtn : el.askBtn;
    const status = which === 'fact' ? el.factStatus : el.askStatus;
    btn.disabled = busy;
    if (busy || text) status.textContent = text;
  }

  // ---- answer -------------------------------------------------------------
  let streaming = '';
  function answerReset() {
    streaming = '';
    el.answer.textContent = '';
    el.answer.classList.remove('muted');
    el.answer.classList.add('streaming');
    el.sources.innerHTML = '';
  }
  function answerAppend(token) {
    streaming += token;
    el.answer.textContent = streaming;
  }
  function answerSet(text, sources = []) {
    streaming = text;
    el.answer.textContent = text;
    el.answer.classList.remove('streaming', 'muted');
    el.sources.innerHTML = sources
      .map((s) => `<div class="src"><b>#${s.id}${s.score != null ? ` · ${Number(s.score).toFixed(2)}` : ''}</b>${escape(s.chunk)}</div>`)
      .join('');
  }

  // ---- explainer / tooltip ------------------------------------------------
  function showExplainer(key, pin = false) {
    if (pin) pinned = key;
    const k = key || pinned;
    if (!k) return;
    const d = NODES[k];
    el.exTitle.textContent = `${d.label} · ${d.sub}`;
    el.exSub.textContent = d.stage;
    el.exBody.textContent = d.blurb;
    el.exStatus.textContent = stageStatus[k] || '';
  }
  function setStageStatus(key, text) {
    stageStatus[key] = text;
    if ((pinned || null) === key) el.exStatus.textContent = text || '';
  }
  function hover(key, x, y) {
    if (!key) {
      el.tooltip.hidden = true;
      return;
    }
    const d = NODES[key];
    el.tooltip.innerHTML = `<b>${d.label}</b>${d.stage}${stageStatus[key] ? `<br><span class="muted">${escape(stageStatus[key])}</span>` : ''}`;
    el.tooltip.hidden = false;
    el.tooltip.style.left = `${Math.min(x + 14, window.innerWidth - 280)}px`;
    el.tooltip.style.top = `${y + 14}px`;
    if (!pinned) showExplainer(key);
  }

  // ---- event log ----------------------------------------------------------
  function log(e) {
    if (e.type === 'stage' && e.status === 'progress' && e.data?.token !== undefined) return; // too chatty
    const li = document.createElement('li');
    li.className = `${e.type} ${e.status || ''} ${e.replay ? 'replay' : ''}`;
    const t = new Date(e.ts).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' });
    const who = e.stage || e.type;
    const what = e.type === 'hello' ? `connected · ${e.data?.mode} mode · ${e.data?.pipeline?.chunks ?? 0} chunks stored` : e.type === 'stage' ? `${e.status}${e.detail ? ` · ${e.detail}` : ''}` : e.type === 'job' ? `${e.flow} ${e.status}${e.data?.input ? ` · "${e.data.input.slice(0, 60)}"` : ''}` : e.type === 'answer' ? `answer (${e.data?.sources?.length || 0} sources)` : e.detail || e.status || JSON.stringify(e.data || {}).slice(0, 80);
    li.innerHTML = `<span class="t">${t}</span><span class="s">${escape(who)}</span><span>${escape(what)}</span>`;
    el.log.prepend(li);
    while (el.log.children.length > 120) el.log.lastChild.remove();
    el.logCount.textContent = `(${++logCount})`;
  }

  // ---- badges / toast -----------------------------------------------------
  function setMode(text, cls = '') {
    el.mode.textContent = text;
    el.mode.className = `badge ${cls}`;
  }
  function setConn(state) {
    el.conn.textContent = state === 'open' ? 'SSE live' : 'SSE reconnecting';
    el.conn.className = `badge ${state === 'open' ? 'ok' : 'warn'}`;
  }
  function toast(msg, cls = '', ms = 4500) {
    el.toast.textContent = msg;
    el.toast.className = `toast ${cls}`;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.hidden = true), ms);
  }

  // ---- replay controls ----------------------------------------------------
  function setRecordings(list, status = {}) {
    const cur = el.recSelect.value;
    el.recSelect.innerHTML = list.length
      ? list.map((r) => `<option value="${r.name}">${r.name} (${r.events} ev, ${(r.duration / 1000).toFixed(1)}s)</option>`).join('')
      : '<option value="">no recordings</option>';
    if (list.some((r) => r.name === cur)) el.recSelect.value = cur;
    setRecorderStatus(status);
  }
  function setRecorderStatus({ recording, replaying } = {}) {
    el.recBtn.textContent = recording ? `■ Stop rec (${recording})` : '● Record';
    el.recBtn.classList.toggle('active', Boolean(recording));
    el.playBtn.hidden = Boolean(replaying);
    el.stopBtn.hidden = !replaying;
    el.playBtn.disabled = !el.recSelect.value;
  }
  el.recBtn.addEventListener('click', () => handlers.onRecordToggle());
  el.playBtn.addEventListener('click', () => el.recSelect.value && handlers.onReplay(el.recSelect.value, Number(el.recSpeed.value)));
  el.stopBtn.addEventListener('click', () => handlers.onStopReplay());

  return { setBusy, answerReset, answerAppend, answerSet, showExplainer, setStageStatus, hover, log, setMode, setConn, toast, setRecordings, setRecorderStatus, get pinned() { return pinned; } };
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
