// Копирует нужные модули three.js в public/vendor, чтобы фронт работал без CDN.
import { mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'public', 'vendor');
mkdirSync(join(vendor, 'loaders'), { recursive: true });
mkdirSync(join(vendor, 'controls'), { recursive: true });
mkdirSync(join(vendor, 'geometries'), { recursive: true });
mkdirSync(join(vendor, 'fonts'), { recursive: true });

const nm = join(root, 'node_modules');
copyFileSync(join(nm, 'three/build/three.module.js'), join(vendor, 'three.module.js'));
copyFileSync(join(nm, 'fflate/esm/browser.js'), join(vendor, 'fflate.module.js'));

const files = [
  ['three/examples/jsm/controls/OrbitControls.js', 'controls/OrbitControls.js'],
  ['three/examples/jsm/loaders/STLLoader.js', 'loaders/STLLoader.js'],
  ['three/examples/jsm/loaders/OBJLoader.js', 'loaders/OBJLoader.js'],
  ['three/examples/jsm/loaders/3MFLoader.js', 'loaders/3MFLoader.js'],
  ['three/examples/jsm/loaders/FontLoader.js', 'loaders/FontLoader.js'],
  ['three/examples/jsm/geometries/TextGeometry.js', 'geometries/TextGeometry.js'],
];
for (const [src, dst] of files) {
  // Переписываем bare-импорты на относительные пути — importmap не нужен.
  const code = readFileSync(join(nm, src), 'utf8')
    .replace(/from ['"]three['"]/g, `from '../three.module.js'`)
    .replace(/from ['"]fflate['"]/g, `from '../fflate.module.js'`)
    // three ссылается на свои же libs по относительному пути — тоже разворачиваем.
    .replace(/from ['"][^'"]*libs\/fflate\.module\.js['"]/g, `from '../fflate.module.js'`);
  // Страховка: если three начнёт тянуть ещё какой-то модуль, который мы не
  // скопировали, сборка должна упасть здесь, а не молча сломать сайт в браузере.
  const bad = [...code.matchAll(/from ['"]([^'"]+)['"]/g)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith('../') && !spec.startsWith('./'));
  if (bad.length) {
    throw new Error(`${src}: неразрешённые импорты ${bad.join(', ')} — допиши правило в scripts/vendor.js`);
  }
  writeFileSync(join(vendor, dst), code);
}
// Шрифт для конструктора надписей: латиница + кириллица.
copyFileSync(join(nm, 'three/examples/fonts/droid/droid_sans_bold.typeface.json'),
             join(vendor, 'fonts/droid_sans_bold.typeface.json'));

console.log('vendor: ok');
