/**
 * Small geometry / material kit for the wireframe-glow look:
 * every part is a Solid = translucent dark fill + crisp grey edge lines,
 * which lerps towards cyan (over-bright, so bloom picks it up) when hovered or active.
 */
import * as THREE from 'three';

export const C = {
  bg: 0x111111,
  board: 0x17181c,
  fill: 0x0c0d10,
  edge: 0x5d646e,
  edgeDim: 0x3b4149,
  cyan: 0x38e8ff,
  label: '#8b929d',
};

export const MONO = "ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace";

const registry = [];
const _tmp = new THREE.Color();
const CYAN = new THREE.Color(C.cyan);

/** Fill mesh + edge lines, with a smooth glow level. */
export class Solid extends THREE.Group {
  constructor(geom, opts = {}) {
    super();
    const { fill = C.fill, edge = C.edge, opacity = 0.92, edgeOpacity = 1, threshold = 20, depthWrite = true, glow = C.cyan, pick = true, edges = true } = opts;
    this.baseFill = new THREE.Color(fill);
    this.baseEdge = new THREE.Color(edge);
    this.glowColor = new THREE.Color(glow);
    this.mesh = new THREE.Mesh(
      geom,
      new THREE.MeshBasicMaterial({ color: fill, transparent: opacity < 1, opacity, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, depthWrite })
    );
    this.add(this.mesh);
    if (edges) {
      this.lines = new THREE.LineSegments(new THREE.EdgesGeometry(geom, threshold), new THREE.LineBasicMaterial({ color: edge, transparent: edgeOpacity < 1, opacity: edgeOpacity }));
      this.add(this.lines);
    }
    this.mesh.userData.solid = this;
    this.pickable = pick;
    this.hover = 0; // target from pointer
    this.active = 0; // target from pipeline activity
    this.level = 0; // smoothed
    registry.push(this);
  }
  /** Re-tint the resting colours (used for coloured data cubes / slabs). */
  setBase(fill, edge) {
    this.baseFill.set(fill);
    this.baseEdge.set(edge);
    this.level = -1; // force refresh
  }
  setGlowColor(c) {
    this.glowColor.set(c);
    this.level = -1;
  }
  static tickAll(dt) {
    const k = 1 - Math.exp(-dt * 9);
    for (const s of registry) {
      const target = Math.max(s.hover, s.active);
      if (Math.abs(target - s.level) < 0.002 && s.level >= 0) continue;
      s.level = s.level < 0 ? target : s.level + (target - s.level) * k;
      const g = s.level;
      _tmp.copy(s.glowColor).multiplyScalar(0.9 + 1.4 * g);
      if (s.lines) s.lines.material.color.copy(s.baseEdge).lerp(_tmp, g);
      _tmp.copy(s.glowColor).multiplyScalar(0.16);
      s.mesh.material.color.copy(s.baseFill).lerp(_tmp, g * 0.8);
    }
  }
}

export function tagPart(solid, part) {
  solid.traverse((o) => {
    if (o.isMesh) o.userData.part = part;
  });
  solid.part = part;
  return solid;
}

// ---- shapes ---------------------------------------------------------------
export function rrShape(w, d, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  r = Math.min(r, w / 2, d / 2);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r);
  s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d);
  s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Rounded box standing on y=0 (optionally bevelled rim). Footprint w (x) × d (z). */
export function rrBox(w, h, d, r = 0.15, bevel = 0) {
  const g = new THREE.ExtrudeGeometry(rrShape(w, d, r), {
    depth: Math.max(0.01, h - 2 * bevel),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 5,
  });
  g.rotateX(Math.PI / 2);
  g.translate(0, h - bevel, 0);
  return g;
}

/** Plain box standing on y=0. */
export function box(w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, h / 2, 0);
  return g;
}

/** Vertical cylinder standing on y=0. */
export function cyl(r, h, seg = 24, rTop = r) {
  const g = new THREE.CylinderGeometry(rTop, r, h, seg);
  g.translate(0, h / 2, 0);
  return g;
}

/** Flat ring (annulus) standing on y=0. */
export function ring(rOuter, rInner, h, seg = 32) {
  const s = new THREE.Shape();
  s.absarc(0, 0, rOuter, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, rInner, 0, Math.PI * 2, true);
  s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: seg / 4 });
  g.rotateX(Math.PI / 2);
  g.translate(0, h, 0);
  return g;
}

/** Spur gear lying flat on y=0, axis = y. */
export function gear(teeth, R, h, { depth = 0.2, hole = 0.16 } = {}) {
  const s = new THREE.Shape();
  const r = R - depth;
  const step = (Math.PI * 2) / teeth;
  const pt = (rad, a) => [rad * Math.cos(a), rad * Math.sin(a)];
  let first = true;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    const pts = [pt(r, a), pt(r, a + 0.3 * step), pt(R, a + 0.42 * step), pt(R, a + 0.72 * step), pt(r, a + 0.85 * step)];
    for (const [x, y] of pts) {
      if (first) s.moveTo(x, y);
      else s.lineTo(x, y);
      first = false;
    }
  }
  s.closePath();
  if (hole > 0) {
    const holePath = new THREE.Path();
    holePath.absarc(0, 0, hole, 0, Math.PI * 2, true);
    s.holes.push(holePath);
  }
  const g = new THREE.ExtrudeGeometry(s, { depth: h, bevelEnabled: false, curveSegments: 6 });
  g.rotateX(Math.PI / 2);
  g.translate(0, h, 0);
  return g;
}

