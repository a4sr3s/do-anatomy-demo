/** INFERENCE · GPU: spindle with four platters, pivoting actuator arm, glowing track rings, a flat fan, heatsink fins. */
import * as THREE from 'three';
import { Solid, rrBox, box, cyl, ring, tagPart, textPlate, lineLoop, circlePoints, lineSegments, follow, Burst } from '../kit.js';

export function buildInference(parts) {
  const g = new THREE.Group();
  const center = new THREE.Vector3(8.5, 1.2, 4.5);
  g.position.set(center.x, 0, center.z);

  const basePart = parts['inference.base'];
  const base = tagPart(new Solid(rrBox(5, 0.5, 4, 0.3, 0.06), { opacity: 1 }), basePart);
  g.add(base);
  basePart.solids.push(base);
  const readout = textPlate(2.4, 0.36, { px: 56, color: '#ff6b8a' });
  readout.position.set(-1.1, 0.25, 2.07);
  g.add(readout);
  readout.set('tokens 0000');
  g.add(lineSegments([[0.4, 0.33, 2.07], [2.2, 0.33, 2.07], [0.4, 0.2, 2.07], [1.6, 0.2, 2.07]], 0x3e444c));

  // spindle + platters
  const platPart = parts['inference.platters'];
  const sx = -0.7;
  const sz = 0.3;
  const spindle = tagPart(new Solid(cyl(0.16, 2.1, 14), { fill: 0x0c0d10, edge: 0x7a828c, opacity: 1, threshold: 60 }), platPart);
  spindle.position.set(sx, 0.5, sz);
  g.add(spindle);
  const motor = tagPart(new Solid(cyl(0.6, 0.35, 24), { fill: 0x101115, opacity: 1, threshold: 60 }), platPart);
  motor.position.set(sx, 0.5, sz);
  g.add(motor);
  const platters = new THREE.Group();
  platters.position.set(sx, 0, sz);
  const platterGeom = cyl(1.45, 0.07, 48);
  const spacerGeom = cyl(0.32, 0.3, 16);
  for (let i = 0; i < 4; i++) {
    const p = tagPart(new Solid(platterGeom, { fill: 0x121317, edge: 0x7a828c, opacity: 0.9, threshold: 60 }), platPart);
    p.position.y = 0.95 + i * 0.37;
    platters.add(p);
    platPart.solids.push(p);
    const s = new Solid(spacerGeom, { fill: 0x0c0d10, edge: 0x5d646e, opacity: 1, pick: false, threshold: 60 });
    s.position.y = 1.02 + i * 0.37;
    platters.add(s);
  }
  const clamp = new Solid(cyl(0.45, 0.1, 24, 0.38), { fill: 0x1a1c21, edge: 0x8a919c, opacity: 1, pick: false, threshold: 60 });
  clamp.position.y = 0.95 + 3 * 0.37 + 0.07;
  platters.add(clamp);
  // spoke marks on the top platter so the spin reads
  platters.add(lineSegments([[0.45, 2.09, 0], [1.35, 2.09, 0], [-0.45, 2.09, 0], [-1.35, 2.09, 0]], 0x4a515a));
  g.add(platters);
  platPart.solids.push(spindle, motor);
  // track rings (lines on the top platter) — coloured per job during generation
  const rings = [];
  for (const r of [0.65, 0.9, 1.15, 1.38]) {
    const l = lineLoop(circlePoints(r, 64, 2.095), 0x3e444c);
    l.position.set(sx, 0, sz);
    g.add(l);
    rings.push(l);
  }

  // actuator arm on a pivot post
  const armPart = parts['inference.arm'];
  const px = 1.35;
  const pz = 1.3;
  const pivot = tagPart(new Solid(cyl(0.2, 2.25, 16), { fill: 0x0c0d10, edge: 0x7a828c, opacity: 1, threshold: 60 }), armPart);
  pivot.position.set(px, 0.5, pz);
  g.add(pivot);
  const armGroup = new THREE.Group();
  armGroup.position.set(px, 2.14, pz);
  const armHub = tagPart(new Solid(cyl(0.3, 0.12, 20), { fill: 0x15171b, edge: 0x9aa3ad, opacity: 1, threshold: 60 }), armPart);
  armGroup.add(armHub);
  const arm = tagPart(new Solid(box(2.1, 0.07, 0.22), { fill: 0x15171b, edge: 0xb8c0ca, opacity: 1 }), armPart);
  arm.position.set(-1.05, 0.04, 0);
  armGroup.add(arm);
  const headG = tagPart(new Solid(box(0.26, 0.1, 0.3), { fill: 0x1a1c21, edge: 0xdde3ea, opacity: 1, glow: '#ffffff' }), armPart);
  headG.position.set(-2.1, 0.0, 0);
  armGroup.add(headG);
  const counter = tagPart(new Solid(box(0.5, 0.18, 0.34), { fill: 0x1a1c21, edge: 0x9aa3ad, opacity: 1 }), armPart);
  counter.position.set(0.45, 0.02, 0);
  armGroup.add(counter);
  g.add(armGroup);
  armPart.solids.push(pivot, armHub, arm, headG, counter);
  // arm angle: the arm points from the pivot towards the spindle; a seek swings it over the rings
  const baseAngle = Math.atan2(-(sz - pz), -(sx - px)); // direction pivot->spindle in XZ (rotation about y)
  const armRest = -baseAngle;

  // fan (flat) at the right-back
  const fanPart = parts['inference.fan'];
  const fx = 1.5;
  const fz = -1.1;
  const shroud = tagPart(new Solid(ring(0.85, 0.7, 0.3, 40), { fill: 0x101115, edge: 0x7a828c, opacity: 1, threshold: 60 }), fanPart);
  shroud.position.set(fx, 0.5, fz);
  g.add(shroud);
  const fan = new THREE.Group();
  fan.position.set(fx, 0.62, fz);
  const fanHub = tagPart(new Solid(cyl(0.22, 0.16, 16), { fill: 0x15171b, edge: 0x9aa3ad, opacity: 1, threshold: 60 }), fanPart);
  fan.add(fanHub);
  const bladeGeom = box(0.5, 0.03, 0.2);
  bladeGeom.translate(0.42, 0, 0);
  for (let i = 0; i < 7; i++) {
    const b = tagPart(new Solid(bladeGeom, { fill: 0x15171b, edge: 0x8a919c, opacity: 1 }), fanPart);
    b.rotation.y = (i / 7) * Math.PI * 2;
    b.rotation.x = 0.5;
    b.position.y = 0.06;
    fan.add(b);
    fanPart.solids.push(b);
  }
  g.add(fan);
  fanPart.solids.push(shroud, fanHub);
  // fan guard: 4 struts
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const st = lineSegments([[fx + 0.22 * Math.cos(a), 0.82, fz + 0.22 * Math.sin(a)], [fx + 0.72 * Math.cos(a), 0.82, fz + 0.72 * Math.sin(a)]], 0x5d646e);
    g.add(st);
  }

  // heatsink fins along the back
  const hsPart = parts['inference.heatsink'];
  const finGeom = box(0.05, 0.75, 1.0);
  for (let i = 0; i < 9; i++) {
    const f = tagPart(new Solid(finGeom, { fill: 0x121317, edge: 0x5d646e, opacity: 1 }), hsPart);
    f.position.set(-2.1 + i * 0.17, 0.5, -1.35);
    g.add(f);
    hsPart.solids.push(f);
  }
  const hsBase = tagPart(new Solid(box(1.55, 0.1, 1.1), { fill: 0x0c0d10, opacity: 1 }), hsPart);
  hsBase.position.set(-1.42, 0.5, -1.35);
  g.add(hsBase);
  hsPart.solids.push(hsBase);

  let spin = 0;
  let spinTarget = 0;
  let fanSpin = 0.15;
  let fanTarget = 0.15;
  let seek = 0;
  let seekTarget = 0;
  let ringColor = new THREE.Color(0x3e444c);
  let ringTarget = new THREE.Color(0x3e444c);
  let ringIdx = 0;
  const tokenBurst = new Burst(0.03, 0.25);
  let tokens = 0;

  const machine = {
    key: 'inference',
    group: g,
    center,
    focusZoom: 2.8,
    update(dt, t) {
      spin = follow(spin, spinTarget, dt, 2.5);
      platters.rotation.y -= dt * spin * 9;
      fanSpin = follow(fanSpin, fanTarget, dt, 3);
      fan.rotation.y += dt * fanSpin * 12;
      seek = follow(seek, seekTarget, dt, 18);
      armGroup.rotation.y = armRest + seek;
      tokenBurst.tick(dt);
      headG.active = tokenBurst.value;
      ringColor.lerp(ringTarget, 1 - Math.exp(-dt * 5));
      rings.forEach((r, i) => {
        const on = spin > 0.3 && i === ringIdx;
        r.material.color.copy(ringColor).multiplyScalar(on ? 1.6 + 0.5 * Math.sin(t * 30) : 0.55);
      });
      void t;
    },
    spinUp(color) {
      spinTarget = 1;
      fanTarget = 1;
      ringTarget.set(color);
      seekTarget = 0.2;
    },
    spinDown() {
      spinTarget = 0;
      fanTarget = 0.15;
      ringTarget.set(0x3e444c);
      seekTarget = 0;
    },
    token() {
      tokens++;
      tokenBurst.fire();
      ringIdx = (ringIdx + 1 + Math.floor(Math.random() * 3)) % rings.length;
      seekTarget = 0.02 + ringIdx * 0.1 + Math.random() * 0.04;
      readout.set(`tokens ${String(tokens).padStart(4, '0')}`);
    },
    setActive(level) {
      for (const s of parts['inference.platters'].solids) s.active = level * 0.45;
      for (const s of parts['inference.arm'].solids) s.active = level * 0.4;
      for (const s of parts['inference.base'].solids) s.active = level * 0.2;
    },
    get tokens() {
      return tokens;
    },
    get spin() {
      return spin;
    },
    get seek() {
      return seek;
    },
  };
  return machine;
}
