/** FUNCTIONS: two meshing gears on a base plate and a press that slams down to chunk and stamp. */
import * as THREE from 'three';
import { Solid, rrBox, box, cyl, gear, tagPart, lineSegments, follow, Burst } from '../kit.js';

export function buildFunctions(parts) {
  const g = new THREE.Group();
  const center = new THREE.Vector3(-1, 1.2, -4.5);
  g.position.set(center.x, 0, center.z);

  const basePart = parts['functions.base'];
  const base = tagPart(new Solid(rrBox(4.6, 0.5, 3.8, 0.3, 0.06), { opacity: 1 }), basePart);
  g.add(base);
  basePart.solids.push(base);
  // status LEDs along the front edge
  const leds = [];
  for (let i = 0; i < 3; i++) {
    const l = new Solid(cyl(0.07, 0.04, 12), { fill: 0x1b1d22, edge: 0x4a515a, opacity: 1, pick: false, threshold: 60 });
    l.position.set(-1.9 + i * 0.3, 0.5, 1.6);
    g.add(l);
    leds.push(l);
  }
  // rule lines (label plate) on the base top, front-right
  g.add(lineSegments([[0.6, 0.51, 1.45], [2.0, 0.51, 1.45], [0.6, 0.51, 1.6], [1.6, 0.51, 1.6]], 0x3e444c));

  // gears (flat, meshing)
  const gearPart = parts['functions.gears'];
  const nA = 14;
  const nB = 9;
  const RA = 1.0;
  const RB = 0.68;
  const A = tagPart(new Solid(gear(nA, RA, 0.3), { fill: 0x101115, edge: 0x8a919c, opacity: 1, threshold: 15 }), gearPart);
  const B = tagPart(new Solid(gear(nB, RB, 0.3), { fill: 0x101115, edge: 0x8a919c, opacity: 1, threshold: 15 }), gearPart);
  const ax = -1.45;
  const az = 0.25;
  const dist = RA + RB - 0.2; // teeth overlap by the tooth depth
  const phi = -0.55; // direction from A to B in the XZ plane (rad)
  const bx = ax + dist * Math.cos(phi);
  const bz = az + dist * Math.sin(phi);
  A.position.set(ax, 0.62, az);
  B.position.set(bx, 0.62, bz);
  // mesh phase: a tooth of A points at B, a gap of B faces A. Rotation about +y turns x towards -z, so angle = -rotation.
  const stepA = (Math.PI * 2) / nA;
  const stepB = (Math.PI * 2) / nB;
  const A0 = -(phi - 0.57 * stepA);
  const B0 = -(phi + Math.PI - 1.07 * stepB);
  A.rotation.y = A0;
  B.rotation.y = B0;
  g.add(A, B);
  gearPart.solids.push(A, B);
  // axle pins + bearing washers
  for (const [x, z] of [[ax, az], [bx, bz]]) {
    const pin = new Solid(cyl(0.14, 1.1, 14), { fill: 0x0c0d10, edge: 0x7a828c, opacity: 1, pick: false, threshold: 60 });
    pin.position.set(x, 0.5, z);
    const washer = new Solid(cyl(0.3, 0.12, 20), { fill: 0x0c0d10, edge: 0x5d646e, opacity: 1, pick: false, threshold: 60 });
    washer.position.set(x, 0.5, z);
    g.add(pin, washer);
  }

  // press: two posts, crossbar, ram, anvil
  const pressPart = parts['functions.press'];
  const px = 1.5;
  const pz = 0.1;
  for (const sx of [-1, 1]) {
    const post = tagPart(new Solid(cyl(0.11, 2.3, 14), { fill: 0x0c0d10, edge: 0x7a828c, opacity: 1, threshold: 60 }), pressPart);
    post.position.set(px + sx * 0.75, 0.5, pz);
    g.add(post);
    const foot = new Solid(cyl(0.22, 0.1, 16), { opacity: 1, pick: false, threshold: 60 });
    foot.position.set(px + sx * 0.75, 0.5, pz);
    g.add(foot);
    pressPart.solids.push(post);
  }
  const crossbar = tagPart(new Solid(box(1.9, 0.32, 0.5), { fill: 0x0c0d10, opacity: 1 }), pressPart);
  crossbar.position.set(px, 2.75, pz);
  g.add(crossbar);
  const guide = tagPart(new Solid(cyl(0.16, 0.9, 14), { fill: 0x0c0d10, edge: 0x6a717a, opacity: 1, threshold: 60 }), pressPart);
  guide.position.set(px, 1.9, pz);
  g.add(guide);
  const ram = tagPart(new Solid(box(0.9, 0.55, 0.8), { fill: 0x121317, opacity: 1 }), pressPart);
  const ramRest = 1.75;
  ram.position.set(px, ramRest, pz);
  g.add(ram);
  const die = tagPart(new Solid(box(0.8, 0.12, 0.62), { fill: 0x1a1c21, edge: 0x8a919c, opacity: 1 }), pressPart);
  die.position.set(px, ramRest - 0.12, pz);
  g.add(die);
  pressPart.solids.push(crossbar, guide, ram, die);
  const anvil = tagPart(new Solid(box(1.15, 0.28, 0.95), { fill: 0x101115, opacity: 1 }), parts['functions.anvil']);
  anvil.position.set(px, 0.5, pz);
  g.add(anvil);
  parts['functions.anvil'].solids.push(anvil);

  // slab on the anvil (document in progress) and chunk cubes
  let slab = null;
  const chunks = [];
  const slabGeom = box(1.1, 0.08, 0.8);
  const chunkGeom = box(0.26, 0.26, 0.26);

  const press = new Burst(0.07, 0.3);
  const stamp = new Burst(0.05, 0.22);
  let spin = 0;
  let spinTarget = 0;
  let angle = 0;
  let ramY = ramRest;
  let pendingCut = null; // { n, color } spawned when the ram bottoms out
  let stamped = null; // { cube, left }
  const ledBurst = [new Burst(0.05, 0.6), new Burst(0.05, 0.6), new Burst(0.05, 0.6)];

  function cut(n, color) {
    if (slab) {
      g.remove(slab);
      slab = null;
    }
    const count = Math.max(1, Math.min(n, 6));
    for (let i = 0; i < count; i++) {
      const c = tagPart(new Solid(chunkGeom, { fill: new THREE.Color(color).multiplyScalar(0.3), edge: new THREE.Color(color).multiplyScalar(1.4), opacity: 0.95, glow: color }), parts['functions.anvil']);
      c.position.set(px - 0.38 + (i % 3) * 0.38, 0.78, pz - 0.2 + Math.floor(i / 3) * 0.4);
      c.scale.y = 0.1;
      g.add(c);
      chunks.push(c);
    }
  }

  const machine = {
    key: 'functions',
    group: g,
    center,
    focusZoom: 3,
    update(dt) {
      spin = follow(spin, spinTarget, dt, 9);
      angle += dt * spin * 2.6;
      A.rotation.y = A0 + angle;
      B.rotation.y = B0 - angle * (nA / nB);
      press.tick(dt);
      stamp.tick(dt);
      const drop = Math.max(press.value * 0.92, stamp.value * 0.55);
      const target = ramRest - drop * (ramRest - 1.02);
      ramY = follow(ramY, target, dt, drop > 0.5 ? 60 : 12);
      ram.position.y = ramY;
      die.position.y = ramY - 0.12;
      if (pendingCut && press.t >= press.attack) {
        // the ram has just bottomed out: cut the slab into chunks
        cut(pendingCut.n, pendingCut.color);
        pendingCut = null;
      }
      if (stamped) {
        stamped.left -= dt;
        if (stamped.left <= 0) {
          stamped.cube.active = 0.3;
          stamped = null;
        }
      }
      ledBurst.forEach((b, i) => {
        b.tick(dt);
        leds[i].active = b.value;
      });
      for (const c of chunks) c.scale.y = follow(c.scale.y, 1, dt, 10);
    },
    /** the document arrives on the anvil */
    load(color) {
      machine.clear();
      spinTarget = 1;
      slab = tagPart(new Solid(slabGeom, { fill: new THREE.Color(color).multiplyScalar(0.35), edge: new THREE.Color(color).multiplyScalar(1.5), opacity: 0.95, glow: color }), parts['functions.anvil']);
      slab.position.set(px, 0.78, pz);
      g.add(slab);
      ledBurst[0].fire();
    },
    /** chunk: the press slams; the slab becomes n cubes */
    chunk(n, color) {
      press.fire();
      ledBurst[1].fire();
      pendingCut = { n, color };
    },
    /** embed: stamp chunk i with its vector */
    embed(i) {
      stamp.fire();
      ledBurst[2].fire();
      const c = chunks[Math.min(i, chunks.length - 1)];
      if (c) {
        if (stamped) stamped.cube.active = 0.3;
        c.active = 1;
        stamped = { cube: c, left: 0.35 };
      }
    },
    clear() {
      spinTarget = 0;
      pendingCut = null;
      stamped = null;
      if (slab) g.remove(slab);
      slab = null;
      for (const c of chunks) g.remove(c);
      chunks.length = 0;
    },
    setSpin(on) {
      spinTarget = on ? 1 : 0;
    },
    setActive(level) {
      for (const s of parts['functions.gears'].solids) s.active = level * 0.6;
      for (const s of parts['functions.press'].solids) s.active = level * 0.35;
      for (const s of parts['functions.base'].solids) s.active = level * 0.2;
    },
    get chunkCount() {
      return chunks.length;
    },
    get ramY() {
      return ramY;
    },
    get spin() {
      return spin;
    },
  };
  return machine;
}
