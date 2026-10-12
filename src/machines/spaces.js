/** SPACES: a cabinet with three drawers that slide open to receive glowing document slabs. */
import * as THREE from 'three';
import { Solid, rrBox, box, cyl, tagPart, lineSegments, follow, Burst } from '../kit.js';

export function buildSpaces(parts) {
  const g = new THREE.Group();
  const center = new THREE.Vector3(-7.5, 1.4, -4.5);
  g.position.set(center.x, 0, center.z);

  const W = 4.4;
  const D = 3.6;
  const H = 3.1;
  const bodyPart = parts['spaces.body'];
  const base = tagPart(new Solid(rrBox(W, 0.3, D, 0.2, 0.05), { opacity: 1 }), bodyPart);
  g.add(base);
  bodyPart.solids.push(base);
  // carcass: back wall, two side walls, top
  const carcass = new THREE.Group();
  carcass.position.y = 0.3;
  const wallOpts = { fill: 0x0d0e11, opacity: 0.88 };
  const back = tagPart(new Solid(box(W - 0.2, H - 0.3, 0.12), wallOpts), bodyPart);
  back.position.set(0, 0, -D / 2 + 0.16);
  carcass.add(back);
  for (const sx of [-1, 1]) {
    const side = tagPart(new Solid(box(0.12, H - 0.3, D - 0.2), wallOpts), bodyPart);
    side.position.set(sx * (W / 2 - 0.16), 0, 0);
    carcass.add(side);
    bodyPart.solids.push(side);
  }
  const top = tagPart(new Solid(rrBox(W, 0.18, D, 0.15), { opacity: 1 }), bodyPart);
  top.position.set(0, H - 0.3, 0);
  carcass.add(top);
  bodyPart.solids.push(back, top);
  // label plate with three rules on the top face
  carcass.add(
    lineSegments(
      [
        [-1.4, H - 0.11, -0.9], [0.6, H - 0.11, -0.9],
        [-1.4, H - 0.11, -0.7], [0.1, H - 0.11, -0.7],
        [-1.4, H - 0.11, -0.5], [0.9, H - 0.11, -0.5],
      ],
      0x3e444c
    )
  );
  // corner posts
  const post = cyl(0.09, H - 0.3, 12);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const p = new Solid(post, { fill: 0x0c0d10, edge: 0x6a717a, opacity: 1, pick: false, threshold: 60 });
    p.position.set(sx * (W / 2 - 0.1), 0, sz * (D / 2 - 0.1));
    carcass.add(p);
  }
  g.add(carcass);

  // drawers
  const drawers = [];
  const drawerPart = parts['spaces.drawer'];
  const slotH = (H - 0.5) / 3;
  for (let i = 0; i < 3; i++) {
    const d = new THREE.Group();
    const y = 0.3 + 0.05 + i * slotH;
    d.position.set(0, y, 0);
    const tray = tagPart(new Solid(box(W - 0.5, slotH - 0.3, D - 0.6), { fill: 0x0d0e11, opacity: 0.55, depthWrite: false }), drawerPart);
    tray.position.set(0, 0.05, -0.1);
    d.add(tray);
    const front = tagPart(new Solid(rrBox(W - 0.32, slotH - 0.12, 0.16, 0.06), { fill: 0x121317, opacity: 1 }), drawerPart);
    front.position.set(0, 0, D / 2 - 0.08);
    d.add(front);
    const handle = tagPart(new Solid(box(1.3, 0.08, 0.14), { fill: 0x1a1c21, edge: 0x7a828c, opacity: 1 }), drawerPart);
    handle.position.set(0, slotH / 2 - 0.1, D / 2 + 0.1);
    d.add(handle);
    for (const sx of [-1, 1]) {
      const stem = new Solid(box(0.08, 0.08, 0.14), { fill: 0x1a1c21, edge: 0x5d646e, opacity: 1, pick: false });
      stem.position.set(sx * 0.6, slotH / 2 - 0.1, D / 2 + 0.02);
      d.add(stem);
    }
    // slot index engraved as a short tick row on the front
    d.add(
      lineSegments(
        [
          [-1.6, 0.25, D / 2 + 0.005], [-1.2 + i * 0.1, 0.25, D / 2 + 0.005],
        ],
        0x4a515a
      )
    );
    drawerPart.solids.push(tray, front, handle);
    g.add(d);
    drawers.push({ group: d, open: 0, target: 0, docs: [], y });
  }

  // trigger lamp on top
  const lampPart = parts['spaces.lamp'];
  const lampBase = tagPart(new Solid(cyl(0.22, 0.12, 16), { opacity: 1 }), lampPart);
  lampBase.position.set(W / 2 - 0.6, H, D / 2 - 0.6);
  g.add(lampBase);
  const lamp = tagPart(new Solid(cyl(0.15, 0.3, 16, 0.12), { fill: 0x1b1d22, edge: 0x6a717a, opacity: 1, glow: '#38e8ff' }), lampPart);
  lamp.position.set(W / 2 - 0.6, H + 0.12, D / 2 - 0.6);
  g.add(lamp);
  lampPart.solids.push(lampBase, lamp);
  const lampBurst = new Burst(0.05, 0.9);

  const docGeom = box(1.3, 0.09, 0.95);
  let objects = 0;

  const machine = {
    key: 'spaces',
    group: g,
    center,
    focusZoom: 2.8,
    update(dt) {
      for (const d of drawers) {
        d.open = follow(d.open, d.target, dt, 7);
        d.group.position.z = d.open * 1.7;
      }
      lampBurst.tick(dt);
      lamp.active = lampBurst.value;
    },
    /** open the drawer for a new object; returns the drawer index */
    open(index = objects % 3) {
      drawers[index].target = 1;
      return index;
    },
    close(index) {
      drawers[index].target = 0;
    },
    /** drop a document slab into a drawer (colour = job colour); `key` is the Spaces object key it stands for. */
    file(index, color, key = null, { instant = false } = {}) {
      const d = drawers[index];
      const n = d.docs.length;
      const doc = tagPart(new Solid(docGeom, { fill: new THREE.Color(color).multiplyScalar(0.35), edge: new THREE.Color(color).multiplyScalar(1.5), opacity: 0.9, glow: color }), parts['spaces.doc']);
      doc.restY = 0.12 + 0.11 * Math.floor(n / 3);
      doc.position.set(-0.9 + (n % 3) * 0.9, instant ? doc.restY : 1.3, -0.1 + 0.05 * Math.floor(n / 3));
      doc.key = key;
      d.group.add(doc);
      d.docs.push(doc);
      if (d.docs.length > 9) {
        const old = d.docs.shift();
        d.group.remove(old);
      }
      objects++;
      return doc;
    },
    /** the drawer holding the slab for `key` (else the drawer that has something to give up, else 0) */
    drawerFor(key) {
      const i = drawers.findIndex((d) => d.docs.some((doc) => doc.key === key));
      if (i >= 0) return i;
      const j = drawers.findIndex((d) => d.docs.length);
      return j >= 0 ? j : 0;
    },
    /** the object was deleted: its slab lifts out of the (open) drawer and shrinks away. Unknown keys take the newest slab. */
    remove(key) {
      let doc = null;
      for (const d of drawers) doc = doc || d.docs.find((x) => x.key === key) || null;
      if (!doc) {
        const d = drawers.find((x) => x.docs.length);
        doc = d ? d.docs[d.docs.length - 1] : null;
      }
      if (!doc) return false;
      lift(doc);
      return true;
    },
    /** every slab leaves (clear all) */
    removeAll() {
      let n = 0;
      for (const d of drawers) for (const doc of d.docs.slice()) if (lift(doc)) n++;
      return n;
    },
    /** slabs for keys the backend holds that are not in the cabinet yet (page load / reconnect); never removes. */
    sync(keys, color = '#38e8ff') {
      const have = new Set(drawers.flatMap((d) => d.docs.map((doc) => doc.key)));
      let n = 0;
      for (const key of keys) {
        if (!key || have.has(key)) continue;
        machine.file(objects % 3, color, key, { instant: true });
        have.add(key);
        n++;
      }
      return n;
    },
    /** keys of the slabs currently filed, per drawer */
    get keys() {
      return drawers.map((d) => d.docs.map((doc) => doc.key));
    },
    trigger() {
      lampBurst.fire();
    },
    setActive(level) {
      for (const s of parts['spaces.body'].solids) s.active = level * 0.35;
      for (const s of parts['spaces.drawer'].solids) s.active = level * 0.5;
    },
    drawers,
    get objects() {
      return objects;
    },
  };
  // a slab leaving a drawer: out of the docs list at once (so the slot count is right), then up and away
  const leaving = [];
  function lift(doc) {
    const d = drawers.find((x) => x.docs.includes(doc));
    if (!d) return false;
    d.docs.splice(d.docs.indexOf(doc), 1);
    doc.restY = doc.position.y + 2.2;
    doc.active = 1;
    leaving.push({ doc, group: d.group });
    objects = Math.max(0, objects - 1);
    return true;
  }
  // docs settle onto the tray floor; leaving slabs rise and shrink until they are gone
  const settle = (dt) => {
    for (const d of drawers)
      for (const doc of d.docs) doc.position.y = follow(doc.position.y, doc.restY, dt, 6);
    for (let k = leaving.length - 1; k >= 0; k--) {
      const { doc, group } = leaving[k];
      doc.position.y = follow(doc.position.y, doc.restY, dt, 4);
      doc.scale.multiplyScalar(Math.max(0, 1 - dt * 1.3));
      if (doc.position.y > doc.restY - 0.25 || doc.scale.x < 0.08) {
        group.remove(doc);
        leaving.splice(k, 1);
      }
    }
  };
  Object.defineProperty(machine, 'leaving', { get: () => leaving.length });
  const baseUpdate = machine.update;
  machine.update = (dt, t) => {
    baseUpdate(dt, t);
    settle(dt);
  };
  return machine;
}
