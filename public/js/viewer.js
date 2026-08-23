import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/controls/OrbitControls.js';
import { STLLoader } from '../vendor/loaders/STLLoader.js';
import { OBJLoader } from '../vendor/loaders/OBJLoader.js';
import { ThreeMFLoader } from '../vendor/loaders/3MFLoader.js';

const ACCENT = 0xff7a29;

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    // preserveDrawingBuffer нужен, чтобы снимок вьювера не приходил пустым.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 5000);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = false;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30323a, 2.1));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, 2, 1.4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(ACCENT, 1.4);
    rim.position.set(-1.4, 0.6, -1.2);
    this.scene.add(rim);

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.plate = this.#makePlate();
    this.scene.add(this.plate);

    // Плоскость отсечения — ею «печатаем» модель снизу вверх.
    this.clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e6);
    this.printing = false;

    this.#observe();
    this.renderer.setAnimationLoop(() => this.#tick());
  }

  #makePlate() {
    const g = new THREE.Group();
    const grid = new THREE.GridHelper(256, 32, 0x3a2f26, 0x24272c);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    g.add(grid);
    const edge = new THREE.Mesh(
      new THREE.RingGeometry(178, 182, 64),
      new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.18, side: THREE.DoubleSide })
    );
    edge.rotation.x = -Math.PI / 2;
    edge.position.y = -0.4;
    g.add(edge);
    return g;
  }

  #observe() {
    const resize = () => {
      const { clientWidth: w, clientHeight: h } = this.canvas;
      if (!w || !h) return;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(this.canvas);
    resize();
  }

  #tick() {
    this.controls.update();
    if (this.printing && this.mesh) {
      this.printHead += this.printSpeed;
      this.clip.constant = this.printHead;
      if (this.nozzle) {
        this.nozzle.position.y = Math.min(this.printHead, this.bbox.max.y);
        this.nozzle.visible = this.printHead < this.bbox.max.y;
        const t = performance.now() / 260;
        this.nozzle.position.x = Math.cos(t) * this.bbox.max.x * 0.5;
        this.nozzle.position.z = Math.sin(t) * this.bbox.max.z * 0.5;
      }
      if (this.printHead > this.bbox.max.y + 2) { this.stopPrint(); this.onPrintEnd?.(); }
    }
    this.renderer.render(this.scene, this.camera);
  }

  /** Загружает файл, возвращает метрики модели. */
  async load(file) {
    const name = file.name.toLowerCase();
    const buf = await file.arrayBuffer();
    let geometry;

    if (name.endsWith('.stl')) {
      geometry = new STLLoader().parse(buf);
    } else if (name.endsWith('.obj')) {
      geometry = mergeObject(new OBJLoader().parse(new TextDecoder().decode(buf)));
    } else if (name.endsWith('.3mf')) {
      geometry = mergeObject(new ThreeMFLoader().parse(buf));
    } else {
      throw new Error('Поддерживаются STL, OBJ и 3MF');
    }
    if (!geometry) throw new Error('Не удалось прочитать геометрию из файла');

    geometry.deleteAttribute('uv');
    geometry = geometry.index ? geometry.toNonIndexed() : geometry;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();

    // Ставим в центр стола, «пяткой» на y=0.
    const bb = geometry.boundingBox;
    const c = bb.getCenter(new THREE.Vector3());
    geometry.translate(-c.x, -bb.min.y, -c.z);
    geometry.computeBoundingBox();

    this.#mount(geometry);
    return this.metrics();
  }

  /** Монтирует готовую геометрию (из конструктора), без парсинга файла. */
  loadGeometry(geometry) {
    this.#mount(geometry);
    return this.metrics();
  }

  #mount(geometry) {
    this.clear();
    this.baseGeometry = geometry;

    const material = new THREE.MeshStandardMaterial({
      color: 0xe8ecef, roughness: 0.62, metalness: 0.05,
      clippingPlanes: [this.clip], clipShadows: true,
    });
    // Полоски слоёв — как на реальной FDM-детали.
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n varying vec3 vLocalPos;`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>
          float band = fract(vLocalPos.y / 0.9);
          float line = smoothstep(0.0, 0.35, band) * smoothstep(1.0, 0.65, band);
          gl_FragColor.rgb *= 0.82 + 0.18 * line;`);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n varying vec3 vLocalPos;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n vLocalPos = position;`);
    };

    this.mesh = new THREE.Mesh(geometry, material);
    this.root.add(this.mesh);
    if (this.palette) this.setPalette(this.palette, this.silk);

    const wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 32),
      new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.22, clippingPlanes: [this.clip] })
    );
    this.root.add(wire);

    this.setScale(1);
  }

  /**
   * Красит модель. Один цвет — обычная печать. Несколько — имитация AMS:
   * цвета сменяются по высоте, ровно как при смене филамента на слое.
   */
  setPalette(hexes, silk = false) {
    this.palette = hexes;
    this.silk = silk;
    if (!this.mesh) return;
    const m = this.mesh.material;
    // Шёлковый пластик заметно глянцевее обычного матового.
    m.roughness = silk ? 0.22 : 0.62;
    m.metalness = silk ? 0.55 : 0.05;

    if (hexes.length < 2) {
      m.vertexColors = false;
      this.baseGeometry.deleteAttribute('color');
      m.color.set(hexes[0] ?? 0xe8ecef);
    } else {
      m.vertexColors = true;
      m.color.set(0xffffff);
      this.#paintBands(hexes);
    }
    m.needsUpdate = true;
  }

  /** Раскладывает цвета полосами по высоте печати. */
  #paintBands(hexes) {
    const g = this.baseGeometry;
    const pos = g.attributes.position;
    const bb = g.boundingBox;
    const minY = bb.min.y, span = Math.max(1e-6, bb.max.y - minY);
    const cols = hexes.map((h) => new THREE.Color(h).convertSRGBToLinear());
    const arr = new Float32Array(pos.count * 3);

    for (let i = 0; i < pos.count; i += 3) {
      // Цвет назначаем на треугольник целиком — иначе границы «размажет».
      let mid = 0;
      for (let k = 0; k < 3; k++) mid += pos.getY(i + k);
      const t = (mid / 3 - minY) / span;
      const c = cols[Math.min(cols.length - 1, Math.floor(t * cols.length))];
      for (let k = 0; k < 3; k++) {
        arr[(i + k) * 3] = c.r; arr[(i + k) * 3 + 1] = c.g; arr[(i + k) * 3 + 2] = c.b;
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }

  /** Масштаб модели (1 = исходный размер). */
  setScale(k) {
    this.scale = k;
    if (!this.mesh) return;
    this.root.scale.setScalar(k);
    this.bbox = new THREE.Box3().setFromObject(this.root);
    this.#frame();
    this.clip.constant = 1e6;
    return k;
  }

  /** Подгоняет модель под заданный габарит по выбранной оси, мм. */
  fitDimension(axis, mm) {
    const base = this.baseSize();
    if (!base || !base[axis]) return this.scale;
    return this.setScale(mm / base[axis]);
  }

  baseSize() {
    if (!this.baseGeometry) return null;
    const s = this.baseGeometry.boundingBox.getSize(new THREE.Vector3());
    return { x: s.x, y: s.y, z: s.z };
  }

  #frame() {
    const size = this.bbox.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z, 20);
    const d = r * 2.1;
    this.camera.position.set(d * 0.75, d * 0.6, d * 0.75);
    this.camera.near = r / 100;
    this.camera.far = r * 40;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, size.y / 2, 0);
    this.controls.update();
    const plateScale = Math.max(1, r / 128);
    this.plate.scale.setScalar(plateScale);
  }

  /** Метрики в СМ и СМ² с учётом текущего масштаба. */
  metrics() {
    if (!this.baseGeometry) return null;
    const k = this.scale;
    const { volumeMm3, areaMm2 } = measure(this.baseGeometry);
    const s = this.baseSize();
    return {
      volumeCm3: (volumeMm3 * k ** 3) / 1000,
      areaCm2: (areaMm2 * k ** 2) / 100,
      size: { x: s.x * k, y: s.y * k, z: s.z * k },
      triangles: this.baseGeometry.attributes.position.count / 3,
    };
  }

  startPrint() {
    if (!this.mesh) return;
    this.printing = true;
    this.printHead = 0;
    this.printSpeed = Math.max(0.35, this.bbox.max.y / 220);
    if (!this.nozzle) {
      this.nozzle = new THREE.Mesh(
        new THREE.ConeGeometry(2.2, 6, 16),
        new THREE.MeshBasicMaterial({ color: ACCENT })
      );
      this.nozzle.rotation.x = Math.PI;
      this.scene.add(this.nozzle);
    }
  }

  stopPrint() {
    this.printing = false;
    this.clip.constant = 1e6;
    if (this.nozzle) this.nozzle.visible = false;
  }

  /** Снимок текущего вида — уходит в Telegram вместе с заявкой. */
  async snapshot(w = 1280, h = 960) {
    if (!this.mesh) return null;
    const wasPrinting = this.printing;
    this.stopPrint();                       // снимаем целую модель, а не срез

    const prevW = this.canvas.width, prevH = this.canvas.height, prevAspect = this.camera.aspect;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.scene.background = new THREE.Color(0x111316);   // без прозрачности: в Telegram так читаемее
    this.renderer.render(this.scene, this.camera);

    const blob = await new Promise((res) => this.canvas.toBlob(res, 'image/png'));

    this.scene.background = null;
    this.renderer.setSize(prevW, prevH, false);
    this.camera.aspect = prevAspect;
    this.camera.updateProjectionMatrix();
    if (wasPrinting) this.startPrint();
    return blob;
  }

  clear() {
    this.stopPrint();
    for (const o of [...this.root.children]) {
      o.geometry?.dispose();
      o.material?.dispose();
      this.root.remove(o);
    }
    this.mesh = null;
    this.baseGeometry = null;
  }
}

/** Объём (знаковые тетраэдры) и площадь поверхности меша, в мм³/мм². */
function measure(geometry) {
  const p = geometry.attributes.position.array;
  let volume = 0, area = 0;
  const ax = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cr = new THREE.Vector3();
  for (let i = 0; i < p.length; i += 9) {
    ax.set(p[i], p[i + 1], p[i + 2]);
    b.set(p[i + 3], p[i + 4], p[i + 5]);
    c.set(p[i + 6], p[i + 7], p[i + 8]);
    volume += ax.dot(cr.copy(b).cross(c)) / 6;
    e1.copy(b).sub(ax); e2.copy(c).sub(ax);
    area += cr.copy(e1).cross(e2).length() / 2;
  }
  return { volumeMm3: Math.abs(volume), areaMm2: area };
}

/** Схлопывает Object3D из OBJ/3MF в одну геометрию в мировых координатах. */
function mergeObject(object) {
  const parts = [];
  object.updateMatrixWorld(true);
  object.traverse((o) => {
    if (!o.isMesh) return;
    const g = (o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone());
    g.applyMatrix4(o.matrixWorld);
    parts.push(g.attributes.position.array);
  });
  if (!parts.length) return null;
  const total = parts.reduce((n, a) => n + a.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const a of parts) { merged.set(a, off); off += a.length; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(merged, 3));
  return g;
}
