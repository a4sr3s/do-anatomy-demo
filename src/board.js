/** The dark bevelled base board: rim lines, inset groove, corner screws, feet, label plates. */
import * as THREE from 'three';
import { Solid, rrBox, cyl, lineLoop, lineSegments, flatLabel, C, tagPart } from './kit.js';

export const BOARD = { x: -2, z: 1, w: 32, d: 18.6, h: 0.7 };

export function buildBoard(parts) {
  const g = new THREE.Group();
  const { x, z, w, d, h } = BOARD;
  const board = new Solid(rrBox(w, h, d, 1.4, 0.16), { fill: C.board, edge: 0x4a5058, opacity: 1, threshold: 24 });
  board.position.set(x, -h, z);
  tagPart(board, parts.board);
  g.add(board);
  // inset groove on the top (two rounded rules)
  for (const inset of [0.55, 0.75]) {
    const pts = [];
    const r = 1.2;
    const n = 6;
    const W = w - 2 * inset;
    const D = d - 2 * inset;
    const corners = [
      [W / 2 - r, D / 2 - r, 0],
      [-W / 2 + r, D / 2 - r, Math.PI / 2],
      [-W / 2 + r, -D / 2 + r, Math.PI],
      [W / 2 - r, -D / 2 + r, -Math.PI / 2],
    ];
    for (const [cx, cz, a0] of corners) for (let i = 0; i <= n; i++) pts.push([x + cx + r * Math.cos(a0 + (i / n) * (Math.PI / 2)), 0.012, z + cz + r * Math.sin(a0 + (i / n) * (Math.PI / 2))]);
    g.add(lineLoop(pts, inset === 0.55 ? 0x3a4048 : 0x2c3137));
  }
  // corner screws: ring + slot
  const screwGeom = cyl(0.17, 0.05, 20);
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const px = x + sx * (w / 2 - 1.1);
    const pz = z + sz * (d / 2 - 1.1);
    const s = new Solid(screwGeom, { fill: 0x121317, edge: 0x50565e, opacity: 1, pick: false });
    s.position.set(px, 0, pz);
    g.add(s);
    const slot = lineLoop(
      [
        [px - 0.1, 0.06, pz - 0.02],
        [px + 0.1, 0.06, pz - 0.02],
        [px + 0.1, 0.06, pz + 0.02],
        [px - 0.1, 0.06, pz + 0.02],
      ],
      0x6a717a
    );
    slot.rotation.y = sx * sz > 0 ? 0.6 : -0.4;
    slot.position.set(px, 0, pz);
    slot.geometry.translate(-px, 0, -pz);
    g.add(slot);
  }
  // ruler strip along the front edge: a rule with a tick every unit, a major every 5th, numbered by the label plate
  {
    const y = 0.012;
    const zr = z + d / 2 - 0.42;
    const x0 = x - w / 2 + 2.4;
    const x1 = x + w / 2 - 2.4;
    const pts = [[x0, y, zr], [x1, y, zr]];
    for (let i = 0; x0 + i <= x1 + 0.001; i++) {
      const major = i % 5 === 0;
      pts.push([x0 + i, y, zr], [x0 + i, y, zr - (major ? 0.24 : 0.12)]);
    }
    g.add(lineSegments(pts, 0x3a4048));
    // a second, shorter strip on the left edge
    const xr = x - w / 2 + 0.42;
    const z0 = z - d / 2 + 2.4;
    const z1 = z + d / 2 - 2.4;
    const pts2 = [[xr, y, z0], [xr, y, z1]];
    for (let i = 0; z0 + i <= z1 + 0.001; i++) {
      const major = i % 5 === 0;
      pts2.push([xr, y, z0 + i], [xr + (major ? 0.24 : 0.12), y, z0 + i]);
    }
    g.add(lineSegments(pts2, 0x3a4048));
  }
  // feet under the board
  const footGeom = cyl(0.5, 0.35, 24, 0.42);
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const f = new Solid(footGeom, { fill: 0x0e0f12, edge: 0x3a4048, opacity: 1, pick: false });
    f.position.set(x + sx * (w / 2 - 2.2), -h - 0.35, z + sz * (d / 2 - 2.2));
    g.add(f);
  }
  // title plate engraved at the back-right corner with three rule lines
  const plate = flatLabel('DIGITALOCEAN  ·  AI DATA PIPELINE  ·  FIG 1', { size: 0.26, color: '#5f666f', spacing: 0.22 });
  plate.position.set(x + w / 2 - 6.6, 0.015, z - d / 2 + 0.95);
  g.add(plate);
  for (let i = 0; i < 3; i++) {
    const y = 0.012;
    const zz = z - d / 2 + 1.35 + i * 0.16;
    g.add(
      lineLoop(
        [
          [x + w / 2 - 11.6, y, zz],
          [x + w / 2 - 1.6 - i * 1.4, y, zz],
        ],
        0x33383f
      )
    );
  }
  return g;
}

/** Monospace component label lying on the board: NAME on one line, a dimmer sub-line under it. */
export function boardLabel(text, px, pz, opts = {}) {
  const [name, sub] = text.split(' · ');
  const g = new THREE.Group();
  const m = flatLabel(name, { size: 0.5, color: '#aab2bc', spacing: 0.22, ...opts });
  m.position.set(px, 0.014, pz);
  g.add(m);
  if (sub) {
    const s = flatLabel(sub, { size: 0.34, color: '#6f7883', spacing: 0.2 });
    s.position.set(px, 0.014, pz + 0.62);
    g.add(s);
  }
  return g;
}
