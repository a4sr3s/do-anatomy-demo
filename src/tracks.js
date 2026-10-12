/**
 * Pipes between machines (parallel lanes at 90°/45° on the board) and the
 * glowing particle streams that run along them. A stream is launched per
 * backend stage event; nothing moves on its own.
 */
import * as THREE from 'three';
import { Solid, box, dotTexture } from './kit.js';

const PIPE_Y = 0.32;
const LANE_GAP = 0.3;
const PIPE_R = 0.11;

/** Track routes in board coordinates [x, z]. Lanes: 0 = forward, 1 = return. */
export const ROUTES = {
  'client-spaces': { pts: [[-12.3, -0.45], [-11.5, -0.45], [-10.7, -1.25], [-10.7, -4.5], [-9.7, -4.5]], lanes: 2 },
  'client-router': { pts: [[-12.3, 1.45], [-11.5, 1.45], [-10.7, 2.25], [-10.7, 4.5], [-3.3, 4.5]], lanes: 2 },
  'spaces-functions': { pts: [[-5.3, -4.5], [-3.3, -4.5]], lanes: 2 },
  'functions-vectordb': { pts: [[1.3, -4.5], [3.5, -4.5]], lanes: 2 },
  // app-side retrieval (fallback 1 / legacy backends): harness right face straight to pgvector, skirting the gateway on the right
  'router-vectordb': { pts: [[1.3, 3.2], [4.4, 3.2], [4.4, -1.5]], lanes: 2 },
  // v4 tool path: harness (back face) -> Action Gateway (left port) -> pgvector (search_facts, back port) / Spaces (get_document, left port)
  'router-gateway': { pts: [[-2.5, 2.6], [-2.5, 0.5], [-0.2, 0.5]], lanes: 2 },
  'gateway-vectordb': { pts: [[2.0, -1.0], [2.0, -2.4], [3.5, -2.4]], lanes: 2 },
  'gateway-spaces': { pts: [[-0.2, -0.5], [-3.8, -0.5], [-4.8, -1.5], [-4.8, -3.4], [-5.3, -3.4]], lanes: 2 },
  'router-inference': { pts: [[1.3, 5.4], [6, 5.4]], lanes: 2 },
  'inference-client': { pts: [[11, 4.5], [12.2, 4.5], [12.2, 8.7], [-11.5, 8.7], [-13.2, 7], [-13.2, 2.6]], lanes: 3 },
};

function offsetPolyline(pts, off) {
  // offset a 2D polyline to its right by `off`, with mitre joins
  const n = pts.length;
  const out = [];
  const segN = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dz = pts[i + 1][1] - pts[i][1];
    const L = Math.hypot(dx, dz) || 1;
    segN.push([dz / L, -dx / L]);
  }
  for (let i = 0; i < n; i++) {
    const a = segN[Math.max(0, i - 1)];
    const b = segN[Math.min(n - 2, i)];
    let nx = a[0] + b[0];
    let nz = a[1] + b[1];
    const L = Math.hypot(nx, nz) || 1;
    nx /= L;
    nz /= L;
    const cos = a[0] * nx + a[1] * nz || 1;
    out.push([pts[i][0] + (nx * off) / cos, pts[i][1] + (nz * off) / cos]);
  }
  return out;
}

