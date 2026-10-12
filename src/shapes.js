import * as THREE from 'three';

/**
 * Wireframe + translucent core "anatomy" shapes for each component. Each
 * returns { group, apply({activity, pulse, spin, dt, t}), setFill? }.
 */
export function buildShape(key, def) {
  const color = new THREE.Color(def.color);
  const group = new THREE.Group();
  const wires = [];
  const cores = [];

  const add = (geom, { y = 0, x = 0, z = 0, rot, core = true, wire = true, opacity = 0.16 } = {}) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    if (rot) g.rotation.set(...rot);
    if (wire) {
      const w = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 12), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
      g.add(w);
      wires.push(w);
    }
    if (core) {
      const m = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.15, transparent: true, opacity, roughness: 0.3, metalness: 0.2, depthWrite: false }));
      g.add(m);
      cores.push(m);
    }
    group.add(g);
    return g;
  };

  // plinth under every component
  add(new THREE.BoxGeometry(2.6, 0.16, 2.6), { y: 0.08, opacity: 0.35 });

  const body = new THREE.Group();
  body.position.y = 1.15;
  group.add(body);
  const addBody = (geom, opts) => {
    const g = add(geom, opts);
    group.remove(g);
    body.add(g);
    return g;
  };

  let extra = {};
  switch (def.shape) {
    case 'bucket': {
      addBody(new THREE.CylinderGeometry(0.85, 0.65, 1.5, 14), { y: 0 });
      addBody(new THREE.TorusGeometry(0.88, 0.05, 6, 24), { y: 0.76, rot: [Math.PI / 2, 0, 0], core: false });
      const lid = addBody(new THREE.CylinderGeometry(0.75, 0.75, 0.08, 14), { y: 1.0, opacity: 0.3 });
      extra.lid = lid;
      break;
    }
    case 'gear': {
      const rotor = addBody(new THREE.IcosahedronGeometry(0.8, 0), { y: 0.1 });
      addBody(new THREE.TorusGeometry(1.05, 0.06, 6, 32), { y: 0.1, rot: [Math.PI / 2, 0, 0], core: false });
      extra.rotor = rotor;
      break;
    }
    case 'db': {
      for (let i = 0; i < 3; i++) addBody(new THREE.CylinderGeometry(0.9, 0.9, 0.42, 20), { y: -0.6 + i * 0.6, opacity: 0.1 });
      const fillGeom = new THREE.CylinderGeometry(0.78, 0.78, 1.0, 20);
      fillGeom.translate(0, 0.5, 0);
      const fill = new THREE.Mesh(fillGeom, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, toneMapped: false }));
      fill.position.y = -0.82;
      fill.scale.set(1, 0.03, 1);
      fill.userData.pickable = false;
      body.add(fill);
      extra.fill = fill;
      extra.fillTarget = 0.03;
      break;
    }
    case 'book': {
      for (let i = 0; i < 4; i++) addBody(new THREE.BoxGeometry(1.7, 0.22, 1.25), { y: -0.6 + i * 0.3, x: (i % 2) * 0.12 - 0.06, rot: [0, (i % 2 ? -1 : 1) * 0.12, 0] });
      break;
    }
    case 'agent': {
      addBody(new THREE.OctahedronGeometry(0.85, 0), { y: 0.1 });
      const ring = addBody(new THREE.TorusGeometry(1.15, 0.04, 6, 40), { y: 0.1, rot: [Math.PI / 2.6, 0.3, 0], core: false });
      const ring2 = addBody(new THREE.TorusGeometry(1.15, 0.04, 6, 40), { y: 0.1, rot: [Math.PI / 2.6, -0.3, Math.PI / 2], core: false });
      extra.rings = [ring, ring2];
      break;
    }
    case 'chip': {
      addBody(new THREE.BoxGeometry(1.7, 0.22, 1.7), { y: -0.5 });
      addBody(new THREE.BoxGeometry(0.9, 0.4, 0.9), { y: -0.2, opacity: 0.3 });
      const halo = addBody(new THREE.TorusGeometry(1.1, 0.05, 8, 48), { y: 0.3, rot: [Math.PI / 2, 0, 0], core: false });
      extra.halo = halo;
      break;
    }
    default:
      addBody(new THREE.BoxGeometry(1.4, 1.4, 1.4));
  }

  const white = new THREE.Color(0xffffff);
  const tmp = new THREE.Color();
  function apply({ activity, pulse, spin, dt, t }) {
    const glow = Math.min(1.5, activity + pulse);
    for (const m of cores) {
      m.material.emissiveIntensity = 0.15 + glow * 1.6;
      m.material.opacity = Math.min(0.6, 0.16 + glow * 0.3);
    }
    tmp.copy(color).lerp(white, Math.min(0.7, glow * 0.6));
    for (const w of wires) {
      w.material.color.copy(tmp);
      w.material.opacity = 0.55 + Math.min(0.45, glow * 0.45);
    }
    body.position.y = 1.15 + Math.sin(t * 1.3 + def.pos[0]) * 0.04 + activity * 0.15;
    if (extra.rotor) {
      extra.rotor.rotation.y += dt * (0.4 + spin * 7);
      extra.rotor.rotation.x += dt * spin * 3.5;
    }
    if (extra.rings) extra.rings.forEach((r, i) => (r.rotation.z += dt * (0.3 + activity * 2) * (i ? -1 : 1)));
    if (extra.halo) {
      const s = 1 + pulse * 0.35 + Math.sin(t * 4) * 0.03 * activity;
      extra.halo.scale.set(s, s, s);
    }
    if (extra.lid) extra.lid.position.y = 1.0 + activity * 0.35;
    if (extra.fill) {
      const cur = extra.fill.scale.y;
      extra.fill.scale.y = cur + (extra.fillTarget - cur) * Math.min(1, dt * 3);
      extra.fill.material.opacity = 0.45 + glow * 0.4;
    }
  }

  return { group, apply, setFill: extra.fill ? (ratio) => (extra.fillTarget = 0.03 + Math.max(0, Math.min(1, ratio)) * 1.75) : undefined };
}
