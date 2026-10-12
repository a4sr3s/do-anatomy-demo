import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { NODES, EDGES } from './components.js';
import { buildShape } from './shapes.js';

const FRUSTUM = 11;
const CENTER = new THREE.Vector3(-2, 0.6, 0);

/** Build the isometric three.js scene with labelled, glowing DO components. */
export function createScene(container, { onHover, onSelect } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x050a16, 1);
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x050a16, 30, 70);

  const aspect = () => container.clientWidth / Math.max(1, container.clientHeight);
  const camera = new THREE.OrthographicCamera(-FRUSTUM * aspect(), FRUSTUM * aspect(), FRUSTUM, -FRUSTUM, 0.1, 200);
  camera.position.copy(CENTER).add(new THREE.Vector3(16, 16, 16));
  camera.lookAt(CENTER);
  camera.zoom = 1.25;
  camera.updateProjectionMatrix();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(CENTER);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minZoom = 0.6;
  controls.maxZoom = 3;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.update();

  // lights + ground
  scene.add(new THREE.AmbientLight(0x6f86b8, 0.5));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(8, 14, 6);
  scene.add(key);
  const grid = new THREE.GridHelper(40, 40, 0x1a3d73, 0x0c1b36);
  grid.position.set(-2, 0, 0);
  scene.add(grid);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: 0x060d1d, transparent: true, opacity: 0.9 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(-2, -0.01, 0);
  scene.add(ground);

  // edges (pipes)
  const pipeMat = new THREE.LineBasicMaterial({ color: 0x2a5aa8, transparent: true, opacity: 0.55 });
  for (const [a, b] of EDGES) {
    const pa = new THREE.Vector3(...NODES[a].pos).setY(0.25);
    const pb = new THREE.Vector3(...NODES[b].pos).setY(0.25);
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([pa, pb]), pipeMat));
  }

  // nodes
  const nodes = {};
  const pickables = [];
  for (const [k, def] of Object.entries(NODES)) {
    const view = buildShape(k, def);
    view.group.position.set(...def.pos);
    scene.add(view.group);
    view.group.traverse((o) => {
      if (o.isMesh) {
        o.userData.key = k;
        pickables.push(o);
      }
    });
    const el = document.createElement('div');
    el.className = 'label';
    el.innerHTML = `${def.label}<small>${def.sub}</small><span class="pill" hidden></span>`;
    const label = new CSS2DObject(el);
    label.position.set(0, -0.9, 0);
    view.group.add(label);
    nodes[k] = { ...view, key: k, def, label: el, pill: el.querySelector('.pill'), activity: 0, target: 0, hover: 0, spin: 0, pulse: 0 };
  }

  // post-processing bloom
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.9, 0.6, 0.55);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    renderer.setSize(w, h);
    composer.setSize(w, h);
    labelRenderer.setSize(w, h);
    bloom.setSize(w, h);
    camera.left = -FRUSTUM * aspect();
    camera.right = FRUSTUM * aspect();
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // picking
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  let hovered = null;
  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    return hit ? hit.object.userData.key : null;
  }
  renderer.domElement.addEventListener('pointermove', (ev) => {
    const k = pick(ev);
    if (k !== hovered) {
      if (hovered) nodes[hovered].hover = 0;
      hovered = k;
      if (k) nodes[k].hover = 1;
      renderer.domElement.style.cursor = k ? 'pointer' : 'grab';
    }
    onHover?.(k, ev.clientX, ev.clientY);
  });
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (ev) => (downAt = [ev.clientX, ev.clientY]));
  renderer.domElement.addEventListener('pointerup', (ev) => {
    if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 6) return;
    const k = pick(ev);
    if (k) onSelect?.(k);
  });

  // animation loop
  const timer = new THREE.Timer();
  const tickers = new Set();
  function frame(now) {
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.1);
    const t = timer.getElapsed();
    for (const n of Object.values(nodes)) {
      const goal = Math.max(n.target, n.hover * 0.45);
      n.activity += (goal - n.activity) * Math.min(1, dt * 6);
      n.pulse = Math.max(0, n.pulse - dt * 2.2);
      n.apply({ activity: n.activity, pulse: n.pulse, spin: n.spin, dt, t });
      n.label.classList.toggle('active', n.activity > 0.5);
    }
    for (const fn of tickers) fn(dt, t);
    controls.update();
    composer.render();
    labelRenderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  frame();

  return {
    scene,
    camera,
    nodes,
    onTick: (fn) => tickers.add(fn),
    nodePosition: (k) => new THREE.Vector3(...NODES[k].pos),
    setActivity: (k, v) => nodes[k] && (nodes[k].target = v),
    pulse: (k, v = 1) => nodes[k] && (nodes[k].pulse = Math.max(nodes[k].pulse, v)),
    setSpin: (k, on) => nodes[k] && (nodes[k].spin = on ? 1 : 0),
    setFill: (ratio) => nodes.vectordb.setFill?.(ratio),
    setPill: (k, text) => {
      const n = nodes[k];
      if (!n) return;
      n.pill.textContent = text || '';
      n.pill.hidden = !text;
    },
    resetAll: () => Object.values(nodes).forEach((n) => { n.target = 0; n.spin = 0; n.pill.hidden = true; }),
  };
}
