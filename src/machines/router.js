/** KNOWLEDGE BASE / MANAGED AGENT: a round dial with a needle that points at retrieved chambers, a knob, and a prompt tray. */
import * as THREE from 'three';
import { Solid, rrBox, box, cyl, ring, tagPart, lineSegments, lineLoop, circlePoints, radialTicks, follow, Burst } from '../kit.js';

export function buildRouter(parts) {
  const g = new THREE.Group();
  const center = new THREE.Vector3(-1, 1.1, 4.5);
  g.position.set(center.x, 0, center.z);

  const basePart = parts['router.base'];
  const base = tagPart(new Solid(rrBox(4.6, 0.5, 3.8, 0.3, 0.06), { opacity: 1 }), basePart);
  g.add(base);
  basePart.solids.push(base);
  g.add(lineSegments([[-2.0, 0.51, 1.5], [-0.4, 0.51, 1.5], [-2.0, 0.51, 1.65], [-1.0, 0.51, 1.65]], 0x3e444c));

  // dial housing (KB)
  const dialPart = parts['router.dial'];
  const dx = -0.95;
  const dz = -0.1;
  const housing = tagPart(new Solid(cyl(1.45, 0.9, 40), { fill: 0x0e0f12, opacity: 1, threshold: 60 }), dialPart);
  housing.position.set(dx, 0.5, dz);
  g.add(housing);
  const bezel = tagPart(new Solid(ring(1.45, 1.25, 0.12, 40), { fill: 0x15171b, edge: 0x8a919c, opacity: 1, threshold: 60 }), dialPart);
  bezel.position.set(dx, 1.4, dz);
  g.add(bezel);
  const face = tagPart(new Solid(cyl(1.25, 0.04, 40), { fill: 0x08090b, edge: 0x3e444c, opacity: 1, threshold: 60 }), dialPart);
  face.position.set(dx, 1.4, dz);
  g.add(face);
  dialPart.solids.push(housing, bezel, face);
  const ticks = lineSegments(radialTicks(1.05, 1.17, 48, 1.46, 4, 0.06), 0x6a717a);
  ticks.position.set(dx, 0, dz);
  g.add(ticks);
  const majors = lineSegments(radialTicks(0.95, 1.17, 12, 1.465, 1, 0), 0x9aa3ad);
  majors.position.set(dx, 0, dz);
  g.add(majors);
  const innerRing = lineLoop(circlePoints(0.7, 48, 1.46), 0x3e444c);
  innerRing.position.set(dx, 0, dz);
  g.add(innerRing);
  // needle: pivot hub + arm + counterweight
  const needlePart = parts['router.needle'];
  const needle = new THREE.Group();
  needle.position.set(dx, 1.45, dz);
  const hub = tagPart(new Solid(cyl(0.16, 0.16, 16), { fill: 0x1a1c21, edge: 0x8a919c, opacity: 1, threshold: 60 }), needlePart);
  needle.add(hub);
  const arm = tagPart(new Solid(box(1.1, 0.04, 0.07), { fill: 0x202329, edge: 0xdde3ea, opacity: 1, glow: '#ffffff' }), needlePart);
  arm.position.set(0.55, 0.06, 0);
  needle.add(arm);
  const tip = tagPart(new Solid(new THREE.ConeGeometry(0.06, 0.22, 4).rotateZ(-Math.PI / 2), { fill: 0x202329, edge: 0xdde3ea, opacity: 1, glow: '#ffffff', threshold: 60 }), needlePart);
  tip.position.set(1.18, 0.08, 0);
  needle.add(tip);
  const tail = tagPart(new Solid(box(0.35, 0.05, 0.1), { fill: 0x202329, edge: 0x9aa3ad, opacity: 1 }), needlePart);
  tail.position.set(-0.2, 0.06, 0);
  needle.add(tail);
  const cap = new Solid(cyl(0.07, 0.06, 12), { fill: 0x2a2d33, edge: 0x9aa3ad, opacity: 1, pick: false, threshold: 60 });
  cap.position.y = 0.16;
  needle.add(cap);
  needlePart.solids.push(hub, arm, tip, tail);
  g.add(needle);

  // knob (knurled: 24 flats with visible seams)
  const knobPart = parts['router.knob'];
  const knob = tagPart(new Solid(cyl(0.32, 0.5, 24), { fill: 0x15171b, edge: 0x7a828c, opacity: 1, threshold: 10 }), knobPart);
  knob.position.set(dx + 1.2, 0.5, dz + 1.25);
  g.add(knob);
  const knobCap = tagPart(new Solid(cyl(0.22, 0.08, 24), { fill: 0x1a1c21, edge: 0x9aa3ad, opacity: 1, threshold: 60 }), knobPart);
  knobCap.position.set(dx + 1.2, 1.0, dz + 1.25);
  g.add(knobCap);
  const knobMark = lineSegments([[0.05, 1.09, 0], [0.2, 1.09, 0]], 0xdde3ea);
  knob.add(knobMark);
  knobMark.position.set(0, 0.59, 0);
  knobPart.solids.push(knob, knobCap);

  // prompt tray (agent): two rails, three slot plates, a prompt lamp
  const trayPart = parts['router.tray'];
  const tx = 1.35;
  const tz = -0.2;
  for (const sz of [-1, 1]) {
    const rail = tagPart(new Solid(cyl(0.07, 1.5, 10), { fill: 0x0c0d10, edge: 0x7a828c, opacity: 1, threshold: 60 }), trayPart);
    rail.position.set(tx, 0.5, tz + sz * 0.55);
    g.add(rail);
    trayPart.solids.push(rail);
  }
  const slots = [];
  for (let i = 0; i < 3; i++) {
    const s = tagPart(new Solid(box(1.5, 0.07, 0.95), { fill: 0x121317, edge: 0x5d646e, opacity: 0.95, glow: '#b77bff' }), trayPart);
    s.position.set(tx, 0.7 + i * 0.4, tz);
    g.add(s);
    slots.push(s);
    trayPart.solids.push(s);
  }
  const lampBase = tagPart(new Solid(cyl(0.2, 0.1, 16), { opacity: 1, threshold: 60 }), trayPart);
  lampBase.position.set(tx + 0.5, 0.5, tz + 1.2);
  g.add(lampBase);
  const lamp = tagPart(new Solid(cyl(0.13, 0.26, 16, 0.1), { fill: 0x1b1d22, edge: 0x6a717a, opacity: 1, glow: '#b77bff', threshold: 60 }), trayPart);
  lamp.position.set(tx + 0.5, 0.6, tz + 1.2);
  g.add(lamp);
  trayPart.solids.push(lampBase, lamp);

  const levels = { kb: 0, agent: 0 };
  const trayFrame = parts['router.tray'].solids.filter((s) => !slots.includes(s) && s !== lamp);
  let needleAngle = -Math.PI / 2;
  let needleTarget = -Math.PI / 2;
  let sweeping = 0;
  let sweepT = 0;
  let knobTurn = 0;
  let knobTarget = 0;
  const lampBurst = new Burst(0.05, 2.5);
  let targets = [];
  let targetIdx = 0;
  let targetTimer = 0;

  const machine = {
    key: 'router',
    group: g,
    center,
    focusZoom: 3,
    update(dt, t) {
      if (sweeping > 0) {
        sweepT += dt;
        needleTarget = -Math.PI / 2 + Math.sin(sweepT * 5) * 1.2;
      } else if (targets.length > 1) {
        targetTimer += dt;
        if (targetTimer > 0.9) {
          targetTimer = 0;
          targetIdx = (targetIdx + 1) % targets.length;
          needleTarget = targets[targetIdx];
        }
      }
      needleAngle = follow(needleAngle, needleTarget, dt, sweeping ? 12 : 5);
      needle.rotation.y = needleAngle;
      knobTurn = follow(knobTurn, knobTarget, dt, 6);
      knob.rotation.y = knobTurn;
      lampBurst.tick(dt);
      lamp.active = lampBurst.value;
      void t;
    },
    sweep(on) {
      sweeping = on ? 1 : 0;
      if (on) sweepT = 0;
    },
    /** point the needle at world positions (cycles through them) */
    pointAt(worldPositions) {
      sweeping = 0;
      const origin = new THREE.Vector3(dx, 0, dz);
      g.localToWorld(origin);
      targets = worldPositions.map((p) => -Math.atan2(p.z - origin.z, p.x - origin.x));
      targetIdx = 0;
      targetTimer = 0;
      needleTarget = targets.length ? targets[0] : -Math.PI / 2;
    },
    rest() {
      sweeping = 0;
      targets = [];
      needleTarget = -Math.PI / 2;
    },
    turnKnob() {
      knobTarget += Math.PI / 6;
    },
    setSlots(n) {
      slots.forEach((s, i) => (s.active = i < n ? 0.9 : 0));
    },
    promptReady() {
      lampBurst.fire();
    },
    get sweeping() {
      return sweeping > 0;
    },
    get needleAngle() {
      return needleAngle;
    },
    get needleTarget() {
      return needleTarget;
    },
    setActive(level, which = 'kb') {
      levels[which] = level;
      for (const s of parts['router.dial'].solids) s.active = levels.kb * 0.5;
      for (const s of parts['router.knob'].solids) s.active = levels.kb * 0.35;
      for (const s of trayFrame) s.active = levels.agent * 0.5;
      for (const s of parts['router.base'].solids) s.active = Math.max(levels.kb, levels.agent) * 0.2;
    },
  };
  return machine;
}
