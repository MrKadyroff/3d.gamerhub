// Демо «печать вживую»: процедурный Bambu Lab P1S + AMS печатает табличку с твоим текстом (по умолчанию GAMERHUB).
// Печать идёт по таймеру, страницу не держит. Цена, вес и время — из настоящего калькулятора.
// Последовательность как у настоящего принтера: прогрев → калибровка стола → чистка сопла → линия очистки →
// слои с праймом-башней → смена цвета через AMS (стоп у мусорного жёлоба) → снятие модели.
import * as THREE from '../vendor/three.module.js';
import { RoomEnvironment } from '../vendor/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from '../vendor/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from '../vendor/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/postprocessing/OutputPass.js';
import { loadFont, build, unsupported, roundedRect } from './maker.js';
import { measure } from './viewer.js';
import { quote, fmtMoney, fmtTime } from './pricing.js';

const ACC = 0xff7a29;
const BAMBU_GREEN = '#00ae42';
// Реальные габариты P1S: 389 × 389 × 457 мм (см). Всё в сантиметрах.
const W = 38.9, D = 38.9, FEET = 0.6, BASE_H = 7.0, FLOOR = FEET + BASE_H, TOP = 46.0, BED_Y = 9.4;
const DUR = 22;                 // секунд на всю «печать» (таймлапс)
const T_WARM = 0.05, T_LEVEL = 0.13, T_CHUTE = 0.17, T_PURGE = 0.2, T_PRINT = 0.86, T_FINISH = 0.88, CC_W = 0.06;
const CHUTE_X = -15.2, HOME_X = -15.2, PARK_X = -13;
const LEVEL = [[-9, -4], [0, -4], [9, -4], [9, 0], [0, 0], [-9, 0], [-9, 4], [0, 4], [9, 4]].map(([x, z]) => ({ x, z }));
const PURGE_Z = 4.2, PURGE_X0 = -10.5, PURGE_X1 = 3;
const SPOOL_DEFAULT = [0xff7a29, 0xf1ece2, 0x2fc7e6, 0x3a3f46];
const SWATCHES = [
  { hex: 0xff7a29, name: 'Оранжевый' }, { hex: 0xf1ece2, name: 'Белый' }, { hex: 0x2fc7e6, name: 'Голубой' },
  { hex: 0x51cf66, name: 'Зелёный' }, { hex: 0xe5484d, name: 'Красный' }, { hex: 0xffd43b, name: 'Жёлтый' },
  { hex: 0x9775fa, name: 'Фиолетовый' }, { hex: 0x30353c, name: 'Графит' },
];
const MAX_W = 200;             // мм

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => t * t * (3 - 2 * t);
const smooth = (a, b, x) => ease(clamp((x - a) / (b - a)));
const seg = (x, a, b) => clamp((x - a) / (b - a));
const hexStr = (h) => '#' + h.toString(16).padStart(6, '0');

function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.userData = { ctx: g, w, h };
  return t;
}
function glowTexture() {
  return canvasTex(64, 64, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,190,120,1)');
    gr.addColorStop(0.25, 'rgba(255,122,41,.55)');
    gr.addColorStop(1, 'rgba(255,122,41,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });
}

// ── Пути печати ──────────────────────────────────────────────
function makePath(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, len: cum[cum.length - 1] || 1e-6 };
}
function samplePath(p, u, out) {
  const d = clamp(u) * p.len;
  let lo = 0, hi = p.cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p.cum[mid] <= d) lo = mid; else hi = mid; }
  const span = p.cum[hi] - p.cum[lo] || 1e-6, k = clamp((d - p.cum[lo]) / span);
  out.x = lerp(p.pts[lo][0], p.pts[hi][0], k); out.z = lerp(p.pts[lo][1], p.pts[hi][1], k);
  return out;
}
function rrPoints(hw, hd, r) {
  const pts = [];
  const corner = (cx, cz, a0) => { for (let i = 0; i <= 6; i++) { const a = a0 + (i / 6) * Math.PI / 2; pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); } };
  corner(hw - r, hd - r, 0); corner(-hw + r, hd - r, Math.PI / 2); corner(-hw + r, -hd + r, Math.PI); corner(hw - r, -hd + r, Math.PI * 1.5);
  pts.push(pts[0]);
  return pts;
}
function zigzag(hw, hd, step) {
  const pts = []; let dir = 1;
  for (let z = -hd; z <= hd + 1e-6; z += step) { pts.push([-hw * dir, z], [hw * dir, z]); dir = -dir; }
  return pts;
}

