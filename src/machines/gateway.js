/**
 * ACTION GATEWAY: the tool switchboard between the Harness Runtime and the data
 * plane. A rotary selector on a turret swings to point at the machine a tool
 * call is routed to (pgvector for search_facts, Spaces for get_document), one
 * jack port per neighbour lights when a packet passes, and a policy plate's
 * lamps flash when a call is allowed. The readout counts tool calls.
 */
import * as THREE from 'three';
import { Solid, rrBox, box, cyl, ring, tagPart, textPlate, lineSegments, lineLoop, circlePoints, radialTicks, follow, Burst } from '../kit.js';

export function buildGateway(parts) {
  const g = new THREE.Group();
  // Sits in the open board between the Harness Runtime (front), Functions (back),
  // Spaces (back-left) and pgvector (back-right), clear of the band the inference
  // platters occlude from the default camera (x >~ 4.2 for z >~ 0.6).
  const center = new THREE.Vector3(1.3, 1.0, 0.0);
  g.position.set(center.x, 0, center.z);

  const W = 3.0;
  const D = 2.0;
  const basePart = parts['gateway.base'];
  const base = tagPart(new Solid(rrBox(W, 0.5, D, 0.25, 0.06), { opacity: 1 }), basePart);
  g.add(base);
  basePart.solids.push(base);
  // readout + MCP server plate on the front (+z) face; the machine name is a board label
  // in front of it (see mount.js LABELS), like every other machine.
  const readout = textPlate(1.4, 0.3, { px: 56, color: '#ffd166' });
  readout.position.set(0.75, 0.25, D / 2 + 0.07);
  g.add(readout);
  readout.set('calls 0000');
  const nameplate = textPlate(1.4, 0.3, { px: 44, color: '#aab2bc', align: 'center' });
  nameplate.position.set(-0.75, 0.25, D / 2 + 0.07);
  g.add(nameplate);
  nameplate.set('MCP · anatomy-data');

  // turret + selector (points at the routed target)
  const selPart = parts['gateway.selector'];
  const sx = -0.45;
  const sz = 0.0;
  const turret = tagPart(new Solid(cyl(0.65, 0.55, 32), { fill: 0x0e0f12, opacity: 1, threshold: 60 }), selPart);
  turret.position.set(sx, 0.5, sz);
  g.add(turret);
  const bezel = tagPart(new Solid(ring(0.65, 0.54, 0.08, 32), { fill: 0x15171b, edge: 0x8a919c, opacity: 1, threshold: 60 }), selPart);
  bezel.position.set(sx, 1.05, sz);
  g.add(bezel);
  const face = tagPart(new Solid(cyl(0.54, 0.03, 32), { fill: 0x08090b, edge: 0x3e444c, opacity: 1, threshold: 60 }), selPart);
  face.position.set(sx, 1.05, sz);
  g.add(face);
  selPart.solids.push(turret, bezel, face);
  const ticks = lineSegments(radialTicks(0.42, 0.5, 24, 1.09, 6, 0.05), 0x6a717a);
  ticks.position.set(sx, 0, sz);
  g.add(ticks);
  const inner = lineLoop(circlePoints(0.28, 32, 1.09), 0x3e444c);
  inner.position.set(sx, 0, sz);
  g.add(inner);
  const selector = new THREE.Group();
  selector.position.set(sx, 1.08, sz);
  const hub = tagPart(new Solid(cyl(0.14, 0.14, 16), { fill: 0x1a1c21, edge: 0x8a919c, opacity: 1, threshold: 60 }), selPart);
  selector.add(hub);
  const arm = tagPart(new Solid(box(0.5, 0.05, 0.08), { fill: 0x202329, edge: 0xdde3ea, opacity: 1, glow: '#ffd166' }), selPart);
  arm.position.set(0.25, 0.06, 0);
  selector.add(arm);
  const tip = tagPart(new Solid(new THREE.ConeGeometry(0.06, 0.18, 4).rotateZ(-Math.PI / 2), { fill: 0x202329, edge: 0xdde3ea, opacity: 1, glow: '#ffd166', threshold: 60 }), selPart);
  tip.position.set(0.56, 0.08, 0);
  selector.add(tip);
  const cap = new Solid(cyl(0.06, 0.05, 12), { fill: 0x2a2d33, edge: 0x9aa3ad, opacity: 1, pick: false, threshold: 60 });
  cap.position.y = 0.14;
  selector.add(cap);
  selPart.solids.push(hub, arm, tip);
  g.add(selector);

  // jack ports: one per neighbour, next to where its track meets the base: harness (left-front),
  // Spaces (left-back) and pgvector (back), with a lamp each
  const portPart = parts['gateway.ports'];
  const ports = {};
  const portGeom = ring(0.19, 0.11, 0.14, 20);
  const pinGeom = cyl(0.09, 0.22, 12);
  const lampGeom = cyl(0.07, 0.16, 12, 0.055);
  const PORTS = {
    harness: { pos: [-1.22, 0.5, 0.5], lamp: [-1.22, 0.5, 0.8] },
    spaces: { pos: [-1.22, 0.5, -0.5], lamp: [-1.22, 0.5, -0.8] },
    pgvector: { pos: [0.7, 0.5, -0.72], lamp: [1.0, 0.5, -0.72] },
  };
  for (const [name, p] of Object.entries(PORTS)) {
    const socket = tagPart(new Solid(portGeom, { fill: 0x121317, edge: 0x7a828c, opacity: 1, threshold: 60 }), portPart);
    socket.position.set(...p.pos);
    g.add(socket);
    const pin = tagPart(new Solid(pinGeom, { fill: 0x0c0d10, edge: 0x5d646e, opacity: 1, threshold: 60 }), portPart);
    pin.position.set(...p.pos);
    g.add(pin);
    const lamp = tagPart(new Solid(lampGeom, { fill: 0x1b1d22, edge: 0x6a717a, opacity: 1, glow: '#ffd166', threshold: 60 }), portPart);
    lamp.position.set(...p.lamp);
    g.add(lamp);
    portPart.solids.push(socket, pin, lamp);
    ports[name] = { socket, pin, lamp, burst: new Burst(0.05, 1.1) };
  }

  // policy plate at the right: a raised slab with two "allow" lamps and a rule bar
  const polPart = parts['gateway.policy'];
  const px = 0.8;
  const pz = 0.15;
  const plate = tagPart(new Solid(rrBox(0.95, 0.45, 1.2, 0.08), { fill: 0x101115, opacity: 1 }), polPart);
  plate.position.set(px, 0.5, pz);
  g.add(plate);
  const bar = tagPart(new Solid(box(0.7, 0.06, 0.12), { fill: 0x1a1c21, edge: 0x8a919c, opacity: 1 }), polPart);
  bar.position.set(px, 0.95, pz + 0.38);
  g.add(bar);
  const allowLamps = [];
  for (let i = 0; i < 2; i++) {
    const l = tagPart(new Solid(cyl(0.1, 0.2, 14, 0.08), { fill: 0x1b1d22, edge: 0x6a717a, opacity: 1, glow: '#4dff9a', threshold: 60 }), polPart);
    l.position.set(px - 0.22 + i * 0.44, 0.95, pz - 0.1);
    g.add(l);
    allowLamps.push(l);
    polPart.solids.push(l);
  }
  g.add(lineSegments([[px - 0.35, 0.96, pz - 0.45], [px + 0.35, 0.96, pz - 0.45], [px - 0.35, 0.96, pz - 0.36], [px + 0.05, 0.96, pz - 0.36]], 0x3e444c));
  polPart.solids.push(plate, bar);
  const allowBurst = new Burst(0.05, 1.6);

  const REST = Math.PI; // selector points along -x (towards the harness port) when idle
  let angle = REST;
  let target = REST;
  let spin = 0;
  let calls = 0;
  let lastRoute = null;

  const machine = {
    key: 'gateway',
    group: g,
    center,
    focusZoom: 3.2,
    update(dt) {
      if (spin > 0) {
        spin -= dt;
        target += dt * 6;
      }
      angle = follow(angle, target, dt, 7);
      selector.rotation.y = angle;
      allowBurst.tick(dt);
      for (const l of allowLamps) l.active = allowBurst.value;
      for (const p of Object.values(ports)) {
        p.burst.tick(dt);
        p.lamp.active = p.burst.value;
      }
    },
    /** swing the selector to point at a world position (the routed target machine) */
    pointAt(worldPos) {
      const origin = new THREE.Vector3(sx, 0, sz);
      g.localToWorld(origin);
      spin = 0;
      target = -Math.atan2(worldPos.z - origin.z, worldPos.x - origin.x);
    },
    /** brief hunting spin while the policy is evaluated */
    seek() {
      spin = 0.35;
    },
    rest() {
      spin = 0;
      target = REST;
    },
    /** a tool call was allowed and routed to `name` (harness | spaces | pgvector) */
    route(name) {
      calls++;
      lastRoute = name;
      allowBurst.fire();
      ports[name]?.burst.fire();
      readout.set(`calls ${String(calls).padStart(4, '0')}`);
    },
    /** a packet touched port `name` */
    port(name) {
      ports[name]?.burst.fire();
    },
    setActive(level) {
      for (const s of parts['gateway.selector'].solids) s.active = level * 0.5;
      for (const s of parts['gateway.policy'].solids.filter((x) => !allowLamps.includes(x))) s.active = level * 0.35;
      for (const s of parts['gateway.base'].solids) s.active = level * 0.2;
    },
    get calls() {
      return calls;
    },
    get lastRoute() {
      return lastRoute;
    },
    get angle() {
      return angle;
    },
    get target() {
      return target;
    },
  };
  return machine;
}