export function buildTracks(scene, parts) {
  const group = new THREE.Group();
  const tracks = {};
  const jointGeom = new THREE.SphereGeometry(PIPE_R * 1.15, 10, 8);

  for (const [id, r] of Object.entries(ROUTES)) {
    const lanes = [];
    const laneCount = r.lanes;
    for (let l = 0; l < laneCount; l++) {
      const off = (l - (laneCount - 1) / 2) * LANE_GAP;
      const p2 = offsetPolyline(r.pts, off);
      const pts3 = p2.map(([x, z]) => new THREE.Vector3(x, PIPE_Y, z));
      // cumulative lengths
      const cum = [0];
      for (let i = 1; i < pts3.length; i++) cum.push(cum[i - 1] + pts3[i].distanceTo(pts3[i - 1]));
      lanes.push({ pts: pts3, cum, length: cum[cum.length - 1] });
      // pipe legs
      for (let i = 0; i < pts3.length - 1; i++) {
        const a = pts3[i];
        const b = pts3[i + 1];
        const len = a.distanceTo(b);
        const g = new THREE.CylinderGeometry(PIPE_R, PIPE_R, len, 10, 1, false);
        const s = new Solid(g, { fill: 0x0b0c0f, edge: 0x7a8592, opacity: 0.82, threshold: 40, depthWrite: false, pick: true });
        s.position.copy(a).lerp(b, 0.5);
        s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
        s.traverse((o) => {
          if (o.isMesh) o.userData.part = parts.track;
        });
        group.add(s);
        if (i < pts3.length - 2) {
          const j = new Solid(jointGeom, { fill: 0x0b0c0f, edge: 0x6a7480, opacity: 1, threshold: 60, pick: false });
          j.position.copy(b);
          group.add(j);
        }
      }
    }
    // sleepers straddling all lanes every ~2.4 units along the centre line
    const centre = r.pts.map(([x, z]) => new THREE.Vector3(x, 0, z));
    for (let i = 0; i < centre.length - 1; i++) {
      const a = centre[i];
      const b = centre[i + 1];
      const len = a.distanceTo(b);
      const count = Math.floor((len - 0.8) / 2.4);
      for (let k = 1; k <= count; k++) {
        const t = (k / (count + 1)) * len;
        const p = a.clone().lerp(b, t / len);
        const width = (laneCount - 1) * LANE_GAP + 2 * PIPE_R + 0.5;
        const sg = box(0.42, 0.2, width);
        const s = new Solid(sg, { fill: 0x121317, edge: 0x3f454d, opacity: 1, pick: false });
        s.position.copy(p);
        s.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
        group.add(s);
      }
    }
    // port collars at both ends (small blocks where the pipe enters a machine)
    for (const end of [0, centre.length - 1]) {
      const p = centre[end];
      const q = centre[end === 0 ? 1 : end - 1];
      const width = (laneCount - 1) * LANE_GAP + 2 * PIPE_R + 0.5;
      const cg = box(0.3, 0.62, width);
      const s = new Solid(cg, { fill: 0x101115, edge: 0x4a515a, opacity: 1, pick: false });
      s.position.copy(p).lerp(q, 0.12 / p.distanceTo(q));
      s.rotation.y = -Math.atan2(q.z - p.z, q.x - p.x);
      group.add(s);
    }
    tracks[id] = { id, lanes, length: lanes[0].length };
  }
  scene.add(group);

  // ---- particles ------------------------------------------------------------
  const MAX = 6000;
  const positions = new Float32Array(MAX * 3);
  const colors = new Float32Array(MAX * 3);
  const sizes = new Float32Array(MAX);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
  geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPR: { value: Math.min(window.devicePixelRatio || 1, 1.5) }, uTex: { value: dotTexture() }, uZoom: { value: 1 } },
    vertexShader: `
      attribute float size; attribute vec3 color; varying vec3 vColor; uniform float uPR; uniform float uZoom;
      void main(){ vColor = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * uPR * sqrt(uZoom); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `
      varying vec3 vColor; uniform sampler2D uTex;
      void main(){ float a = texture2D(uTex, gl_PointCoord).a; if (a < 0.02) discard; gl_FragColor = vec4(vColor * a, a); }`,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  scene.add(points);

  const streams = [];
  let inFlight = 0;
  const _c = new THREE.Color();

  /**
   * Launch a stream of particles along a track lane.
   * Returns a promise resolved when the head reaches the end.
   */
  function send(trackId, { color = '#38e8ff', lane = 0, count = 40, speed = 14, spacing = 0.16, size = 7, reverse = false, gain = 1.9, onArrive } = {}) {
    const track = tracks[trackId];
    if (!track) return Promise.resolve();
    const L = track.lanes[Math.min(lane, track.lanes.length - 1)];
    _c.set(color);
    return new Promise((resolve) => {
      streams.push({ lane: L, color: [_c.r * gain, _c.g * gain, _c.b * gain], s: 0, speed, count, spacing, size, reverse, arrived: false, onArrive, resolve });
    });
  }

  function posAt(lane, s, out) {
    const { pts, cum } = lane;
    if (s <= 0) return out.copy(pts[0]);
    if (s >= lane.length) return out.copy(pts[pts.length - 1]);
    let i = 1;
    while (cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1]);
    return out.copy(pts[i - 1]).lerp(pts[i], t);
  }

  const tmp = new THREE.Vector3();
  function update(dt, zoom) {
    mat.uniforms.uZoom.value = zoom;
    let n = 0;
    inFlight = 0;
    for (let k = streams.length - 1; k >= 0; k--) {
      const st = streams[k];
      st.s += st.speed * dt;
      const tail = st.s - st.count * st.spacing;
      if (!st.arrived && st.s >= st.lane.length) {
        st.arrived = true;
        st.onArrive?.();
        st.resolve();
      }
      if (tail > st.lane.length) {
        streams.splice(k, 1);
        continue;
      }
      inFlight++;
      for (let i = 0; i < st.count && n < MAX; i++) {
        const s = st.s - i * st.spacing;
        if (s < 0 || s > st.lane.length) continue;
        posAt(st.lane, st.reverse ? st.lane.length - s : s, tmp);
        const wob = 0.025 * Math.sin(s * 9 + i);
        positions[n * 3] = tmp.x;
        positions[n * 3 + 1] = tmp.y + wob;
        positions[n * 3 + 2] = tmp.z;
        const f = i === 0 ? 1.35 : 1 - (i / st.count) * 0.55;
        colors[n * 3] = st.color[0] * f;
        colors[n * 3 + 1] = st.color[1] * f;
        colors[n * 3 + 2] = st.color[2] * f;
        sizes[n] = st.size * (i === 0 ? 1.5 : 1 - (i / st.count) * 0.4);
        n++;
      }
    }
    geom.setDrawRange(0, n);
    geom.attributes.position.needsUpdate = true;
    geom.attributes.color.needsUpdate = true;
    geom.attributes.size.needsUpdate = true;
  }

  return { group, tracks, send, update, get inFlight() { return inFlight; }, get streams() { return streams.length; } };
}

