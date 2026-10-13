// Сцена «от модели до детали»: пока листаешь, шестерня печатается слой за слоем (слои = scroll).
// 1) модель-каркас → 2) нарезка слайсером → 3) печать → 4) готово. Рисуем только пока блок на экране.
import * as THREE from '../vendor/three.module.js';
import { RoomEnvironment } from '../vendor/environments/RoomEnvironment.js';

const root = document.getElementById('story');
const canvas = document.getElementById('storyCanvas');
if (root && canvas) {
  if (!('IntersectionObserver' in window)) init();
  else {
    const io = new IntersectionObserver((en) => { if (en.some((e) => e.isIntersecting)) { io.disconnect(); init(); } }, { rootMargin: '900px 0px' });
    io.observe(root);
  }
}

function init() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lowEnd = coarse || innerWidth < 820 || (navigator.hardwareConcurrency || 8) <= 4 || (navigator.deviceMemory || 8) <= 4;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: !lowEnd, alpha: true, powerPreference: 'high-performance' });
  } catch { root.classList.add('story--static'); return; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, lowEnd ? 1.25 : 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const ACC = 0xff7a29;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(5, 9, 6); scene.add(key);
  const rim = new THREE.DirectionalLight(ACC, 2.4); rim.position.set(-6, 3, -5); scene.add(rim);

  // ── Шестерня ─────────────────────────────────────────────
  const TEETH = 12, R_OUT = 3.1, R_ROOT = 2.5;
  const shape = new THREE.Shape();
  for (let i = 0; i < TEETH; i++) {
    const a = (i / TEETH) * Math.PI * 2, st = (Math.PI * 2) / TEETH;
    const pts = [[a, R_ROOT], [a + st * 0.18, R_ROOT], [a + st * 0.3, R_OUT], [a + st * 0.55, R_OUT], [a + st * 0.67, R_ROOT]];
    pts.forEach(([t, r], k) => { const x = Math.cos(t) * r, y = Math.sin(t) * r; (i === 0 && k === 0) ? shape.moveTo(x, y) : shape.lineTo(x, y); });
  }
  shape.closePath();
  const hole = new THREE.Path(); hole.absarc(0, 0, 0.85, 0, Math.PI * 2, true); shape.holes.push(hole);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2, h = new THREE.Path(); h.absarc(Math.cos(a) * 1.7, Math.sin(a) * 1.7, 0.34, 0, Math.PI * 2, true); shape.holes.push(h);
  }
  const H = 1.5, N = lowEnd ? 26 : 44, T = H / N;
  const layerGeo = new THREE.ExtrudeGeometry(shape, { depth: T * 0.9, bevelEnabled: false, curveSegments: 8 });
  layerGeo.rotateX(-Math.PI / 2);                          // выдавливание вверх по Y
  const fullGeo = new THREE.ExtrudeGeometry(shape, { depth: H, bevelEnabled: false, curveSegments: 8 });
  fullGeo.rotateX(-Math.PI / 2);

  const gear = new THREE.Group(); scene.add(gear);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.1 });
  const layers = new THREE.InstancedMesh(layerGeo, mat, N);
  const m4 = new THREE.Matrix4();
  for (let i = 0; i < N; i++) { m4.makeTranslation(0, i * T, 0); layers.setMatrixAt(i, m4); layers.setColorAt(i, new THREE.Color(ACC)); }
  layers.count = 0; layers.frustumCulled = false; gear.add(layers);

  const ghost = new THREE.LineSegments(new THREE.EdgesGeometry(fullGeo, 25), new THREE.LineBasicMaterial({ color: 0xffa05c, transparent: true, opacity: 0.55 }));
  gear.add(ghost);
  const ghostFill = new THREE.Mesh(fullGeo, new THREE.MeshBasicMaterial({ color: ACC, transparent: true, opacity: 0.06, depthWrite: false }));
  gear.add(ghostFill);
  gear.position.y = -H / 2;

  // стол
  const bed = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 0.18, 64), new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.5, metalness: 0.3 }));
  bed.position.y = -H / 2 - 0.1; scene.add(bed);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.025, 8, 96), new THREE.MeshBasicMaterial({ color: ACC }));
  ring.rotation.x = Math.PI / 2; ring.position.y = -H / 2 - 0.01; scene.add(ring);

  // плоскость слайсера
  const scan = new THREE.Group();
  const scanDisc = new THREE.Mesh(new THREE.CircleGeometry(3.9, 64), new THREE.MeshBasicMaterial({ color: ACC, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
  scanDisc.rotation.x = -Math.PI / 2;
  const scanRing = new THREE.Mesh(new THREE.TorusGeometry(3.9, 0.02, 6, 96), new THREE.MeshBasicMaterial({ color: 0xffc38f }));
  scanRing.rotation.x = Math.PI / 2;
  scan.add(scanDisc, scanRing); scene.add(scan); scan.visible = false;

  // сопло
  const nozzle = new THREE.Group(); scene.add(nozzle);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.7, 20), new THREE.MeshStandardMaterial({ color: 0x2a2e34, roughness: 0.4, metalness: 0.6 }));
  body.position.y = 0.75;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.4, 20), new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.3, metalness: 0.9 }));
  cone.rotation.x = Math.PI; cone.position.y = 0.2;
  const gc = document.createElement('canvas'); gc.width = gc.height = 64;
  const gg = gc.getContext('2d'), gr = gg.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,230,200,1)'); gr.addColorStop(0.25, 'rgba(255,140,60,.8)'); gr.addColorStop(1, 'rgba(255,122,41,0)');
  gg.fillStyle = gr; gg.fillRect(0, 0, 64, 64);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(gc), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow.scale.setScalar(1.3);
  nozzle.add(body, cone, glow); nozzle.visible = false;

  // ── Размер ───────────────────────────────────────────────
  const resize = () => {
    const vw = Math.max(1, canvas.clientWidth), vh = Math.max(1, canvas.clientHeight);
    renderer.setSize(vw, vh, false);
    camera.aspect = vw / vh;
    camera.setViewOffset(vw, vh, vw > 900 ? -vw * 0.17 : 0, vw > 900 ? 0 : -vh * 0.12, vw, vh);   // деталь правее текста
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas); resize();

  // ── UI ───────────────────────────────────────────────────
  const steps = [...root.querySelectorAll('.story__step')];
  const dots = [...root.querySelectorAll('.story__dots i')];
  const hudLayer = root.querySelector('#storyLayer'), hudBar = root.querySelector('#storyBar');
  const BREAKS = [0, 0.1, 0.3, 0.86];
  let curStep = -1, lastLayer = -1;
  const setStep = (i) => {
    if (i === curStep) return; curStep = i;
    steps.forEach((s, k) => s.classList.toggle('is-on', k === i));
    dots.forEach((d, k) => d.classList.toggle('is-on', k <= i));
  };

  // ── Цикл ─────────────────────────────────────────────────
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const sm = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const hot = new THREE.Color(0xffd9b0), base = new THREE.Color(ACC), fin = new THREE.Color(0xff8a3d), c1 = new THREE.Color();
  let lastCol = '', target = 0, p = 0, visible = false, raf = 0, last = performance.now(), clock = 0;

  function frame(now) {
    raf = 0; if (!visible) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now; clock += dt;
    const r = root.getBoundingClientRect();
    target = clamp(-r.top / Math.max(1, r.height - innerHeight));
    p = reduce ? target : p + (target - p) * (1 - Math.exp(-dt * 8));

    const f = sm(0.3, 0.86, p), done = sm(0.86, 0.97, p);
    layers.count = Math.min(N, Math.floor(f * N + (f > 0 ? 1 : 0)));

    // цвет слоёв: чередование оттенков, верхний слой раскалён, в конце — единый цвет
    const colKey = `${layers.count}|${done.toFixed(2)}`;
    if (colKey !== lastCol) for (let i = 0; i < layers.count; i++) {
      c1.copy(base).multiplyScalar(i % 2 ? 0.86 : 1).lerp(fin, done);
      if (i === layers.count - 1 && done < 1) c1.lerp(hot, 0.85 * (1 - done));
      layers.setColorAt(i, c1);
    }
    if (colKey !== lastCol) { lastCol = colKey; if (layers.instanceColor) layers.instanceColor.needsUpdate = true; }
    mat.roughness = 0.55 - 0.3 * done; mat.metalness = 0.1 + 0.3 * done;

    ghost.material.opacity = 0.55 * (1 - done) * (1 - f * 0.5);
    ghostFill.material.opacity = 0.06 * (1 - f);

    // слайсер
    scan.visible = p > 0.1 && p < 0.3;
    scan.position.y = -H / 2 + sm(0.1, 0.3, p) * H;

    // сопло: обход по спирали, пока печатаем; в конце уезжает вверх
    const lift = sm(0.86, 0.95, p);
    nozzle.visible = p >= 0.3 && lift < 1;
    if (nozzle.visible) {
      const a = clock * 9 + layers.count * 1.3, rr = 1.6 + Math.sin(a * 0.6) * 1.2;
      nozzle.position.set(Math.cos(a) * rr, -H / 2 + layers.count * T + 0.05 + lift * 3, Math.sin(a) * rr);
      glow.material.opacity = 1 - lift; glow.scale.setScalar(1.1 + Math.sin(clock * 30) * 0.15);
    }

    gear.rotation.y = 0.4 + p * 3.2 + clock * 0.35 * done;
    const dist = 12.5 / Math.pow(clamp(camera.aspect, 0.6, 1.4), 0.55) - done * 1.8;
    const az = 0.5 + p * 1.2, el = 0.5 - done * 0.18 + Math.sin(p * 6) * 0.03;
    camera.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    camera.lookAt(0, 0, 0);

    let s = 0; BREAKS.forEach((b, i) => { if (p >= b) s = i; }); setStep(s);
    if (layers.count !== lastLayer) { lastLayer = layers.count; hudLayer.textContent = `${String(layers.count).padStart(2, '0')} / ${N}`; }
    hudBar.style.transform = `scaleX(${p.toFixed(3)})`;

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  const start = () => { if (!raf && visible && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  new IntersectionObserver((en) => { visible = en[0].isIntersecting; start(); }, { rootMargin: '10% 0px' }).observe(root);
  document.addEventListener('visibilitychange', start);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(raf); raf = 0; });
  canvas.addEventListener('webglcontextrestored', start);
  setStep(0);
}
