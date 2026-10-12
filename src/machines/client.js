/** CLIENT: plinth, 3×3 keypad of round keys that press down, a tilted terminal screen, status LED. */
import * as THREE from 'three';
import { Solid, rrBox, box, cyl, tagPart, textPlate, lineLoop, follow } from '../kit.js';

export function buildClient(parts) {
  const g = new THREE.Group();
  const center = new THREE.Vector3(-14.5, 0.6, 0.5);
  g.position.set(center.x, 0, center.z);

  const plinth = tagPart(new Solid(rrBox(4.2, 0.9, 4.2, 0.35, 0.08), { opacity: 1 }), parts['client.plinth']);
  g.add(plinth);
  parts['client.plinth'].solids.push(plinth);
  const top = tagPart(new Solid(rrBox(3.7, 0.12, 3.6, 0.2), { fill: 0x101115, opacity: 1 }), parts['client.plinth']);
  top.position.set(0, 0.9, 0.2);
  g.add(top);
  parts['client.plinth'].solids.push(top);
  // corner screws on the top plate
  const screw = cyl(0.07, 0.03, 12);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const s = new Solid(screw, { fill: 0x0c0d10, edge: 0x6a717a, opacity: 1, pick: false, threshold: 60 });
    s.position.set(sx * 1.65, 1.02, 0.2 + sz * 1.6);
    g.add(s);
  }

  // keypad: 3×3 round keys, collar + cap
  const keys = [];
  const collarGeom = cyl(0.42, 0.1, 24);
  const capGeom = cyl(0.33, 0.3, 24, 0.3);
  const keypad = parts['client.keypad'];
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) {
      const x = (c - 1) * 1.05;
      const z = 0.55 + (r - 1) * 1.0;
      const collar = tagPart(new Solid(collarGeom, { fill: 0x0c0d10, edge: 0x5d646e, opacity: 1 }), keypad);
      collar.position.set(x, 1.02, z);
      g.add(collar);
      const cap = tagPart(new Solid(capGeom, { fill: 0x15171b, edge: 0x7a828c, opacity: 1 }), keypad);
      cap.position.set(x, 1.12, z);
      g.add(cap);
      keypad.solids.push(collar, cap);
      keys.push({ cap, rest: 1.12, press: 0, y: 1.12 });
    }

  // terminal screen: a tilted slab at the back with a text plate on its face
  const screenPart = parts['client.screen'];
  const frame = tagPart(new Solid(box(3.4, 1.7, 0.16), { fill: 0x0c0d10, opacity: 1 }), screenPart);
  const screen = new THREE.Group();
  screen.position.set(0, 0.9, -1.45);
  screen.rotation.x = -0.28;
  frame.position.set(0, 0, 0);
  screen.add(frame);
  screenPart.solids.push(frame);
  const plate = textPlate(3.1, 1.3, { px: 27, color: '#59d4ff', bg: '#07090c' });
  plate.position.set(0, 0.87, 0.085);
  screen.add(plate);
  // screen bezel rule lines
  screen.add(lineLoop([[-1.55, 0.14, 0.09], [1.55, 0.14, 0.09]], 0x3a4048));
  // stand struts
  for (const sx of [-1, 1]) {
    const strut = new Solid(box(0.12, 0.5, 0.5), { fill: 0x0c0d10, opacity: 1, pick: false });
    strut.position.set(sx * 1.3, 0.9, -1.55);
    g.add(strut);
  }
  g.add(screen);
  // LED
  const led = new Solid(cyl(0.09, 0.06, 12), { fill: 0x222, edge: 0x444, opacity: 1, pick: false, threshold: 60 });
  led.position.set(1.55, 1.02, -0.85);
  g.add(led);

  // port block on the right face where the two request tracks leave, and one on the front for the answer track
  const port = new Solid(box(0.25, 0.7, 2.4), { fill: 0x101115, opacity: 1, pick: false });
  port.position.set(2.2, 0.1, 0.5);
  g.add(port);

  const lines = ['> ready_', ''];
  function screenText(l1, l2 = '', color) {
    lines[0] = l1;
    lines[1] = l2;
    plate.set([l1.slice(0, 24), l2.slice(0, 24)], color);
  }
  screenText('> ready_', 'waiting for input');

  let ledColor = new THREE.Color('#222222');
  let ledTarget = new THREE.Color('#222222');
  const machine = {
    key: 'client',
    group: g,
    center,
    focusZoom: 3,
    update(dt, t) {
      for (const k of keys) {
        k.press = Math.max(0, k.press - dt * 5);
        const target = k.rest - 0.17 * Math.min(1, k.press * 3);
        k.y = follow(k.y, target, dt, 28);
        k.cap.position.y = k.y;
      }
      ledColor.lerp(ledTarget, 1 - Math.exp(-dt * 6));
      led.mesh.material.color.copy(ledColor);
      led.lines.material.color.copy(ledColor).multiplyScalar(1.6);
      void t;
    },
    /** press a sequence of keys, like typing */
    type(indices = [4], delay = 70) {
      indices.forEach((i, n) => setTimeout(() => (keys[i % 9].press = 1), n * delay));
    },
    setLed(color) {
      ledTarget.set(color);
    },
    screen: screenText,
    setActive(level) {
      for (const s of parts['client.keypad'].solids) s.active = level * 0.5;
      for (const s of parts['client.plinth'].solids) s.active = level * 0.25;
    },
  };
  return machine;
}
