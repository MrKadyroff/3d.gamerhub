// ─────────────────────────────────────────────────────────────
//  Конструктор: превращает введённый текст в настоящую 3D-модель
//  (брелок / табличка / объёмные буквы) и отдаёт готовый STL.
// ─────────────────────────────────────────────────────────────
import * as THREE from '../vendor/three.module.js';
import { FontLoader } from '../vendor/loaders/FontLoader.js';
import { TextGeometry } from '../vendor/geometries/TextGeometry.js';

const FONT_URL = '../vendor/fonts/droid_sans_bold.typeface.json';
let fontPromise = null;

export function loadFont() {
  fontPromise ??= new Promise((res, rej) =>
    new FontLoader().load(new URL(FONT_URL, import.meta.url).href, res, undefined, rej));
  return fontPromise;
}

/** Символы, которых нет в шрифте (например, казахские Қ, Ә). */
export function unsupported(font, text) {
  const glyphs = font.data.glyphs;
  return [...new Set([...text])].filter((c) => c !== ' ' && !(c in glyphs));
}

export const STYLES = {
  keychain: { label: 'Брелок', ring: true,  plate: true,  desc: 'С кольцом — на ключи, рюкзак, сумку' },
  plate:    { label: 'Табличка', ring: false, plate: true,  desc: 'На дверь, стол, полку' },
  letters:  { label: 'Объёмные буквы', ring: false, plate: false, desc: 'Только текст, без подложки' },
};

/**
 * Собирает модель из текста.
 * @param {{font:object, text:string, style:string, height:number,
 *          thickness:number, plateMargin:number}} o
 * @returns {{geometry:THREE.BufferGeometry, size:{x:number,y:number,z:number}}}
 */
export function build(o) {
  const style = STYLES[o.style] ?? STYLES.keychain;
  const text = (o.text || '').slice(0, 24);
  const parts = [];

  // ── Текст ────────────────────────────────────────────
  const letterDepth = style.plate ? o.thickness * 0.55 : o.thickness;
  const textGeo = new TextGeometry(text, {
    font: o.font,
    size: o.height,
    depth: letterDepth,
    curveSegments: o.curveSegments ?? 6,
    bevelEnabled: true,
    bevelThickness: o.height * 0.02,
    bevelSize: o.height * 0.015,
    bevelSegments: o.bevelSegments ?? 2,
  });
  textGeo.computeBoundingBox();
  const tb = textGeo.boundingBox;
  const tw = tb.max.x - tb.min.x;
  const th = tb.max.y - tb.min.y;
  // Центрируем текст в начале координат.
  textGeo.translate(-(tb.min.x + tw / 2), -(tb.min.y + th / 2), style.plate ? o.thickness * 0.45 : 0);
  parts.push(textGeo);

  // ── Подложка ─────────────────────────────────────────
  let plateW = tw, plateH = th;
  if (style.plate) {
    plateW = tw + o.plateMargin * 2;
    plateH = th + o.plateMargin * 2;
    const r = Math.min(plateH * 0.28, o.plateMargin * 1.4, 6);
    const shape = roundedRect(plateW, plateH, r);

    if (style.ring) {
      // Ушко под кольцо: круг слева, вплавленный в подложку, с отверстием.
      const earR = plateH * 0.42;
      const earX = -plateW / 2 - earR * 0.45;
      const ear = new THREE.Path();
      ear.absarc(earX, 0, earR, 0, Math.PI * 2, false);
      const earShape = new THREE.Shape(ear.getPoints(48));
      const hole = new THREE.Path();
      hole.absarc(earX - earR * 0.18, 0, Math.max(1.6, earR * 0.36), 0, Math.PI * 2, true);
      earShape.holes.push(hole);
      parts.push(new THREE.ExtrudeGeometry(earShape, { depth: o.thickness, bevelEnabled: false }));
      plateW += earR * 1.9;
    }
    parts.push(new THREE.ExtrudeGeometry(shape, { depth: o.thickness, bevelEnabled: false }));
  }

  const geometry = mergeGeometries(parts);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const c = bb.getCenter(new THREE.Vector3());
  // Кладём плашмя на стол: печатать надо лёжа.
  geometry.translate(-c.x, -c.y, -bb.min.z);
  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingBox();
  geometry.computeVertexNormals();

  const size = geometry.boundingBox.getSize(new THREE.Vector3());
  return { geometry, size: { x: size.x, y: size.y, z: size.z } };
}

export function roundedRect(w, h, r) {
  const x = -w / 2, y = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Склеивает геометрии в одну (только позиции — нормали пересчитываем). */
function mergeGeometries(list) {
  const arrays = list.map((g) => (g.index ? g.toNonIndexed() : g).attributes.position.array);
  const merged = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrays) { merged.set(a, off); off += a.length; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(merged, 3));
  return g;
}

/** Экспорт в бинарный STL — то же, что вышло бы из слайсера. */
export function exportSTL(geometry) {
  const pos = geometry.attributes.position.array;
  const tris = pos.length / 9;
  const buf = new ArrayBuffer(84 + tris * 50);
  const view = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(new TextEncoder().encode('3D.GAMERHUB generated model'));
  view.setUint32(80, tris, true);

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  let off = 84;
  for (let i = 0; i < pos.length; i += 9) {
    a.set(pos[i], pos[i + 1], pos[i + 2]);
    b.set(pos[i + 3], pos[i + 4], pos[i + 5]);
    c.set(pos[i + 6], pos[i + 7], pos[i + 8]);
    n.copy(e1.copy(b).sub(a)).cross(e2.copy(c).sub(a)).normalize();
    for (const v of [n, a, b, c]) {
      view.setFloat32(off, v.x, true);
      view.setFloat32(off + 4, v.y, true);
      view.setFloat32(off + 8, v.z, true);
      off += 12;
    }
    view.setUint16(off, 0, true);
    off += 2;
  }
  return new Blob([buf], { type: 'model/stl' });
}
