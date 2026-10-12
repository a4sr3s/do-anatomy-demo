/** Thin SSE client with reconnect state callbacks. */
export function connectEvents({ onEvent, onState }) {
  let es;
  let lastId = 0;
  const open = () => {
    es = new EventSource(`/api/events${lastId ? `?since=${lastId}` : ''}`);
    es.onopen = () => onState('open');
    es.onerror = () => onState('reconnecting');
    const handle = (msg) => {
      try {
        const e = JSON.parse(msg.data);
        if (e.id) lastId = Math.max(lastId, e.id);
        onEvent(e);
      } catch (err) {
        console.warn('bad event', err);
      }
    };
    for (const type of ['hello', 'job', 'stage', 'answer', 'recorder', 'replay', 'fallback']) es.addEventListener(type, handle);
    es.onmessage = handle;
  };
  open();
  return { close: () => es?.close() };
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error(json.error || `${res.status} ${res.statusText}`);
  return json;
}
