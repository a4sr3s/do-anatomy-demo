import * as THREE from 'three';

/** Glowing data packets that fly between components along arched paths. */
export function createPacketSystem(scene) {
  const live = new Set();
  const headGeom = new THREE.SphereGeometry(0.17, 16, 16);
  const trailGeom = new THREE.SphereGeometry(0.11, 10, 10);
  const UP = new THREE.Vector3(0, 1, 0);

  function fly(from, to, { color = 0x39d0ff, duration = 0.55, arch = 2.4, onArrive } = {}) {
    const a = from.clone().setY(from.y + 1.3);
    const b = to.clone().setY(to.y + 1.3);
    const mid = a.clone().lerp(b, 0.5).addScaledVector(UP, arch);
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const c = new THREE.Color(color);
    const head = new THREE.Mesh(headGeom, new THREE.MeshBasicMaterial({ color: c.clone().lerp(new THREE.Color(0xffffff), 0.55), toneMapped: false }));
    const trail = [];
    for (let i = 0; i < 7; i++) {
      const m = new THREE.Mesh(trailGeom, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.7 - i * 0.09, toneMapped: false }));
      m.scale.setScalar(1 - i * 0.11);
      trail.push(m);
      scene.add(m);
    }
    const light = new THREE.PointLight(c, 6, 5, 2);
    head.add(light);
    scene.add(head);
    const p = { t: 0, duration, curve, head, trail, onArrive, done: false, fade: 0.35 };
    live.add(p);
    return p;
  }

  function flyUp(from, opts = {}) {
    return fly(from, from.clone().add(new THREE.Vector3(0, 4.5, 0)), { arch: 0.5, duration: 0.8, ...opts });
  }

  function dropIn(to, opts = {}) {
    return fly(to.clone().add(new THREE.Vector3(0, 5.5, 0)), to, { arch: 0, duration: 0.45, ...opts });
  }

  const tmp = new THREE.Vector3();
  function update(dt) {
    for (const p of live) {
      if (!p.done) {
        p.t = Math.min(1, p.t + dt / p.duration);
        const e = p.t < 0.5 ? 2 * p.t * p.t : 1 - Math.pow(-2 * p.t + 2, 2) / 2; // easeInOutQuad
        p.curve.getPoint(e, p.head.position);
        p.trail.forEach((m, i) => p.curve.getPoint(Math.max(0, e - (i + 1) * 0.04), m.position));
        if (p.t >= 1) {
          p.done = true;
          p.onArrive?.();
        }
      } else {
        p.fade -= dt;
        const s = Math.max(0, p.fade / 0.35);
        p.head.scale.setScalar(s);
        p.trail.forEach((m, i) => m.scale.setScalar(s * (1 - i * 0.11)));
        if (p.fade <= 0) {
          scene.remove(p.head);
          p.trail.forEach((m) => scene.remove(m));
          p.head.material.dispose();
          p.trail.forEach((m) => m.material.dispose());
          live.delete(p);
        }
      }
    }
  }

  return { fly, flyUp, dropIn, update, get count() { return live.size; } };
}