// ---- lines -----------------------------------------------------------------
export function lineSegments(points, color = C.edge, opacity = 1) {
  const g = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}
export function lineLoop(points, color = C.edge, opacity = 1) {
  const g = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}
export function circlePoints(r, n = 48, y = 0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([r * Math.cos((i / n) * Math.PI * 2), y, r * Math.sin((i / n) * Math.PI * 2)]);
  return out;
}
/** Radial ticks on the XZ plane around (0,y,0). */
export function radialTicks(rIn, rOut, n, y = 0, major = 5, majorExtra = 0.12) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ro = rOut + (i % major === 0 ? majorExtra : 0);
    pts.push([rIn * Math.cos(a), y, rIn * Math.sin(a)], [ro * Math.cos(a), y, ro * Math.sin(a)]);
  }
  return pts;
}

// ---- text textures --------------------------------------------------------
const texCache = new Map();
export function textTexture(text, { px = 56, color = C.label, bold = false, spacing = 0.14, pad = 10 } = {}) {
  const key = `${text}|${px}|${color}|${bold}|${spacing}`;
  if (texCache.has(key)) return texCache.get(key);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `${bold ? '600 ' : ''}${px}px ${MONO}`;
  ctx.font = font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(px * spacing)}px`;
  const w = Math.ceil(ctx.measureText(text).width + pad * 2 + (ctx.letterSpacing ? 0 : text.length * px * spacing));
  canvas.width = Math.max(4, w);
  canvas.height = Math.ceil(px * 1.35);
  ctx.font = font;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(px * spacing)}px`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  if (!('letterSpacing' in ctx)) {
    let x = pad;
    for (const ch of text) {
      ctx.fillText(ch, x, canvas.height / 2);
      x += ctx.measureText(ch).width + px * spacing;
    }
  } else ctx.fillText(text, pad, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const out = { tex, aspect: canvas.width / canvas.height };
  texCache.set(key, out);
  return out;
}

/** Monospace label lying flat on the board (reads upright from the default camera). */
export function flatLabel(text, { size = 0.34, color = C.label, bold = false, spacing = 0.18, opacity = 0.95 } = {}) {
  const { tex, aspect } = textTexture(text, { color, bold, spacing });
  const h = size * 1.35;
  const geom = new THREE.PlaneGeometry(h * aspect, h);
  geom.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity, depthWrite: false }));
  m.renderOrder = 1;
  return m;
}

/** A small vertical text plate (canvas texture) for readouts on machine faces. Call .set(text). */
export function textPlate(w, h, { color = '#9aa3ad', bg = '#0b0c0f', px = 44, align = 'left', font = MONO } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((w / h) * 128);
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: false, polygonOffset: true, polygonOffsetFactor: -1 }));
  mesh.set = (lines, lineColor = color) => {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = lineColor;
    ctx.font = `${px}px ${font}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = align;
    const arr = Array.isArray(lines) ? lines : [lines];
    const lh = canvas.height / (arr.length + 0.4);
    arr.forEach((t, i) => ctx.fillText(t, align === 'center' ? canvas.width / 2 : 14, lh * (i + 0.7)));
    tex.needsUpdate = true;
  };
  mesh.set('');
  return mesh;
}

// ---- motion helpers -------------------------------------------------------
export const follow = (cur, target, dt, rate = 8) => cur + (target - cur) * (1 - Math.exp(-dt * rate));
export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);

/** One-shot envelope: rises quickly, decays. value() in [0,1]. */
export class Burst {
  constructor(attack = 0.08, decay = 0.5) {
    this.attack = attack;
    this.decay = decay;
    this.t = Infinity;
  }
  fire() {
    this.t = 0;
  }
  tick(dt) {
    this.t += dt;
  }
  get value() {
    if (this.t < this.attack) return this.t / this.attack;
    const d = (this.t - this.attack) / this.decay;
    return d >= 1 ? 0 : 1 - d * d * (3 - 2 * d);
  }
}

/** Particle sprite texture (soft round). */
let _dot;
export function dotTexture() {
  if (_dot) return _dot;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.8)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  _dot = new THREE.CanvasTexture(c);
  return _dot;
}

/** Distinct bright colours, one per job. */
export const JOB_COLORS = ['#ffb347', '#ff4fd8', '#4dff9a', '#5b8dff', '#ff7a3d', '#b77bff', '#f0ff4d', '#ff6b8a'];
