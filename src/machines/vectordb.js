/** VECTOR DB: glass enclosure over 12 chambers that fill with glowing vector cubes; a scanner sweeps during search. */
import * as THREE from 'three';
import { Solid, rrBox, box, cyl, tagPart, textPlate, lineSegments, follow, Burst } from '../kit.js';

export const CHAMBER_COLS = 4;
export const CHAMBER_ROWS = 3;
export const CHAMBERS = CHAMBER_COLS * CHAMBER_ROWS;

export function buildVectorDb(parts) {
  const g = new THREE.Group();
  const center = new THREE.Vector3(7, 1.5, -4);
  g.position.set(center.x, 0, center.z);

  const W = 7;
  const D = 5;
  const plinthPart = parts['vectordb.plinth'];
  const plinth = tagPart(new Solid(rrBox(W, 0.45, D, 0.3, 0.06), { opacity: 1 }), plinthPart);
  g.add(plinth);
  plinthPart.solids.push(plinth);
  // readout plate on the plinth front
  const readout = textPlate(2.4, 0.36, { px: 56, color: '#4dff9a' });
  readout.position.set(0.1, 0.24, D / 2 + 0.07);
  g.add(readout);
  readout.set('rows 0000');
  const rules = lineSegments([[1.6, 0.3, D / 2 + 0.07], [3.0, 0.3, D / 2 + 0.07], [1.6, 0.18, D / 2 + 0.07], [2.6, 0.18, D / 2 + 0.07]], 0x3e444c);
  g.add(rules);

  // enclosure (glass)
  const EW = 6.4;
  const ED = 4.4;
  const EH = 2.5;
  const encPart = parts['vectordb.enclosure'];
  const glass = tagPart(new Solid(box(EW, EH, ED), { fill: 0x1a2a30, edge: 0x5d646e, opacity: 0.16, depthWrite: false }), encPart);
  glass.position.set(0, 0.45, 0);
  glass.mesh.renderOrder = 3;
  g.add(glass);
  encPart.solids.push(glass);
  // posts with ball caps at corners and mid-edges
  const post = cyl(0.09, EH, 12);
  const cap = new THREE.SphereGeometry(0.14, 12, 10);
  for (const [sx, sz] of [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]) {
    const p = tagPart(new Solid(post, { fill: 0x0c0d10, edge: 0x7a828c, opacity: 1, threshold: 60 }), encPart);
    p.position.set(sx * (EW / 2 - 0.08), 0.45, sz * (ED / 2 - 0.08));
    g.add(p);
    const c = new Solid(cap, { fill: 0x0c0d10, edge: 0x7a828c, opacity: 1, pick: false, threshold: 60 });
    c.position.set(sx * (EW / 2 - 0.08), 0.45 + EH, sz * (ED / 2 - 0.08));
    g.add(c);
    encPart.solids.push(p);
  }
  // chamber floor grid + thin dividing walls
  const chamberPart = parts['vectordb.chamber'];
  const cw = (EW - 0.3) / CHAMBER_COLS;
  const cd = (ED - 0.3) / CHAMBER_ROWS;
  const chamberFloors = [];
  const chamberPos = [];
  for (let r = 0; r < CHAMBER_ROWS; r++)
    for (let c = 0; c < CHAMBER_COLS; c++) {
      const x = -EW / 2 + 0.15 + cw * (c + 0.5);
      const z = -ED / 2 + 0.15 + cd * (r + 0.5);
      const floor = tagPart(new Solid(box(cw - 0.1, 0.06, cd - 0.1), { fill: 0x121317, edge: 0x3e444c, opacity: 1 }), chamberPart);
      floor.position.set(x, 0.45, z);
      floor.chamberIndex = chamberFloors.length;
      g.add(floor);
      chamberFloors.push(floor);
      chamberPos.push(new THREE.Vector3(x, 0.5, z));
      chamberPart.solids.push(floor);
    }
  const wallH = 1.3;
  for (let c = 1; c < CHAMBER_COLS; c++) {
    const w = new Solid(box(0.03, wallH, ED - 0.3), { fill: 0x2a3a40, edge: 0x4a515a, opacity: 0.25, depthWrite: false, pick: false });
    w.position.set(-EW / 2 + 0.15 + cw * c, 0.51, 0);
    g.add(w);
  }
  for (let r = 1; r < CHAMBER_ROWS; r++) {
    const w = new Solid(box(EW - 0.3, wallH, 0.03), { fill: 0x2a3a40, edge: 0x4a515a, opacity: 0.25, depthWrite: false, pick: false });
    w.position.set(0, 0.51, -ED / 2 + 0.15 + cd * r);
    g.add(w);
  }

  // scanner: rail on top, head bridging it, light curtain under it
  const scanPart = parts['vectordb.scanner'];
  for (const sz of [-1, 1]) {
    const rail = tagPart(new Solid(cyl(0.05, EW - 0.4, 8), { fill: 0x0c0d10, edge: 0x6a717a, opacity: 1, threshold: 60 }), scanPart);
    rail.rotation.z = Math.PI / 2;
    rail.position.set((EW - 0.4) / 2, 0.45 + EH + 0.12, sz * (ED / 2 - 0.35));
    g.add(rail);
    scanPart.solids.push(rail);
  }
  const head = tagPart(new Solid(box(0.45, 0.22, ED - 0.3), { fill: 0x15171b, edge: 0x8a919c, opacity: 1, glow: '#38e8ff' }), scanPart);
  head.position.set(-EW / 2 + 0.6, 0.45 + EH + 0.05, 0);
  g.add(head);
  scanPart.solids.push(head);
  const curtain = new THREE.Mesh(
    new THREE.PlaneGeometry(0.08, EH - 0.1),
    new THREE.MeshBasicMaterial({ color: new THREE.Color('#38e8ff').multiplyScalar(2.2), transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  curtain.geometry.rotateY(Math.PI / 2);
  curtain.position.set(head.position.x, 0.45 + EH / 2, 0);
  curtain.scale.z = (ED - 0.3) / 1;
  const curtain2 = curtain.clone();
  curtain2.geometry = new THREE.PlaneGeometry(ED - 0.3, EH - 0.1).rotateY(Math.PI / 2);
  curtain2.scale.set(1, 1, 1);
  g.add(curtain2);
  g.remove(curtain);

  // cubes
  const cubes = []; // index = row id - 1
  const cubeGeom = box(0.3, 0.3, 0.3);
  const cubePart = parts['vectordb.cube'];
  function slotFor(i) {
    const chamber = i % CHAMBERS;
    const n = Math.floor(i / CHAMBERS);
    const level = Math.floor(n / 9);
    const s = n % 9;
    const p = chamberPos[chamber];
    return new THREE.Vector3(p.x - 0.45 + (s % 3) * 0.45, 0.51 + level * 0.34, p.z - 0.4 + Math.floor(s / 3) * 0.4);
  }
  function addCube(color, animate = true) {
    const i = cubes.length;
    const cube = tagPart(new Solid(cubeGeom, { fill: new THREE.Color(color).multiplyScalar(0.45), edge: new THREE.Color(color).multiplyScalar(1.6), opacity: 0.95, glow: '#ffffff' }), cubePart);
    const slot = slotFor(i);
    cube.position.copy(slot);
    cube.rest = slot.y;
    if (animate) cube.position.y += 2.2;
    cube.color = color;
    cube.rowId = i + 1;
    cube.chamber = i % CHAMBERS;
    g.add(cube);
    cubes.push(cube);
    return cube;
  }

  let scanning = 0;
  let scanT = 0;
  let scanOpacity = 0;
  const flash = new Burst(0.05, 1.4);
  let flashed = [];

  const machine = {
    key: 'vectordb',
    group: g,
    center,
    focusZoom: 2.3,
    cubes,
    chamberPos,
    update(dt, t) {
      for (const c of cubes) if (c.position.y !== c.rest) c.position.y = Math.abs(c.position.y - c.rest) < 0.003 ? c.rest : follow(c.position.y, c.rest, dt, 9);
      if (scanning > 0) scanT += dt * 1.6;
      const sweep = scanning > 0 ? 0.5 - 0.5 * Math.cos(scanT * Math.PI) : 0;
      const x = -EW / 2 + 0.6 + sweep * (EW - 1.2);
      head.position.x = follow(head.position.x, scanning > 0 ? x : -EW / 2 + 0.6, dt, 14);
      curtain2.position.x = head.position.x;
      scanOpacity = follow(scanOpacity, scanning > 0 ? 0.55 : 0, dt, 10);
      curtain2.material.opacity = scanOpacity * (0.75 + 0.25 * Math.sin(t * 40));
      head.active = scanning > 0 ? 0.9 : 0;
      flash.tick(dt);
      const f = flash.value;
      for (const c of flashed) c.active = f;
    },
    /** sync cube count with the backend row count; new cubes take `color` */
    setCount(count, color = '#4dff9a', animate = true) {
      while (cubes.length < count) addCube(color, animate);
      while (cubes.length > count) g.remove(cubes.pop());
      readout.set(`rows ${String(cubes.length).padStart(4, '0')}`);
    },
    startScan() {
      scanning = 1;
      scanT = 0;
    },
    stopScan() {
      scanning = 0;
    },
    /** flash the cubes (by row id) a search retrieved; returns their world positions */
    hit(ids) {
      for (const c of flashed) c.active = 0;
      flashed = ids.map((id) => cubes[id - 1]).filter(Boolean);
      flash.fire();
      return flashed.map((c) => {
        const v = c.position.clone();
        g.localToWorld(v);
        return { pos: v, chamber: c.chamber, id: c.rowId };
      });
    },
    setActive(level) {
      for (const s of parts['vectordb.enclosure'].solids) s.active = level * 0.45;
      for (const s of parts['vectordb.plinth'].solids) s.active = level * 0.2;
    },
    get scanning() {
      return scanning > 0;
    },
    get headX() {
      return head.position.x;
    },
    get flashing() {
      return flash.value;
    },
    chamberWorld(i) {
      const v = chamberPos[i].clone();
      g.localToWorld(v);
      return v;
    },
  };
  return machine;
}