/** Табличка из текста: подложка + выпуклые буквы. Геометрия в см, пути для сопла — тоже. */
function makeSign(font, text) {
  const LET_T = 9, PLATE_T = 3;
  const mk = (hgt) => build({ font, text, style: 'letters', height: hgt, thickness: LET_T, plateMargin: 0, curveSegments: 14, bevelSegments: 4 });
  let height = 20, r = mk(height);
  if (r.size.x > MAX_W) { height = (height * MAX_W) / r.size.x; r = mk(height); }
  const margin = Math.max(3, height * 0.28);
  const L = r.geometry;
  L.translate(0, PLATE_T, 0);
  const pw = r.size.x + margin * 2, pd = r.size.z + margin * 2;
  const P = new THREE.ExtrudeGeometry(roundedRect(pw, pd, Math.min(margin * 0.9, 6)), { depth: PLATE_T, bevelEnabled: false });
  P.rotateX(-Math.PI / 2);
  P.computeVertexNormals();
  const flat = [P, L].map((g) => (g.index ? g.toNonIndexed() : g).attributes.position.array);
  const merged = new THREE.BufferGeometry();
  const buf = new Float32Array(flat[0].length + flat[1].length);
  buf.set(flat[0], 0); buf.set(flat[1], flat[0].length);
  merged.setAttribute('position', new THREE.BufferAttribute(buf, 3));
  const m = measure(merged);
  P.scale(0.1, 0.1, 0.1); L.scale(0.1, 0.1, 0.1);

  // Контуры букв — по ним «едет» сопло на слоях букв.
  const shapes = font.generateShapes(text, height);
  const ext = shapes.map((s) => s.extractPoints(6));
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  ext.forEach((e) => e.shape.forEach((p) => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const conv = (ring) => ring.map((p) => [(p.x - cx) * 0.1, -(p.y - cy) * 0.1]);
  const letterPts = [];
  const addRing = (ring) => {
    const pts = conv(ring);
    if (pts.length < 3) return;
    let ax = 0, az = 0; pts.forEach(([x, z]) => { ax += x; az += z; }); ax /= pts.length; az /= pts.length;
    letterPts.push(...pts, pts[0]);
    letterPts.push(...pts.map(([x, z]) => [ax + (x - ax) * 0.74, az + (z - az) * 0.74]));
  };
  ext.forEach((e) => { addRing(e.shape); e.holes.forEach(addRing); });
  const hw = pw / 20, hd = pd / 20;
  const rr = Math.min(margin * 0.9, 6) / 10;
  const platePts = [...rrPoints(hw - 0.12, hd - 0.12, rr), ...zigzag(hw - 0.3, hd - 0.3, 0.45)];
  // прайм-башня — за табличкой
  const tower = { x: Math.min(hw * 0.5, 6), z: -(hd + 1.5), hw: 1.9, hd: 0.6 };
  const towerPts = [...rrPoints(tower.hw, tower.hd, 0.15).map(([x, z]) => [x + tower.x, z + tower.z]),
    ...zigzag(tower.hw - 0.2, tower.hd - 0.2, 0.4).map(([x, z]) => [x + tower.x, z + tower.z])];

  return {
    plate: P, letters: L, height: Math.round(height),
    H: (PLATE_T + LET_T) / 10, plateT: PLATE_T / 10,
    layers: Math.round((PLATE_T + LET_T) * 5), plateLayers: Math.round(PLATE_T * 5),
    halfW: hw, halfD: hd, tower,
    paths: { plate: makePath(platePts), letters: makePath(letterPts.length > 3 ? letterPts : platePts), tower: makePath(towerPts) },
    volumeCm3: m.volumeMm3 / 1000, areaCm2: m.areaMm2 / 100, sizeMm: { x: pw, z: pd, y: PLATE_T + LET_T },
  };
}

function initScene(canvas, stage, root) {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dprCap = coarse ? 2 : 2.5;
  renderer.setPixelRatio(Math.min(devicePixelRatio, dprCap));
  renderer.localClippingEnabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 600);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.5;
  // фон рисуем сами (bloom плохо дружит с прозрачным холстом)
  scene.background = canvasTex(512, 512, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h * 0.62, 0, w / 2, h * 0.62, w * 0.75);
    gr.addColorStop(0, '#231710'); gr.addColorStop(0.5, '#14161a'); gr.addColorStop(1, '#0c0d10');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  });

  // ── Свет ──────────────────────────────────────────────────
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(40, 80, 60); scene.add(key);
  const rim = new THREE.DirectionalLight(ACC, 2.2);
  rim.position.set(-60, 30, -50); scene.add(rim);
  const chamber = new THREE.PointLight(0xfff0dc, 120, 0, 2);
  chamber.position.set(0, TOP - 4, 4); scene.add(chamber);
  // светодиод камеры — отбрасывает мягкие тени от головы и детали на стол
  const spot = new THREE.SpotLight(0xfff1de, 950, 0, 0.95, 0.7, 2);
  spot.position.set(0, TOP - 3.2, 5); spot.target.position.set(0, BED_Y, 0);
  spot.castShadow = true;
  spot.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
  spot.shadow.bias = -0.0004; spot.shadow.normalBias = 0.04; spot.shadow.radius = 4;
  scene.add(spot, spot.target);

  // ── Материалы ─────────────────────────────────────────────
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const phys = (o) => new THREE.MeshPhysicalMaterial(o);
  const mBlack = phys({ color: 0x15171a, roughness: 0.45, metalness: 0.1, clearcoat: 0.6, clearcoatRoughness: 0.3 });
  const mGrey = phys({ color: 0x2a2e34, roughness: 0.45, metalness: 0.35, clearcoat: 0.4, clearcoatRoughness: 0.35 });
  const mAlu = std({ color: 0xb7bec7, roughness: 0.33, metalness: 0.95 });
  const mGold = std({ color: 0xd9a441, roughness: 0.3, metalness: 0.95 });
  const cfTex = canvasTex(64, 64, (g, w, h) => {
    g.fillStyle = '#101113'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#1d1f23'; g.lineWidth = 4;
    for (let i = -h; i < w + h; i += 8) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + h, h); g.stroke(); }
  });
  cfTex.wrapS = cfTex.wrapT = THREE.RepeatWrapping; cfTex.repeat.set(10, 1);
  const mCF = std({ map: cfTex, roughness: 0.3, metalness: 0.5 });
  const mSmoke = new THREE.MeshStandardMaterial({ color: 0x090c10, roughness: 0.08, transparent: true, opacity: 0.26, depthWrite: false });
  const mSmokeSide = new THREE.MeshStandardMaterial({ color: 0x090c10, roughness: 0.1, transparent: true, opacity: 0.4, depthWrite: false });
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x4a535e, transparent: true, opacity: 0.55 });

  const box = (w, h, d, m, x, y, z, parent, sharp = false) => {
    const rad = Math.min(0.16, Math.min(w, h, d) * 0.3);
    const mesh = new THREE.Mesh(sharp ? new THREE.BoxGeometry(w, h, d) : new RoundedBoxGeometry(w, h, d, 3, rad), m);
    mesh.position.set(x, y, z);
    (parent || scene).add(mesh);
    return mesh;
  };
  /** Бокс со скруглёнными вертикальными рёбрами (корпус P1S). */
  const rbox = (w, h, d, r, m, x, y, z, parent) => {
    const g = new THREE.ExtrudeGeometry(roundedRect(w, d, r), { depth: h, bevelEnabled: false, curveSegments: 5 });
    g.rotateX(-Math.PI / 2); g.translate(0, -h / 2, 0); g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z);
    (parent || scene).add(mesh); return mesh;
  };
  const glass = (w, h, d, x, y, z, parent, m = mSmoke) => {
    const mesh = box(w, h, d, m, x, y, z, parent, true);
    mesh.renderOrder = 5;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMat));
    return mesh;
  };
  const cyl = (rt, rb, h, m, x, y, z, parent, seg2 = 40) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg2), m);
    mesh.position.set(x, y, z); (parent || scene).add(mesh); return mesh;
  };

  // ── Пол ───────────────────────────────────────────────────
  const floorTex = canvasTex(1024, 1024, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,122,41,.22)');
    gr.addColorStop(0.45, 'rgba(255,122,41,.05)');
    gr.addColorStop(1, 'rgba(255,122,41,0)');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.strokeStyle = 'rgba(255,122,41,.16)'; g.lineWidth = 2;
    for (const r of [150, 230, 320, 420]) { g.beginPath(); g.arc(w / 2, h / 2, r, 0, 7); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1;
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      g.beginPath(); g.moveTo(w / 2 + Math.cos(a) * 150, h / 2 + Math.sin(a) * 150);
      g.lineTo(w / 2 + Math.cos(a) * 420, h / 2 + Math.sin(a) * 420); g.stroke();
    }
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(170, 170), new THREE.MeshBasicMaterial({ map: floorTex, transparent: true, depthWrite: false }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -0.05; scene.add(floor);
  const pulse = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 96),
    new THREE.MeshBasicMaterial({ color: ACC, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  pulse.rotation.x = -Math.PI / 2; scene.add(pulse);

  // ── Корпус P1S ────────────────────────────────────────────
  const printer = new THREE.Group(); scene.add(printer);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) cyl(0.9, 1.1, FEET, mBlack, sx * (W / 2 - 2.6), FEET / 2, sz * (D / 2 - 2.6), printer, 14);
  rbox(W, BASE_H, D, 1.6, mBlack, 0, FEET + BASE_H / 2, 0, printer);
  // фаска-карниз над основанием
  box(W - 0.6, 0.35, D - 0.6, mGrey, 0, FLOOR + 0.17, 0, printer);

  // логотип на лицевой панели
  const label = canvasTex(512, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#e9edf0'; g.textBaseline = 'middle';
    g.font = '700 46px "Space Grotesk",sans-serif'; g.fillText('BAMBU LAB', 6, h / 2);
    g.fillStyle = '#9aa3ad'; g.fillRect(292, 30, 3, 68);
    g.font = '700 54px "Space Grotesk",sans-serif'; g.fillStyle = '#e9edf0'; g.fillText('P1S', 316, h / 2 + 2);
  });
  const lab = new THREE.Mesh(new THREE.PlaneGeometry(10.5, 2.6), new THREE.MeshBasicMaterial({ map: label, transparent: true }));
  lab.position.set(-W / 2 + 8.2, FEET + 3.6, D / 2 + 0.03); printer.add(lab);

  // тачскрин 2.7" справа, с наклоном к пользователю
  const screenG = new THREE.Group(); screenG.position.set(W / 2 - 8.6, FEET + 3.7, D / 2 + 0.5); screenG.rotation.x = -0.3; printer.add(screenG);
  box(7.6, 4.8, 0.9, mBlack, 0, 0, 0, screenG);
  const screenTex = canvasTex(320, 192, () => {});
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 3.96), new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false }));
  screen.position.z = 0.46; screenG.add(screen);
  let screenKey = '';
  function drawScreen(P, st, nozzle, bed, pct, layer, total, name) {
    const key2 = `${st}|${nozzle}|${bed}|${pct}|${layer}|${name}`;
    if (key2 === screenKey) return; screenKey = key2;
    const { ctx: g, w, h } = screenTex.userData;
    g.fillStyle = '#16181b'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#1f2327'; g.fillRect(0, 0, w, 26);
    g.fillStyle = '#c9d1d9'; g.font = '600 15px "JetBrains Mono",monospace'; g.textBaseline = 'middle';
    g.fillText('12:30', 10, 13); g.textAlign = 'right'; g.fillText('Wi-Fi ▮▮▮', w - 10, 13); g.textAlign = 'left';
    g.fillStyle = '#242a2f'; g.beginPath(); g.roundRect(10, 38, w - 20, 100, 8); g.fill();
    g.fillStyle = '#e8edf1'; g.font = '700 17px "Space Grotesk",sans-serif'; g.fillText(name.slice(0, 18) + '.3mf', 22, 58);
    g.fillStyle = BAMBU_GREEN; g.font = '600 14px "JetBrains Mono",monospace'; g.fillText(st, 22, 80);
    g.fillStyle = '#39414a'; g.beginPath(); g.roundRect(22, 98, w - 44, 12, 6); g.fill();
    g.fillStyle = BAMBU_GREEN; g.beginPath(); g.roundRect(22, 98, Math.max(12, (w - 44) * pct / 100), 12, 6); g.fill();
    g.fillStyle = '#c9d1d9'; g.font = '600 13px "JetBrains Mono",monospace'; g.fillText(`${pct}%   ${layer}/${total}`, 22, 124);
    g.fillStyle = '#9aa3ad'; g.fillText(`Nozzle ${nozzle}°C   Bed ${bed}°C`, 10, 164);
    g.fillStyle = BAMBU_GREEN; g.fillRect(0, h - 6, w, 6);
    screenTex.needsUpdate = true;
  }

  // каркас и стёкла
  const inner = TOP - FLOOR;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) rbox(1.9, inner, 1.9, 0.5, mBlack, sx * (W / 2 - 0.95), FLOOR + inner / 2, sz * (D / 2 - 0.95), printer);
  for (const sz of [-1, 1]) box(W - 0.4, 1.3, 1.9, mBlack, 0, TOP - 0.65, sz * (D / 2 - 0.95), printer);
  for (const sx of [-1, 1]) box(1.9, 1.3, D - 3.8, mBlack, sx * (W / 2 - 0.95), TOP - 0.65, 0, printer);
  const gy0 = FLOOR + 1.3, gy1 = TOP - 1.5, gh = gy1 - gy0, gmid = (gy0 + gy1) / 2;
  box(W - 3.8, gh, 0.5, mBlack, 0, gmid, -(D / 2 - 1.1), printer);                // задняя стенка
  for (let i = 0; i < 4; i++) box(W - 9, 0.22, 0.12, mGrey, 0, gmid - 6 + i * 3.4, -(D / 2 - 1.4), printer);  // вентрешётка
  glass(W - 3.8, gh, 0.3, 0, gmid, D / 2 - 0.8, printer);                         // дверь
  box(W - 3.6, 0.7, 0.6, mBlack, 0, gy1 + 0.1, D / 2 - 0.8, printer);
  box(W - 3.6, 0.7, 0.6, mBlack, 0, gy0 - 0.1, D / 2 - 0.8, printer);
  box(6, 0.55, 1.1, mBlack, 0, gy1 - 0.5, D / 2 - 0.1, printer);                  // ручка двери
  for (const sx of [-1, 1]) glass(0.3, gh, D - 3.8, sx * (W / 2 - 0.8), gmid, 0, printer, mSmokeSide);
  glass(W - 3.8, 0.4, D - 3.8, 0, TOP - 1.1, 0, printer);                         // стеклянная крышка
  const led = new THREE.Mesh(new THREE.BoxGeometry(W - 10, 0.25, 0.8), new THREE.MeshBasicMaterial({ color: 0xfff2e0 }));
  led.position.set(0, TOP - 1.9, D / 2 - 3.4); printer.add(led);

  // ── Ось Z: направляющие, ходовые винты, портал ────────────
  const ROD_X = 16.7, ROD_Z = -13, RAIL_Z = -5.6;
  const screwTex = canvasTex(8, 64, (g, w, h) => { g.fillStyle = '#9aa3ad'; g.fillRect(0, 0, w, h); g.fillStyle = '#4c535b'; for (let y = 0; y < h; y += 8) g.fillRect(0, y, w, 3); });
  screwTex.wrapS = screwTex.wrapT = THREE.RepeatWrapping; screwTex.repeat.set(1, 40);
  for (const sx of [-1, 1]) {
    cyl(0.4, 0.4, inner - 1.4, mAlu, sx * ROD_X, FLOOR + inner / 2 - 0.2, ROD_Z, printer);
    cyl(0.5, 0.5, inner - 1.4, std({ map: screwTex, roughness: 0.4, metalness: 0.8 }), sx * 14.6, FLOOR + inner / 2 - 0.2, ROD_Z, printer);
  }
  const rail = new THREE.Group(); scene.add(rail);
  for (const sx of [-1, 1]) {
    box(2.6, 5.4, 3.4, mBlack, sx * ROD_X, 0, ROD_Z, rail);
    box(2.2, 2.0, 7.8, mBlack, sx * ROD_X, 0, (ROD_Z + RAIL_Z) / 2 - 0.2, rail);
  }
  for (const dy of [-1.15, 1.15]) {
    const rod = cyl(0.5, 0.5, 2 * ROD_X - 1.2, mCF, 0, dy, RAIL_Z, rail, 16); rod.rotation.z = Math.PI / 2;
  }

  // ── Голова ────────────────────────────────────────────────
  const head = new THREE.Group(); scene.add(head);
  cyl(0.12, 0.55, 1.0, mGold, 0, 0.5, 0, head, 16);                       // сопло
  box(1.3, 0.9, 1.3, mGold, 0, 1.4, 0, head);                             // нагреватель
  for (let i = 0; i < 5; i++) box(2.6, 0.14, 2.6, mAlu, 0, 2.2 + i * 0.26, 0, head); // радиатор
  box(5.4, 3.6, 4.6, mGrey, 0, 5.0, -1.4, head);                          // корпус
  box(6.4, 2.3, 2.4, mBlack, 0, 2.9, 1.5, head);                          // воздуховод обдува
  box(3.8, 0.9, 0.3, std({ color: 0x050607, roughness: 0.9 }), 0, 2.6, 2.75, head);
  box(5.0, 4.6, 1.0, mBlack, 0, 4.7, -4.4, head);                         // задняя планка
  cyl(1.65, 1.65, 0.7, mBlack, -3.0, 4.9, -1.4, head, 24).rotation.z = Math.PI / 2;   // боковой вентилятор
  cyl(1.7, 1.7, 2.6, mGrey, 0.5, 7.9, -2.2, head, 28);                    // мотор экструдера
  box(1.0, 1.0, 1.0, mBlack, 1.7, 7.5, -4.2, head);
  const glowTex = glowTexture();
  const tipGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  tipGlow.position.set(0, 0.2, 0.2); head.add(tipGlow);
  const nozzleLight = new THREE.PointLight(ACC, 0, 0, 2);
  nozzleLight.position.set(0, -0.2, 0.9); head.add(nozzleLight);

  // ── Мусорный жёлоб и чистка сопла (слева от стола) ────────
  box(3.6, 2.4, 5.2, mBlack, CHUTE_X - 0.2, BED_Y - 1.0, 0, scene);
  box(2.4, 0.2, 3.6, std({ color: 0x050607, roughness: 0.9 }), CHUTE_X - 0.2, BED_Y + 0.22, 0, scene);
  const wiper = box(1.8, 0.35, 0.5, mAlu, CHUTE_X - 0.2, BED_Y + 0.35, 1.6, scene);
  const noodle = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1, 8), std({ color: ACC, roughness: 0.4 }));
  noodle.visible = false; scene.add(noodle);

  // ── Стол: каретка, алюм. плита, текстурированный PEI ─────
  const bed = new THREE.Group(); bed.position.y = BED_Y; scene.add(bed);
  rbox(27, 0.9, 27.5, 0.6, mBlack, 0, -1.35, 0, bed);
  box(25.9, 0.5, 25.9, mAlu, 0, -0.65, 0, bed);
  box(25.6, 0.3, 25.6, mGrey, 0, -0.15, 0, bed);
  const plateTex = canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = '#1f2328'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 90000; i++) {
      const v = 26 + Math.random() * 42;
      g.fillStyle = `rgb(${v},${v + 3},${v + 8})`; g.fillRect(Math.random() * w, Math.random() * h, 1.4, 1.4);
    }
    for (let i = 0; i < 3200; i++) { g.fillStyle = 'rgba(200,170,110,.32)'; g.fillRect(Math.random() * w, Math.random() * h, 1.1, 1.1); }
  });
  plateTex.anisotropy = maxAniso;
  const pei = new THREE.Mesh(new THREE.PlaneGeometry(25.6, 25.6), std({ map: plateTex, roughness: 0.55, metalness: 0.4 }));
  pei.rotation.x = -Math.PI / 2; pei.position.y = 0.01; bed.add(pei);
  const bedEdgeMat = new THREE.LineBasicMaterial({ color: 0xff5a1a, transparent: true, opacity: 0 });
  const bedEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(25.9, 0.5, 25.9)), bedEdgeMat);
  bedEdge.position.y = -0.65; bed.add(bedEdge);
  // линия очистки на столе
  const purgeMat = std({ color: 0xf1ece2, roughness: 0.45 });
  const purgeGeo = new THREE.BoxGeometry(1, 0.1, 0.36); purgeGeo.translate(0.5, 0, 0);
  const purgeLine = new THREE.Mesh(purgeGeo, purgeMat); purgeLine.position.set(PURGE_X0, 0.06, PURGE_Z); purgeLine.scale.x = 0.001; bed.add(purgeLine);

  // ── Деталь ────────────────────────────────────────────────
  const stripe = canvasTex(4, 64, (g, w, h) => {
    for (let y = 0; y < h; y++) { const v = Math.round(128 + 127 * Math.sin((y / h) * Math.PI * 2)); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, y, w, 1); }
  }, false);
  stripe.wrapS = stripe.wrapT = THREE.RepeatWrapping;
  const clipTop = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  const clipBot = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const partMat = () => phys({ color: 0xffffff, roughness: 0.38, metalness: 0.02, clearcoat: 0.35, clearcoatRoughness: 0.4, side: THREE.DoubleSide, clippingPlanes: [clipTop] });
  const plateMat = partMat(), letterMat = partMat();
  const hotMat = new THREE.MeshBasicMaterial({ color: 0xffb066, side: THREE.DoubleSide, clippingPlanes: [clipTop, clipBot], toneMapped: false });
  const part = new THREE.Group(); part.position.y = 0.02; bed.add(part);
  const towerLow = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), plateMat), towerHigh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), letterMat);
  towerLow.frustumCulled = towerHigh.frustumCulled = false; bed.add(towerLow, towerHigh);
  let sign = null, info = { grams: 0, minutes: 60 };
  const curCols = [new THREE.Color(0xf1ece2), new THREE.Color(ACC)];
  const hotMeshes = [];

  // ── AMS на крышке ─────────────────────────────────────────
  const ams = new THREE.Group(); ams.position.y = TOP; printer.add(ams);
  const AW = 36.5, AD = 30, AH = 22;
  const mAmsDark = std({ color: 0x17191c, roughness: 0.55, metalness: 0.15 });
  box(AW + 1.5, 1.2, AD + 1, mAmsDark, 0, 0.6, 0, ams);
  box(AW, AH, 0.6, mAmsDark, 0, 1.2 + AH / 2, -AD / 2 + 0.3, ams);
  box(AW + 1, 1, AD, mAmsDark, 0, 1.2 + AH + 0.5, 0, ams);
  const mGlass2 = new THREE.MeshStandardMaterial({ color: 0x10151a, roughness: 0.1, transparent: true, opacity: 0.16, depthWrite: false });
  glass(AW, AH, 0.2, 0, 1.2 + AH / 2, AD / 2 - 0.1, ams, mGlass2);
  for (const sx of [-1, 1]) glass(0.2, AH, AD, sx * (AW / 2 - 0.1), 1.2 + AH / 2, 0, ams, mGlass2);
  box(AW - 6, 0.3, 0.2, std({ color: ACC, roughness: 0.45, emissive: ACC, emissiveIntensity: 0.3 }), 0, 1.0, AD / 2 + 0.55, ams);
  const spools = [], leds = [], spoolMats = [], spoolAng = [0, 0, 0, 0];
  const SPY = 1.2 + 10.6;
  for (let k = 0; k < 4; k++) {
    const x = -13.2 + k * 8.8;
    const orient = new THREE.Group(); orient.position.set(x, SPY, -1); orient.rotation.z = Math.PI / 2; ams.add(orient);
    const spin = new THREE.Group(); orient.add(spin);
    const wound = std({ color: SPOOL_DEFAULT[k], roughness: 0.55, metalness: 0.05, bumpMap: stripe, bumpScale: 0.8 });
    spoolMats.push(wound);
    spin.add(new THREE.Mesh(new THREE.CylinderGeometry(8.4, 8.4, 6.2, 48), wound));
    cyl(3.2, 3.2, 6.8, std({ color: 0x23272d, roughness: 0.6 }), 0, 0, 0, spin, 24);
    for (const s of [-1, 1]) {
      const fl = new THREE.Mesh(new THREE.CylinderGeometry(9.6, 9.6, 0.25, 48),
        new THREE.MeshStandardMaterial({ color: 0xdfe6ec, roughness: 0.2, transparent: true, opacity: 0.32, depthWrite: false }));
      fl.position.y = s * 3.3; spin.add(fl);
    }
    for (let sp = 0; sp < 3; sp++) { const b = box(1.3, 0.3, 9.2, mAmsDark, 0, 3.3, 0, spin); b.rotation.y = (sp / 3) * Math.PI; }
    spools.push(spin);
    const l = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.3, 0.2), new THREE.MeshBasicMaterial({ color: 0x2a2f35 }));
    l.position.set(x, 2.2, AD / 2 + 0.3); ams.add(l); leds.push(l);
  }

  // ── Трубка AMS → голова и шлейф головы ────────────────────
  const tubeMat = std({ color: ACC, roughness: 0.35, metalness: 0.1, emissive: ACC, emissiveIntensity: 0.18 });
  const tube = new THREE.Mesh(new THREE.BufferGeometry(), tubeMat); tube.frustumCulled = false; scene.add(tube);
  const cable = new THREE.Mesh(new THREE.BufferGeometry(), std({ color: 0x0c0d0f, roughness: 0.7 })); cable.frustumCulled = false; scene.add(cable);
  let tubeKey = '';
  function updateTube() {
    const hp = head.position, ry = rail.position.y;
    const k2 = hp.x.toFixed(2) + hp.y.toFixed(2);
    if (k2 === tubeKey) return; tubeKey = k2;
    const a = new THREE.Vector3(0, TOP + 3.2, -AD / 2 - 0.4);
    const e = new THREE.Vector3(hp.x + 1.7, hp.y + 9.6, -2.2);
    const c1 = new THREE.CatmullRomCurve3([a, new THREE.Vector3(a.x, TOP + 0.2, -D / 2 + 3),
      new THREE.Vector3(lerp(a.x, e.x, 0.4), lerp(TOP, e.y, 0.55) + 1, -D / 2 + 6),
      new THREE.Vector3(lerp(a.x, e.x, 0.85), e.y + 2.6, -5), e], false, 'catmullrom', 0.5);
    tube.geometry.dispose(); tube.geometry = new THREE.TubeGeometry(c1, 36, 0.24, 6, false);
    const s = new THREE.Vector3(hp.x + 1.2, hp.y + 6.2, -5.4);
    const c2 = new THREE.CatmullRomCurve3([s, new THREE.Vector3(lerp(hp.x, ROD_X, 0.5), ry + 3.2, RAIL_Z - 0.6),
      new THREE.Vector3(ROD_X - 0.4, ry + 3.0, RAIL_Z - 3), new THREE.Vector3(ROD_X, ry + 2.9, ROD_Z)], false, 'catmullrom', 0.5);
    cable.geometry.dispose(); cable.geometry = new THREE.TubeGeometry(c2, 24, 0.42, 6, false);
  }

  // ── Пылинки и след сопла ──────────────────────────────────
  const PN = matchMedia('(max-width: 820px)').matches ? 50 : 110;
  const pp = new Float32Array(PN * 3), pv = new Float32Array(PN);
  for (let i = 0; i < PN; i++) {
    pp[i * 3] = (Math.random() - 0.5) * 100; pp[i * 3 + 1] = Math.random() * 80; pp[i * 3 + 2] = (Math.random() - 0.5) * 80;
    pv[i] = 0.6 + Math.random() * 1.6;
  }
  const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  scene.add(new THREE.Points(pg, new THREE.PointsMaterial({ map: glowTex, size: 2.2, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffa060 })));
  const TN = coarse ? 160 : 320;
  const tp = new Float32Array(TN * 3), tc = new Float32Array(TN * 3), tAge = new Float32Array(TN).fill(9); let tHead = 0;
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(tp, 3)); tg.setAttribute('color', new THREE.BufferAttribute(tc, 3));
  const trail = new THREE.Points(tg, new THREE.PointsMaterial({ map: glowTex, size: 0.9, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  trail.frustumCulled = false; bed.add(trail);

  const shade = (obj, cast, recv) => obj.traverse((o) => { if (o.isMesh && !o.material.transparent) { o.castShadow = cast; o.receiveShadow = recv; } });
  shade(head, true, true); shade(rail, true, true); shade(bed, false, true); shade(towerLow, true, true); shade(towerHigh, true, true);
  shade(printer, false, true);
  bed.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });

  // ── Оверлей ───────────────────────────────────────────────
  const $ = (s) => root.querySelector(s);
  const hud = {
    state: $('#hudState'), layer: $('#hudLayer'), height: $('#hudHeight'), nozzle: $('#hudNozzle'),
    bed: $('#hudBed'), fil: $('#hudFil'), eta: $('#hudEta'), bar: $('#buildBar'), pct: $('#hudPct'),
  };
  const cache = {};
  const setTxt = (k, v) => { if (cache[k] !== v) { cache[k] = v; hud[k].textContent = v; } };

  // ── Камера и размер ───────────────────────────────────────
  let vw = 1, vh = 1, aspect = 1;
  const vf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const fit = (needH, needW) => Math.max(needH / 2 / vf, needW / 2 / (vf * aspect));
  function resize() {
    vw = Math.max(1, stage.clientWidth); vh = Math.max(1, stage.clientHeight);
    aspect = vw / vh;
    renderer.setSize(vw, vh, false);
    if (typeof composer !== 'undefined') composer.setSize(vw, vh);
    camera.aspect = aspect; camera.updateProjectionMatrix();
  }
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: 4 }));
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(2, 2), 0.28, 0.6, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  new ResizeObserver(resize).observe(stage);
  resize();

  // ── Хореография принтера ──────────────────────────────────
  const tmp = { x: 0, z: 0 }, tmp2 = { x: 0, z: 0 };
  /** Положение сопла на столе (в координатах стола) для доли печати f ∈ [0,1]. */
  function layerPos(f, out) {
    const L = sign.layers, fl = clamp(f) * L, li = Math.min(L - 1, Math.floor(fl)), s = clamp(fl - li);
    if (s < 0.1) samplePath(sign.paths.tower, s / 0.1, out);
    else samplePath(li < sign.plateLayers ? sign.paths.plate : sign.paths.letters, (s - 0.1) / 0.9, out);
    return out;
  }
  const S = { x: HOME_X, z: 0, tip: BED_Y + 7, f: 0, extrude: false, purge: 0, noodle: 0, noodleCol: 0, act: 0, spoolDir: 0, spoolDir2: 0, phase: 'warm' };
  function choreo(P) {
    Object.assign(S, { x: HOME_X, z: 0, tip: BED_Y + 7, f: 0, extrude: false, purge: 0, noodle: 0, noodleCol: 0, act: 0, spoolDir: 0, spoolDir2: 0, phase: 'warm' });
    if (P < T_WARM) { S.x = lerp(HOME_X, -9, ease(seg(P, 0, T_WARM))); return S; }
    if (P < T_LEVEL) {                                                  // калибровка стола: касание 9 точек
      S.phase = 'level';
      const u = seg(P, T_WARM, T_LEVEL) * 9, i = Math.min(8, Math.floor(u)), k = u - i;
      const to = LEVEL[i], from = i ? LEVEL[i - 1] : { x: -9, z: 0 };
      const mv = ease(clamp(k / 0.6));
      S.x = lerp(from.x, to.x, mv); S.z = lerp(from.z, to.z, mv);
      const base = i === 0 ? lerp(7, 1.5, mv) : 1.5;
      S.tip = BED_Y + base - (k > 0.6 ? Math.sin(((k - 0.6) / 0.4) * Math.PI) * 1.3 : 0);
      return S;
    }
    if (P < T_CHUTE) {                                                  // чистка сопла у жёлоба
      S.phase = 'chute';
      const u = seg(P, T_LEVEL, T_CHUTE), mv = ease(clamp(u / 0.5));
      S.x = lerp(LEVEL[8].x, CHUTE_X - 0.2, mv) + (u > 0.55 ? Math.sin((u - 0.55) * 60) * 0.35 : 0);
      S.z = lerp(LEVEL[8].z, 0, mv); S.tip = BED_Y + lerp(1.5, 1.0, mv);
      S.noodle = clamp((u - 0.35) / 0.4); S.noodleCol = 0;
      return S;
    }
    if (P < T_PURGE) {                                                  // линия очистки
      S.phase = 'purge';
      const u = seg(P, T_CHUTE, T_PURGE), mv = ease(clamp(u / 0.35));
      const run = clamp((u - 0.35) / 0.65);
      S.x = u < 0.35 ? lerp(CHUTE_X - 0.2, PURGE_X0, mv) : lerp(PURGE_X0, PURGE_X1, run);
      S.z = u < 0.35 ? lerp(0, PURGE_Z, mv) : PURGE_Z;
      S.tip = BED_Y + (u < 0.35 ? lerp(1.0, 0.25, mv) : 0.22);
      S.purge = run; S.extrude = run > 0 && run < 1;
      return S;
    }
    const pa = T_PURGE, span = T_PRINT - T_PURGE - CC_W, plateFrac = sign.plateLayers / sign.layers, ps = pa + plateFrac * span;
    if (P < T_PRINT) {
      S.purge = 1;
      if (P < ps || P >= ps + CC_W) {
        S.phase = 'print';
        const f = P < ps ? (P - pa) / span : (P - pa - CC_W) / span;
        S.f = clamp(f); S.extrude = true; S.act = S.f >= plateFrac - 1e-6 && P >= ps ? 1 : 0;
        layerPos(S.f, tmp); S.x = tmp.x; S.z = tmp.z; S.tip = BED_Y + S.f * sign.H + 0.06;
        return S;
      }
      // смена цвета: сопло едет к жёлобу, AMS меняет катушку, продувка, возврат
      S.phase = 'cc'; S.f = plateFrac; S.act = 0;
      const k = (P - ps) / CC_W;
      layerPos(plateFrac, tmp); const a = { x: tmp.x, z: tmp.z };
      layerPos(plateFrac + 1e-4, tmp2);
      const top = BED_Y + plateFrac * sign.H + 0.06;
      const go = ease(clamp(k / 0.22)), back = ease(clamp((k - 0.82) / 0.18));
      S.x = lerp(lerp(a.x, CHUTE_X - 0.2, go), tmp2.x, back); S.z = lerp(lerp(a.z, 0, go), tmp2.z, back);
      S.tip = lerp(lerp(top, BED_Y + 1.6, go), top, back) + Math.sin(go * Math.PI) * 0.6 * (1 - back);
      S.spoolDir = k > 0.25 && k < 0.45 ? -1 : 0; S.spoolDir2 = k > 0.4 && k < 0.6 ? 1 : 0;
      S.act = k > 0.5 ? 1 : 0;
      S.noodle = k > 0.55 && k < 0.8 ? clamp((k - 0.55) / 0.25) : 0; S.noodleCol = 1;
      if (k > 0.8 && k < 0.9) S.x += Math.sin((k - 0.8) * 90) * 0.3;
      return S;
    }
    S.phase = 'done'; S.f = 1; S.act = 1; S.purge = 1;
    layerPos(0.9999, tmp);
    const q = smooth(T_FINISH, 1, P);
    S.x = lerp(tmp.x, PARK_X, q); S.z = lerp(tmp.z, -2, q); S.tip = BED_Y + sign.H + 0.06 + q * 15; S.q = q;
    return S;
  }

  // ── Главный цикл ──────────────────────────────────────────
  const anim = { t: 0, started: false };
  let last = performance.now(), visible = false, raf = 0, clock = 0, prevF = 0;
  const target = new THREE.Vector3(), lookTube = new THREE.Color(ACC);
  const fmtEta = (min) => `${Math.floor(min / 60)}ч ${String(Math.round(min % 60)).padStart(2, '0')}м`;
  const pushTrail = (x, y, z, c) => {
    tp[tHead * 3] = x; tp[tHead * 3 + 1] = y; tp[tHead * 3 + 2] = z; tAge[tHead] = 0;
    tc[tHead * 3] = c.r; tc[tHead * 3 + 1] = c.g; tc[tHead * 3 + 2] = c.b; tHead = (tHead + 1) % TN;
  };
  const trailCol = new THREE.Color(1.0, 0.62, 0.3);
  let q = 0, noodleLen = 0;

  function frame(now) {
    raf = 0;
    if (!visible) return;
    if (!sign) { raf = requestAnimationFrame(frame); return; }
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    clock += dt;
    if (reduce) anim.t = 1;
    else if (anim.started) anim.t = Math.min(1, anim.t + dt / DUR);
    const P = anim.t;
    const st = choreo(P);
    const f = st.f, H = sign.H, h = f * H;
    q = st.phase === 'done' ? st.q : 0;
    const warm = smooth(0, T_WARM, P), bedWarm = smooth(0, 0.035, P);
    const printing = st.phase === 'print';

    head.position.set(st.x, st.tip, 0);
    bed.position.z = clamp(-st.z, -4.7, 4.7);
    rail.position.y = st.tip + 4.75;
    part.rotation.y = reduce ? 0.12 : Math.sin(clock * 0.7) * 0.18 * smooth(0.4, 0.8, q);
    const towerHide = q > 0.45;
    part.visible = f > 0;

    clipTop.constant = BED_Y + h + 0.02;
    clipBot.constant = -(BED_Y + h - 0.1);
    hotMeshes.forEach((m) => { m.visible = printing; });
    // прайм-башня растёт вместе с деталью: низ — цвет подложки, верх — цвет букв
    const tw = sign.tower;
    towerLow.visible = towerHigh.visible = !towerHide && f > 0;
    towerLow.scale.set(tw.hw * 2, sign.plateT, tw.hd * 2); towerLow.position.set(tw.x, 0.02 + sign.plateT / 2, tw.z);
    towerHigh.scale.set(tw.hw * 2, Math.max(0.001, H - sign.plateT), tw.hd * 2); towerHigh.position.set(tw.x, 0.02 + sign.plateT + (H - sign.plateT) / 2, tw.z);
    purgeLine.scale.x = Math.max(0.001, (PURGE_X1 - PURGE_X0) * st.purge);

    // мусорный жёлоб: вытекающая лапша
    noodle.visible = st.noodle > 0;
    if (noodle.visible) {
      noodle.material.color.copy(curCols[st.noodleCol]);
      noodleLen = st.noodle * 1.6;
      noodle.scale.y = Math.max(0.01, noodleLen);
      noodle.position.set(CHUTE_X - 0.2, head.position.y - 0.4 - noodleLen / 2, 0);
    }
    wiper.position.x = CHUTE_X - 0.2 + (st.phase === 'chute' && st.noodle > 0.9 ? Math.sin(clock * 30) * 0.3 : 0);

    // нагрев / свечение
    const heat = bedWarm * (1 - smooth(T_FINISH, 1, P));
    bedEdgeMat.opacity = heat * 0.9;
    const hot = clamp(warm * 1.0) * (1 - q);
    const glowK = (printing || st.purge > 0 && st.extrude || st.noodle > 0) ? 1 : hot * 0.5;
    tipGlow.material.opacity = glowK; tipGlow.scale.setScalar(2.0 + Math.sin(clock * 18) * 0.25);
    nozzleLight.intensity = 50 * glowK;

    // AMS: какая катушка работает
    const feed = 6 * dt;
    if (st.extrude) spoolAng[st.act] += feed;
    if (st.spoolDir) spoolAng[0] += st.spoolDir * 14 * dt;
    if (st.spoolDir2) spoolAng[1] += st.spoolDir2 * 14 * dt;
    if (st.noodle > 0) spoolAng[st.noodleCol] += 4 * dt;
    spools.forEach((s, i) => { s.rotation.y = spoolAng[i]; });
    const active = st.spoolDir || st.spoolDir2 ? (st.spoolDir ? 0 : 1) : st.act;
    leds.forEach((l, i) => l.material.color.set(i === active && f > 0 && q < 1 || (i === 0 && st.phase === 'chute') ? ACC : 0x2a2f35));
    lookTube.lerp(curCols[st.act], 1 - Math.exp(-dt * 6));
    tubeMat.color.copy(lookTube); tubeMat.emissive.copy(lookTube);
    updateTube();

    // след «свежего пластика» на столе
    for (let i = 0; i < TN; i++) {
      if (tAge[i] < 5) { tAge[i] += dt * 2.4; const k = Math.max(0, 1 - tAge[i]); tc[i * 3] = trailCol.r * k; tc[i * 3 + 1] = trailCol.g * k; tc[i * 3 + 2] = trailCol.b * k; }
    }
    if (st.extrude && f > 0 && f < 1 && st.phase === 'print') {
      const y0 = h + 0.08;
      for (let k = 1; k <= 8; k++) { layerPos(lerp(prevF, f, k / 8), tmp); pushTrail(tmp.x, y0, tmp.z, trailCol); }
    } else if (st.phase === 'purge' && st.extrude) pushTrail(st.x, 0.1, st.z, trailCol);
    prevF = f;
    tg.attributes.position.needsUpdate = true; tg.attributes.color.needsUpdate = true;

    pulse.scale.setScalar(26 + ((clock * 14) % 60)); pulse.material.opacity = 0.35 * (1 - ((clock * 14) % 60) / 60) * (printing ? 1 : 0.3);

    // Камера: весь принтер → камера печати → крупно готовая табличка
    const u = smooth(0.03, 0.2, P), v = smooth(T_FINISH, 1, P);
    const dist = lerp(lerp(fit(94, 60), fit(50, 46), u), fit(20, 27), v);
    target.set(0, lerp(lerp(34, 21, u), 9.5, v), 0);
    const az = lerp(lerp(-0.6, 0.22, smooth(0, 0.8, P)), 0.0, v) + Math.sin(clock * 0.25) * 0.02;
    const el = lerp(lerp(0.16, 0.3, u), 0.55, v);
    camera.position.set(
      target.x + dist * Math.sin(az) * Math.cos(el),
      target.y + dist * Math.sin(el),
      target.z + dist * Math.cos(az) * Math.cos(el),
    );
    camera.lookAt(target);

    const arr = pg.attributes.position.array;
    for (let i = 0; i < PN; i++) { arr[i * 3 + 1] += pv[i] * dt; if (arr[i * 3 + 1] > 80) arr[i * 3 + 1] = 0; }
    pg.attributes.position.needsUpdate = true;

    composer.render();

    const nz = Math.round(lerp(28, 220, warm)), bd = Math.round(lerp(24, 60, bedWarm));
    const stateTxt = P >= 0.9 ? 'ГОТОВО' : st.phase === 'warm' ? 'ПРОГРЕВ' : st.phase === 'level' ? 'КАЛИБРОВКА' : st.phase === 'chute' ? 'ЧИСТКА СОПЛА'
      : st.phase === 'purge' ? 'ЛИНИЯ ОЧИСТКИ' : st.phase === 'cc' ? 'СМЕНА ЦВЕТА · AMS' : 'ПЕЧАТЬ';
    const layerNow = Math.round(f * sign.layers), pct = Math.round(P * 100);
    setTxt('state', stateTxt);
    setTxt('layer', `${layerNow} / ${sign.layers}`);
    setTxt('height', `${(f * H * 10).toFixed(1)} мм`);
    setTxt('nozzle', `${nz} °C`);
    setTxt('bed', `${bd} °C`);
    setTxt('fil', `${(f * info.grams).toFixed(0)} г`);
    setTxt('eta', f >= 1 ? '—' : fmtEta((1 - f) * info.minutes));
    setTxt('pct', `${pct}%`);
    hud.bar.style.transform = `scaleX(${P.toFixed(4)})`;
    drawScreen(P, st.phase === 'done' ? 'Finished' : 'Printing', nz, bd, pct, layerNow, sign.layers, info.name || 'GAMERHUB');
    raf = requestAnimationFrame(frame);
  }

  const start = () => { if (!raf && visible && !document.hidden) { last = performance.now(); raf = requestAnimationFrame(frame); } };
  new IntersectionObserver((en) => {
    visible = en[0].isIntersecting;
    if (visible && en[0].intersectionRatio >= 0.3) anim.started = true;
    start();
  }, { threshold: [0, 0.3] }).observe(stage);
  document.addEventListener('visibilitychange', start);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(raf); raf = 0; });
  canvas.addEventListener('webglcontextrestored', start);

  return {
    setModel(model, grams, minutes, name) {
      part.children.slice().forEach((c) => part.remove(c));
      hotMeshes.length = 0;
      if (part.userData.geos) part.userData.geos.forEach((g) => g.dispose());
      part.userData.geos = [model.plate, model.letters];
      const mk = (geo, mat) => { const m = new THREE.Mesh(geo, mat); m.frustumCulled = false; m.castShadow = mat !== hotMat; m.receiveShadow = true; part.add(m); return m; };
      mk(model.plate, plateMat); mk(model.letters, letterMat);
      for (const g of [model.plate, model.letters]) {
        const hm = mk(g, hotMat); hm.scale.set(1.012, 1, 1.012); hm.visible = false; hotMeshes.push(hm);
      }
      sign = model; info = { grams, minutes, name };
      tAge.fill(9); tc.fill(0);
    },
    setColors(plateHex, letterHex) {
      plateMat.color.set(plateHex); letterMat.color.set(letterHex); purgeMat.color.set(plateHex);
      curCols[0].set(plateHex); curCols[1].set(letterHex);
      spoolMats[0].color.set(plateHex); spoolMats[1].color.set(letterHex);
    },
    restart() { anim.t = 0; anim.started = visible; prevF = 0; tAge.fill(9); tc.fill(0); },
  };
}

