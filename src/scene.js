/**
 * Renderer, orthographic isometric camera, OrbitControls, bloom composer,
 * picking (hover / click / double-click focus) and the frame loop.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Solid, C } from './kit.js';

export function createScene(container, { onHover, onSelect, onFps } = {}) {
  const useBloom = !/[?&]nobloom/.test(location.search);
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  const pr = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(pr);
  renderer.setClearColor(C.bg, 1);
  renderer.toneMapping = THREE.NoToneMapping;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const FRUSTUM = 12; // half-height in world units at zoom 1
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -300, 300);
  const AZ = THREE.MathUtils.degToRad(38);
  const EL = THREE.MathUtils.degToRad(31);
  const home = { target: new THREE.Vector3(-2, 0, 1), zoom: 1 };
  const dir = new THREE.Vector3(Math.sin(AZ) * Math.cos(EL), Math.sin(EL), Math.cos(AZ) * Math.cos(EL));
  camera.position.copy(home.target).addScaledVector(dir, 120);
  camera.lookAt(home.target);
  // background: a plane riding on the camera (the composer's clear would be sRGB-encoded twice)
  scene.add(camera);
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshBasicMaterial({ color: C.bg }));
  backdrop.position.z = -280;
  camera.add(backdrop);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(home.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minZoom = 0.12;
  controls.maxZoom = 6;
  controls.maxPolarAngle = Math.PI / 2 - 0.08;
  controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.update();

  // ---- post ---------------------------------------------------------------
  const size = () => ({ w: container.clientWidth || window.innerWidth, h: container.clientHeight || window.innerHeight });
  const { w: w0, h: h0 } = size();
  const target = new THREE.WebGLRenderTarget(w0 * pr, h0 * pr, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(w0, h0), 0.75, 0.5, 0.78);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  function resize() {
    const { w, h } = size();
    const aspect = w / h;
    camera.left = -FRUSTUM * aspect;
    camera.right = FRUSTUM * aspect;
    camera.top = FRUSTUM;
    camera.bottom = -FRUSTUM;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    bloom.setSize(w, h);
  }
  window.addEventListener('resize', resize);
  resize();

  /** Fit the given world-space box into the top `frac` of the viewport. */
  function fitHome(box3, { frac = 0.7, pad = 1.0 } = {}) {
    camera.updateMatrixWorld();
    const pts = [];
    for (let i = 0; i < 8; i++) pts.push(new THREE.Vector3(i & 1 ? box3.max.x : box3.min.x, i & 2 ? box3.max.y : box3.min.y, i & 4 ? box3.max.z : box3.min.z));
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    let mx = 0;
    let my = 0;
    const center = box3.getCenter(new THREE.Vector3());
    const cNdc = center.clone().project(camera);
    for (const p of pts) {
      p.project(camera);
      mx = Math.max(mx, Math.abs(p.x - cNdc.x));
      my = Math.max(my, Math.abs(p.y - cNdc.y));
    }
    home.zoom = Math.min(1 / (mx * pad), frac / (my * pad));
    // shift the target so the box centre sits in the upper part of the screen
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const shift = (1 - frac) * 0.5 * (FRUSTUM / home.zoom);
    home.target.copy(center).addScaledVector(up, -shift);
    goHome(true);
  }

  // ---- camera tweens ------------------------------------------------------
  let tween = null;
  function flyTo(targetPos, zoom, duration = 0.9) {
    tween = { from: controls.target.clone(), to: targetPos.clone(), z0: camera.zoom, z1: zoom, t: 0, d: duration };
  }
  function goHome(instant = false) {
    if (instant) {
      const offset = camera.position.clone().sub(controls.target);
      controls.target.copy(home.target);
      camera.position.copy(home.target).add(offset);
      camera.zoom = home.zoom;
      camera.updateProjectionMatrix();
      controls.update();
      return;
    }
    flyTo(home.target, home.zoom);
  }
  function focusOn(center, zoom = 2.6) {
    // keep the subject in the upper part of the screen, clear of the overlay panels
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const target = center.clone().addScaledVector(up, -0.15 * (FRUSTUM / zoom));
    flyTo(target, zoom);
  }
  controls.addEventListener('start', () => (tween = null));

  // ---- picking ------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const pickables = [];
  let hovered = null;
  let downAt = null;
  let lastClick = 0;
  const el = renderer.domElement;
  function pick(ev) {
    const r = el.getBoundingClientRect();
    pointer.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickables, false);
    for (const h of hits) {
      const part = h.object.userData.part;
      if (part) return part;
    }
    return null;
  }
  function setHover(part, ev) {
    if (hovered === part) {
      if (part) onHover?.(part, ev.clientX, ev.clientY);
      return;
    }
    if (hovered) hovered.solids.forEach((s) => (s.hover = 0));
    hovered = part;
    if (hovered) hovered.solids.forEach((s) => (s.hover = 0.55));
    el.style.cursor = part ? 'pointer' : '';
    onHover?.(part, ev?.clientX, ev?.clientY);
  }
  el.addEventListener('pointermove', (ev) => {
    if (downAt && Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 4) downAt = null;
    setHover(pick(ev), ev);
  });
  el.addEventListener('pointerleave', (ev) => setHover(null, ev));
  el.addEventListener('pointerdown', (ev) => (downAt = { x: ev.clientX, y: ev.clientY }));
  el.addEventListener('pointerup', (ev) => {
    if (!downAt) return;
    downAt = null;
    const part = pick(ev);
    const now = performance.now();
    if (now - lastClick < 320 && part) {
      focusOn(part.machine.center, part.machine.focusZoom || 2.6);
    } else onSelect?.(part);
    lastClick = now;
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' || (ev.key === '0' && !/input|textarea/i.test(document.activeElement?.tagName))) goHome();
  });

  // ---- loop ---------------------------------------------------------------
  const tickers = [];
  const timers = []; // { left, resolve } in animation seconds (already speed-scaled)
  let speed = 1;
  let last = performance.now();
  let frames = 0;
  let fpsAt = last;
  let running = true;
  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    let dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    frames++;
    if (now - fpsAt >= 500) {
      onFps?.(Math.round((frames * 1000) / (now - fpsAt)));
      frames = 0;
      fpsAt = now;
    }
    if (tween) {
      tween.t += dt;
      const u = Math.min(1, tween.t / tween.d);
      const e = 1 - Math.pow(1 - u, 3);
      const offset = camera.position.clone().sub(controls.target);
      controls.target.lerpVectors(tween.from, tween.to, e);
      camera.position.copy(controls.target).add(offset);
      camera.zoom = tween.z0 + (tween.z1 - tween.z0) * e;
      camera.updateProjectionMatrix();
      if (u >= 1) tween = null;
    }
    controls.update();
    dt *= speed;
    for (let i = timers.length - 1; i >= 0; i--) {
      timers[i].left -= dt;
      if (timers[i].left <= 0) timers.splice(i, 1)[0].resolve();
    }
    for (const t of tickers) t(dt, now / 1000);
    Solid.tickAll(dt);
    if (useBloom) composer.render();
    else renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) running = false;
    else if (!running) {
      running = true;
      last = performance.now();
      requestAnimationFrame(frame);
    }
  });

  return {
    scene,
    camera,
    renderer,
    controls,
    bloom,
    pickables,
    onTick: (fn) => tickers.push(fn),
    /** resolve after `seconds` of animation time (follows the speed control and the frame clock) */
    waitAnim: (seconds) => new Promise((resolve) => timers.push({ left: seconds, resolve })),
    setSpeed: (s) => (speed = s),
    fitHome,
    goHome,
    focusOn,
    registerPickable(solid) {
      solid.traverse((o) => {
        if (o.isMesh && o.userData.part) pickables.push(o);
      });
    },
  };
}