// ── Панель управления: текст, цвета, цена ────────────────────
export function initBuild() {
  const root = document.getElementById('build');
  const canvas = document.getElementById('buildCanvas');
  if (!root || !canvas) return;
  const stage = root.querySelector('.build__stage');
  const $ = (s) => root.querySelector(s);

  let scene3d = null;
  try { scene3d = initScene(canvas, stage, root); } catch (e) { console.warn('WebGL недоступен:', e); root.classList.add('build--static'); }

  const st = { text: $('#bdText').value, plate: SWATCHES[1].hex, letters: SWATCHES[0].hex, font: null, model: null, quote: null, clean: '' };
  const mountSw = (host, key) => {
    host.innerHTML = SWATCHES.map((s, i) =>
      `<button type="button" class="bsw${s.hex === st[key] ? ' is-active' : ''}" data-i="${i}" title="${s.name}" aria-label="${s.name}" style="--c:${hexStr(s.hex)}"></button>`).join('');
    host.addEventListener('click', (e) => {
      const b = e.target.closest('.bsw'); if (!b) return;
      st[key] = SWATCHES[+b.dataset.i].hex;
      host.querySelectorAll('.bsw').forEach((x) => x.classList.toggle('is-active', x === b));
      scene3d?.setColors(st.plate, st.letters);
      price();
    });
  };
  mountSw($('#bdPlate'), 'plate');
  mountSw($('#bdLetters'), 'letters');

  function price() {
    if (!st.model) return;
    const two = st.plate !== st.letters;
    const r = quote({ volumeCm3: st.model.volumeCm3, areaCm2: st.model.areaCm2, material: 'PLA', layer: '0.20', infill: 0.4,
      qty: 1, supports: false, rush: false, mode: two ? 'ams' : 'single', colors: two ? 2 : 1 });
    st.quote = r;
    const s = st.model.sizeMm;
    $('#bdSize').textContent = `${Math.round(s.x)} × ${Math.round(s.z)} мм`;
    $('#bdGrams').textContent = `${r.grams} г PLA`;
    $('#bdTime').textContent = fmtTime(r.hours);
    $('#bdPrice').textContent = '≈ ' + fmtMoney(r.total);
  }

  async function rebuild() {
    st.font ??= await loadFont();
    const raw = $('#bdText').value.trim().slice(0, 14);
    const bad = unsupported(st.font, raw);
    $('#bdWarn').textContent = bad.length ? `Символы ${bad.join(' ')} шрифт не умеет — они не напечатаются.` : '';
    const clean = [...raw].filter((c) => c === ' ' || c in st.font.data.glyphs).join('').trim();
    if (!clean) { $('#bdPrice').textContent = '—'; $('#bdOrder').disabled = true; return; }
    $('#bdOrder').disabled = false;
    st.clean = clean;
    st.model = makeSign(st.font, clean);
    price();
    if (scene3d) {
      scene3d.setModel(st.model, st.quote.grams, st.quote.hours * 60, st.clean);
      scene3d.setColors(st.plate, st.letters);
      scene3d.restart();
    }
  }

  let t;
  $('#bdText').addEventListener('input', () => { clearTimeout(t); t = setTimeout(rebuild, 450); });
  $('#bdReplay').addEventListener('click', () => scene3d?.restart());
  $('#bdOrder').addEventListener('click', () => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
    set('mkText', st.clean);
    set('mkHeight', st.model.height); set('mkThick', 6);
    document.querySelector('#mkStyle .seg[data-style="plate"]')?.click();
    const tt = document.getElementById('mkTwoTone');
    const two = st.plate !== st.letters;
    if (tt && tt.checked !== two) { tt.checked = two; tt.dispatchEvent(new Event('change', { bubbles: true })); }
    document.getElementById('maker')?.scrollIntoView({ behavior: 'smooth' });
  });
  new IntersectionObserver((en) => document.body.classList.toggle('in-build', en[0].isIntersecting), { threshold: 0.15 }).observe(stage);
  rebuild();
}

initBuild();
