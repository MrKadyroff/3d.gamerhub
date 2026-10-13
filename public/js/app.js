import { Viewer } from './viewer.js';
import { loadFont, unsupported, build, exportSTL, STYLES } from './maker.js';
import * as account from './account.js';
import { PRICING, quote, fmtMoney, fmtTime } from './pricing.js';

// ─────────────────────────────────────────────────────────────
//  КОНТАКТЫ — поменяй на свои
// ─────────────────────────────────────────────────────────────
const CONTACTS = {
  phone: '+7 707 511-19-45',
  phoneRaw: '77075111945',
  telegram: 'https://t.me/mrkadyroff',
  telegramLabel: '@mrkadyroff',
  instagram: 'https://instagram.com/3d.gamerhub',
  instagramLabel: '@3d.gamerhub',
  get whatsapp() { return `https://wa.me/${this.phoneRaw}`; },
  city: 'Алматы',
};

const FAQ = [
  ['Сколько ждать заказ?', 'Обычная очередь — 1–3 дня. Мелочь до 50 г часто печатаю в тот же день. Режим «срочно» — за 24 часа с наценкой 40%.'],
  ['Какой максимальный размер детали?', 'Одной деталью — 256 × 256 × 256 мм. Всё, что больше, режем на части и склеиваем или собираем на замках. Калькулятор сам предупредит, если модель не влезает.'],
  ['У меня нет 3D-модели, только идея или фото', 'Смоделирую с нуля. Напиши в Telegram, опиши задачу — оценю моделирование отдельно, обычно от 8 000 ₸.'],
  ['Насколько точна цена в калькуляторе?', 'Это честная оценка по объёму модели, заполнению и высоте слоя. Реальная нарезка может отличаться на 5–15% из-за поддержек и сложной геометрии — если разница будет заметной, я напишу до начала печати.'],
  ['Чем отличается AMS от обычной печати?', 'AMS автоматически меняет катушки прямо во время печати, поэтому деталь получается многоцветной без покраски и склейки. Стоит дороже: часть пластика уходит в промывочную башню, и печать идёт дольше.'],
  ['Как получить заказ в другом городе?', 'По Алматы — самовывоз или курьер через inDriver, обычно в день готовности. В любой другой город Казахстана отправляем Казпочтой; стоимость и срок зависят от веса и региона, посчитаем при согласовании заказа.'],
  ['Что с прочностью?', 'PLA жёсткий, но хрупкий и боится тепла выше 55 °C. PETG вязкий, ударопрочный, держит улицу и до 80 °C. Для нагруженных деталей бери PETG и заполнение от 40%.'],
];

// ─────────────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const byId = (id) => document.getElementById(id);
const state = {
  metrics: null, file: null, fileName: '',
  mode: 'single', material: 'PLA', colors: 2,
  layer: '0.20', infill: 0.2, qty: 1,
  supports: false, rush: false, scale: 1, lockRatio: true, colorList: [],
  result: null,
};

hydrate();

// Вьювер создаём в try/catch: без WebGL страница должна остаться живой,
// а не превратиться в мёртвую вёрстку.
let viewer = null;
try {
  viewer = new Viewer($('#viewerCanvas'));
  viewer.onPrintEnd = () => $('#btnPrint').classList.remove('is-active');
} catch (e) {
  console.error('WebGL недоступен:', e);
  $('#dropzone').innerHTML =
    '<div class="dropzone__inner"><b>Браузер не поддерживает 3D-превью</b>' +
    '<span>Включи аппаратное ускорение или просто пришли модель в Telegram — посчитаю руками.</span></div>';
  $('#dropzone').style.cursor = 'default';
}

// Палитра — только после вьювера: она сразу применяет цвет к нему.
const swatches = mountSwatches('#swatches', '#swatchVal', () => viewer,
  (picked) => { state.colorList = picked; state.colors = picked.length; }, 0);

/**
 * Палитра цветов. В режиме AMS становится множественным выбором —
 * сколько цветов выбрал, столько и посчитается.
 */
function mountSwatches(hostSel, labelSel, getViewer, onPick, initial = 0) {
  const host = $(hostSel);
  host.innerHTML = PRICING.colors.map((c, i) =>
    `<button type="button" class="swatch${c.silk ? ' swatch--silk' : ''}"` +
    ` data-i="${i}" title="${c.label}"${c.silk ? '' : ` style="background:${c.hex}"`}></button>`).join('');

  let chosen = [initial];
  let max = 1;

  const apply = () => {
    const picked = chosen.map((i) => PRICING.colors[i]);
    host.querySelectorAll('.swatch').forEach((b, j) => {
      const at = chosen.indexOf(j);
      b.classList.toggle('is-active', at >= 0);
      // В мультирежиме показываем порядок: снизу вверх, как ляжет на печати.
      b.dataset.order = max > 1 && at >= 0 ? at + 1 : '';
    });
    $(labelSel).textContent = picked.map((c) => c.label).join(' → ');
    getViewer()?.setPalette(picked.map((c) => c.hex), picked.length === 1 && picked[0].silk);
    onPick?.(picked);
  };

  host.addEventListener('click', (e) => {
    const b = e.target.closest('.swatch');
    if (!b) return;
    const i = +b.dataset.i;
    if (max === 1) chosen = [i];
    else if (chosen.includes(i)) { if (chosen.length > 2) chosen = chosen.filter((x) => x !== i); }
    else if (chosen.length < max) chosen.push(i);
    else chosen = [...chosen.slice(1), i];
    apply();
  });

  apply();
  return {
    /** Переключает палитру между одним цветом и мультицветом AMS. */
    setMax(n) {
      max = n;
      host.classList.toggle('swatches--multi', n > 1);
      if (n === 1) chosen = chosen.slice(0, 1);
      else while (chosen.length < 2) chosen.push((chosen.at(-1) + 1) % PRICING.colors.length);
      apply();
    },
    count: () => chosen.length,
  };
}

// ── Наполнение статики ───────────────────────────────────────
function hydrate() {
  $('#infill').innerHTML = PRICING.infills
    .map((i) => `<option value="${i.value}"${i.value === 0.2 ? ' selected' : ''}>${i.label}</option>`).join('');

  $('#faqList').innerHTML = FAQ.map(([q, a]) => `
    <div class="faq__item">
      <button class="faq__q" type="button">${q}<i>+</i></button>
      <div class="faq__a"><p>${a}</p></div>
    </div>`).join('');

  $('#pricePLA').textContent = `${PRICING.materials.PLA.pricePerGram} ₸/г материал · от ${fmtMoney(PRICING.minOrder)} за заказ`;
  $('#pricePETG').textContent = `${PRICING.materials.PETG.pricePerGram} ₸/г материал · от ${fmtMoney(PRICING.minOrder)} за заказ`;
  $('#matNote').textContent = PRICING.materials.PLA.note;

  $('#cTg').textContent = CONTACTS.telegramLabel;
  $('#cPh').textContent = CONTACTS.phone;
  $('#cIg').textContent = CONTACTS.instagramLabel;
  $('#cWa').textContent = CONTACTS.phone;

  const HREF = {
    phone: `tel:+${CONTACTS.phoneRaw}`,
    telegram: CONTACTS.telegram,
    whatsapp: CONTACTS.whatsapp,
    instagram: CONTACTS.instagram,
  };
  document.querySelectorAll('[data-contact]').forEach((el) => {
    const k = el.dataset.contact;
    el.href = HREF[k] ?? '#';
    if (k !== 'phone') { el.target = '_blank'; el.rel = 'noopener'; }
  });
}

// ── Загрузка файла ───────────────────────────────────────────
const dz = $('#dropzone'), input = $('#fileInput');
dz.addEventListener('click', () => viewer && input.click());
input.addEventListener('change', () => input.files[0] && handleFile(input.files[0]));
['dragenter', 'dragover'].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove('is-over'); }));
dz.addEventListener('drop', (ev) => viewer && ev.dataTransfer.files[0] && handleFile(ev.dataTransfer.files[0]));

async function handleFile(file) {
  if (!viewer) return;
  if (file.size > 60 * 1024 * 1024) return alert('Файл больше 60 МБ. Пришли его в Telegram — посчитаю руками.');
  try {
    const m = await viewer.load(file);
    state.file = file;
    state.fileName = file.name;
    state.scale = 1;
    state.metrics = m;
    dz.hidden = true;
    $('#viewerWrap').hidden = false;
    $('#hudName').textContent = file.name;
    $('#scale').disabled = false;
    ['dimX', 'dimY', 'dimZ'].forEach((id) => { $('#' + id).disabled = false; });
    $('#scale').value = 100;
    $('#scaleVal').textContent = '100%';
    recalc();
    setTimeout(() => { viewer.startPrint(); $('#btnPrint').classList.add('is-active'); }, 350);
  } catch (e) {
    alert('Не смог прочитать файл: ' + e.message);
  }
}

function removeModel() {
  viewer.clear();
  state.file = null; state.metrics = null;
  $('#viewerWrap').hidden = true;
  dz.hidden = false;
  input.value = '';
  $('#totalBody').hidden = true;
  $('#totalEmpty').hidden = false;
  $('#scale').disabled = true;
  ['dimX', 'dimY', 'dimZ'].forEach((id) => { $('#' + id).disabled = true; $('#' + id).value = ''; });
}

// ── Управление вьювером ──────────────────────────────────────
$('#btnRemove').addEventListener('click', removeModel);
$('#btnReset').addEventListener('click', () => viewer.setScale(state.scale));
$('#btnPrint').addEventListener('click', (e) => {
  if (viewer.printing) { viewer.stopPrint(); e.target.classList.remove('is-active'); }
  else { viewer.startPrint(); e.target.classList.add('is-active'); }
});

// ── Параметры ────────────────────────────────────────────────
$('#modeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('.seg'); if (!b) return;
  $('#modeSeg').querySelectorAll('.seg').forEach((x) => x.classList.toggle('is-active', x === b));
  state.mode = b.dataset.mode;
  swatches.setMax(state.mode === 'ams' ? 8 : 1);
  $('#swatchNote').textContent = state.mode === 'ams'
    ? 'Выбери 2–8 цветов — превью покажет, как они лягут по высоте. Порядок снизу вверх.'
    : '';
  recalc();
});
$('#matSeg').addEventListener('click', (e) => {
  const b = e.target.closest('.seg'); if (!b) return;
  $('#matSeg').querySelectorAll('.seg').forEach((x) => x.classList.toggle('is-active', x === b));
  state.material = b.dataset.mat;
  $('#matNote').textContent = PRICING.materials[state.material].note;
  recalc();
});
$('#layer').addEventListener('change', (e) => { state.layer = e.target.value; recalc(); });
$('#infill').addEventListener('change', (e) => { state.infill = +e.target.value; recalc(); });
$('#qty').addEventListener('input', (e) => { state.qty = Math.max(1, +e.target.value || 1); recalc(); });
$('#supports').addEventListener('change', (e) => { state.supports = e.target.checked; recalc(); });
$('#rush').addEventListener('change', (e) => { state.rush = e.target.checked; recalc(); });

$('#scale').addEventListener('input', (e) => {
  state.scale = +e.target.value / 100;
  $('#scaleVal').textContent = e.target.value + '%';
  viewer.setScale(state.scale);
  recalc();
});

$('#lockRatio').addEventListener('click', (e) => {
  state.lockRatio = !state.lockRatio;
  e.currentTarget.classList.toggle('is-active', state.lockRatio);
});

// Ввод конкретного габарита — пересчитываем масштаб (пропорционально).
for (const [id, axis] of [['dimX', 'x'], ['dimY', 'y'], ['dimZ', 'z']]) {
  $('#' + id).addEventListener('change', (e) => {
    const mm = +e.target.value;
    if (!mm || !state.metrics) return;
    state.scale = viewer.fitDimension(axis, mm);
    $('#scale').value = Math.round(state.scale * 100);
    $('#scaleVal').textContent = Math.round(state.scale * 100) + '%';
    recalc();
  });
}

// ── Пересчёт ─────────────────────────────────────────────────
function recalc() {
  if (!state.file || !viewer) return;
  const m = viewer.metrics();
  state.metrics = m;

  const s = m.size;
  const dim = (n) => Math.round(n * 10) / 10;
  $('#hudDims').textContent = `${dim(s.x)} × ${dim(s.y)} × ${dim(s.z)} мм`;
  $('#dimX').value = dim(s.x); $('#dimY').value = dim(s.y); $('#dimZ').value = dim(s.z);

  const bv = PRICING.buildVolume;
  const fits = [s.x, s.z].sort((a, b) => a - b);
  const plate = [bv.x, bv.y].sort((a, b) => a - b);
  const oversize = fits[0] > plate[0] || fits[1] > plate[1] || s.y > bv.z;
  $('#volumeWarn').hidden = !oversize;
  $('#oversizeNote').hidden = !oversize;

  const r = quote({
    volumeCm3: m.volumeCm3, areaCm2: m.areaCm2,
    material: state.material, mode: state.mode, colors: state.colors,
    layer: state.layer, infill: state.infill, qty: state.qty,
    supports: state.supports, rush: state.rush,
  });
  state.result = r;

  $('#totalEmpty').hidden = true;
  $('#totalBody').hidden = false;
  $('#rGrams').textContent = `${r.grams} г ${state.material}`;
  $('#rTime').textContent = fmtTime(r.hours) + (r.qty > 1 ? ` × ${r.qty}` : '');
  $('#rItem').textContent = fmtMoney(r.perItem);
  $('#rDiscountRow').hidden = r.discount === 1;
  $('#rDiscount').textContent = `−${Math.round((1 - r.discount) * 100)}%`;

  const price = $('#rTotal');
  price.textContent = '≈ ' + fmtMoney(r.total);
  price.classList.add('is-bump');
  setTimeout(() => price.classList.remove('is-bump'), 200);
}

// ── Заявка ───────────────────────────────────────────────────
const modal = $('#orderModal');
let pendingOrder = null;   // что именно заказываем: загруженная модель или сборка из конструктора

/** @param {{file:File, fileName:string, summary:string, payload:object}} o */
function openOrder(o) {
  pendingOrder = o;
  $('#orderSummary').textContent = o.summary;
  $('#orderStatus').textContent = '';
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
}

$('#btnOrder').addEventListener('click', () => {
  const r = state.result;
  if (!r || !state.file) return;   // нечего заказывать, пока модель не посчитана
  openOrder({
    file: state.file,
    fileName: state.fileName,
    viewer,
    summary: `${state.fileName} · ${state.material} · ${state.colorList.map((c) => c.label).join(' → ')} · ${PRICING.modes[state.mode].label} · слой ${state.layer} мм · ` +
             `${Math.round(state.infill * 100)}% · ${r.qty} шт · ${r.grams} г → ${fmtMoney(r.total)}`,
    payload: {
      fileName: state.fileName, source: 'upload',
      material: state.material, mode: state.mode, colors: state.colors,
      layer: state.layer, infill: state.infill, qty: state.qty,
      supports: state.supports, rush: state.rush, scale: state.scale,
      color: state.colorList.map((c) => c.label).join(' → '),
      size: state.metrics.size, volumeCm3: state.metrics.volumeCm3,
      areaCm2: state.metrics.areaCm2, quote: r,
    },
  });
});
modal.addEventListener('click', (e) => {
  if (e.target.dataset.close !== undefined) closeModal();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());
function closeModal() { modal.hidden = true; document.body.style.overflow = ''; }

$('#orderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#orderSubmit'), status = $('#orderStatus');
  const fd = new FormData(e.target);

  if (!pendingOrder) return;
  // Обязателен только телефон. Имя и комментарий — по желанию.
  const contact = String(fd.get('contact') || '').trim();
  if (contact.replace(/\D/g, '').length < 10 && !/@[A-Za-z0-9_]{4,}/.test(contact)) {
    status.className = 'modal__status is-err';
    status.textContent = 'Проверь номер: нужно не меньше 10 цифр.';
    return;
  }

  const payload = {
    name: String(fd.get('name') || '').trim() || 'Без имени',
    contact,
    comment: String(fd.get('comment') || '').trim(),
    ...pendingOrder.payload,
  };

  // Снимок вьювера — чтобы в Telegram сразу было видно, что заказали.
  const preview = await pendingOrder.viewer?.snapshot().catch(() => null);

  const body = new FormData();
  body.append('model', pendingOrder.file, pendingOrder.fileName);
  if (preview) body.append('preview', preview, 'preview.png');
  body.append('order', JSON.stringify(payload));

  btn.disabled = true; status.className = 'modal__status'; status.textContent = 'Отправляю…';
  try {
    const res = await fetch('/api/order', { method: 'POST', body });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Ошибка сервера');
    status.className = 'modal__status is-ok';
    status.textContent = `Готово! Заявка №${data.id} у меня. Напишу в течение часа.`;

    // Сначала сохраняем заказ, потом дорисовываем миниатюру: она не должна
    // задерживать или ронять запись в историю.
    const record = {
      id: data.id,
      at: new Date().toISOString(),
      name: pendingOrder.fileName,
      summary: pendingOrder.summary,
      price: data.total,
      status: 'new',
      thumb: null,
    };
    account.save(record);
    renderAccount();
    setTimeout(openOrders, 2800);   // сразу показываем заказ в панели

    account.thumbnail(preview)
      .then((thumb) => { if (thumb) { account.save({ ...record, thumb }); renderAccount(); } })
      .catch(() => {});

    e.target.reset();
    setTimeout(closeModal, 2600);
  } catch (err) {
    status.className = 'modal__status is-err';
    status.textContent = 'Не отправилось: ' + err.message + '. Напиши в Telegram — разберёмся.';
  } finally {
    btn.disabled = false;
  }
});

// ── Мелочи ───────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const q = e.target.closest('.faq__q'); if (!q) return;
  const item = q.parentElement;
  const open = item.classList.toggle('is-open');
  item.querySelector('.faq__a').style.maxHeight = open ? item.querySelector('.faq__a').scrollHeight + 'px' : 0;
});

const io = new IntersectionObserver((entries) => {
  entries.forEach((en) => en.isIntersecting && en.target.classList.add('is-in'));
}, { threshold: 0.08 });
document.querySelectorAll('.section, .marquee').forEach((el) => { el.classList.add('reveal'); io.observe(el); });


// ─────────────────────────────────────────────────────────────
//  КОНСТРУКТОР НАДПИСЕЙ
// ─────────────────────────────────────────────────────────────
const mk = { font: null, viewer: null, style: 'keychain', geometry: null, metrics: null, result: null, clean: '', colorList: [] };

// Параметры печати для конструктора: PLA, стандартный слой, плотное заполнение
// (мелкие надписи должны быть крепкими).
const MK_BASE = { material: 'PLA', layer: '0.20', infill: 0.4, qty: 1, supports: false, rush: false };
const mkParams = () => ({
  ...MK_BASE,
  mode: mk.colorList.length > 1 ? 'ams' : 'single',
  colors: mk.colorList.length,
});

$('#mkStyle').innerHTML = Object.entries(STYLES)
  .map(([k, v], i) => `<button class="seg${i === 0 ? ' is-active' : ''}" data-style="${k}"><b>${v.label}</b><span>${v.desc}</span></button>`)
  .join('');

async function initMaker() {
  try {
    mk.viewer = new Viewer($('#mkCanvas'));
    mk.swatches = mountSwatches('#mkSwatches', '#mkSwatchVal', () => mk.viewer,
      (picked) => { mk.colorList = picked; }, 3);
    mk.font = await loadFont();
  } catch (e) {
    console.error('Конструктор недоступен:', e);
    $('#maker').hidden = true;
    return;
  }
  rebuild();
}

function rebuild() {
  if (!mk.font || !mk.viewer) return;
  const text = $('#mkText').value.trim();
  $('#mkCount').textContent = `${$('#mkText').value.length} / 24`;

  const bad = unsupported(mk.font, text);
  $('#mkWarn').textContent = bad.length
    ? `Символы ${bad.join(' ')} шрифт не поддерживает — они не напечатаются. Напиши в Telegram, подберу другой шрифт.`
    : '';

  // В модель и в заявку идёт только то, что шрифт реально умеет напечатать.
  const clean = [...text].filter((c) => c === ' ' || c in mk.font.data.glyphs).join('').trim();
  mk.clean = clean;
  if (!clean) {
    $('#mkPrice').textContent = '—';
    $('#mkSize').textContent = $('#mkGrams').textContent = $('#mkTime').textContent = '—';
    mk.viewer.clear();
    return;
  }

  const height = +$('#mkHeight').value;
  const thickness = +$('#mkThick').value;
  const { geometry } = build({
    font: mk.font, text: clean, style: mk.style,
    height, thickness, plateMargin: Math.max(2.5, height * 0.32),
  });

  mk.geometry = geometry;
  mk.metrics = mk.viewer.loadGeometry(geometry);

  const d = (n) => Math.round(n * 10) / 10;
  const sz = mk.metrics.size;
  $('#mkDims').textContent = `${d(sz.x)} × ${d(sz.y)} × ${d(sz.z)} мм`;
  $('#mkSize').textContent = `${d(sz.x)} × ${d(sz.z)} мм`;

  const r = quote({ volumeCm3: mk.metrics.volumeCm3, areaCm2: mk.metrics.areaCm2, ...mkParams() });
  mk.result = r;
  $('#mkGrams').textContent = `${r.grams} г PLA`;
  $('#mkTime').textContent = fmtTime(r.hours);
  const price = $('#mkPrice');
  price.textContent = '≈ ' + fmtMoney(r.total);
  price.classList.add('is-bump');
  setTimeout(() => price.classList.remove('is-bump'), 200);
}

let rebuildTimer;
const rebuildSoon = () => { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(rebuild, 220); };

$('#mkText').addEventListener('input', rebuildSoon);
$('#mkHeight').addEventListener('input', (e) => { $('#mkHeightVal').textContent = e.target.value + ' мм'; rebuildSoon(); });
$('#mkThick').addEventListener('input', (e) => { $('#mkThickVal').textContent = e.target.value + ' мм'; rebuildSoon(); });
$('#mkStyle').addEventListener('click', (e) => {
  const b = e.target.closest('.seg'); if (!b) return;
  $('#mkStyle').querySelectorAll('.seg').forEach((x) => x.classList.toggle('is-active', x === b));
  mk.style = b.dataset.style;
  rebuild();
});
$('#mkTwoTone').addEventListener('change', (e) => {
  mk.swatches.setMax(e.target.checked ? 2 : 1);
  rebuild();
});
$('#mkPresets').addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  $('#mkText').focus();
  $('#mkText').placeholder = e.target.dataset.preset;
});
$('#mkPrintBtn').addEventListener('click', (e) => {
  if (!mk.viewer) return;
  if (mk.viewer.printing) { mk.viewer.stopPrint(); e.target.classList.remove('is-active'); }
  else { mk.viewer.startPrint(); e.target.classList.add('is-active'); }
});

$('#mkOrder').addEventListener('click', () => {
  if (!mk.geometry || !mk.result) return;
  const text = mk.clean || 'model';
  const safe = text.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 20);
  const fileName = `${STYLES[mk.style].label.toLowerCase()}_${safe}.stl`;
  const file = new File([exportSTL(mk.geometry)], fileName, { type: 'model/stl' });
  const d = (n) => Math.round(n * 10) / 10;
  const sz = mk.metrics.size;

  openOrder({
    file, fileName,
    viewer: mk.viewer,
    summary: `${STYLES[mk.style].label} «${text}» · ${mk.colorList.map((c) => c.label).join(' → ')} · ${d(sz.x)} × ${d(sz.z)} мм · ` +
             `${mk.result.grams} г → ${fmtMoney(mk.result.total)}`,
    payload: {
      fileName, source: 'maker',
      makerText: text, makerStyle: STYLES[mk.style].label, color: mk.colorList.map((c) => c.label).join(' → '),
      ...mkParams(), scale: 1,
      size: sz, volumeCm3: mk.metrics.volumeCm3, areaCm2: mk.metrics.areaCm2,
      quote: mk.result,
    },
  });
});

initMaker();


// ─────────────────────────────────────────────────────────────
//  ПАНЕЛЬ «МОИ ЗАКАЗЫ» — всегда под рукой, у правого края
// ─────────────────────────────────────────────────────────────
const esc = (t = '') => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const panel = $('#ordersPanel'), tab = $('#ordersTab'), backdrop = $('#ordersBackdrop');

function renderAccount(list = account.all()) {
  const has = list.length > 0;
  tab.hidden = !has;
  if (!has) { $('#ordersList').innerHTML = ''; closeOrders(); return; }

  // Ярлык показывает количество и подсвечивается, пока заказ в работе.
  $('#ordersBadge').textContent = list.length;
  const active = list.find((o) => o.status === 'printing' || o.status === 'accepted');
  tab.dataset.live = active ? '1' : '0';

  const newest = list[0];
  const st = account.STATUS_UI[newest.status] ?? account.STATUS_UI.new;
  tab.title = `Последняя заявка №${newest.id}: ${st.label}`;
  $('#ordersSub').textContent = `${list.length} ${plural(list.length, 'заявка', 'заявки', 'заявок')} · последняя: ${st.label.toLowerCase()}`;

  $('#ordersList').innerHTML = list.map((o) => {
    const s = account.STATUS_UI[o.status] ?? account.STATUS_UI.new;
    const thumb = o.thumb
      ? `<img class="ord__thumb" src="${o.thumb}" alt="">`
      : '<div class="ord__thumb ord__thumb--empty">◳</div>';
    return `<article class="ord">
      <button class="ord__del" data-del="${o.id}" title="Убрать из истории">✕</button>
      ${thumb}
      <div class="ord__body">
        <div class="ord__top">
          <span class="ord__id">№${o.id}</span>
          <span class="ord__id">${account.formatDate(o.at)}</span>
        </div>
        <div class="ord__name" title="${esc(o.summary)}">${esc(o.name)}</div>
        <div class="ord__foot">
          <span class="st ${s.cls}">${s.label}</span>
          <span class="ord__price">${fmtMoney(o.price)}</span>
        </div>
      </div>
    </article>`;
  }).join('');
}

const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

let hideTimer;

function openOrders() {
  clearTimeout(hideTimer);
  panel.hidden = false;
  backdrop.hidden = window.innerWidth > 600;   // затемнение нужно только на телефоне
  void panel.offsetHeight;                     // форсируем пересчёт, иначе не будет анимации
  panel.classList.add('is-open');
  tab.setAttribute('aria-expanded', 'true');
  account.refreshStatuses().then(renderAccount);
}

function closeOrders() {
  panel.classList.remove('is-open');
  backdrop.hidden = true;
  tab.setAttribute('aria-expanded', 'false');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (!panel.classList.contains('is-open')) panel.hidden = true; }, 300);
}

tab.addEventListener('click', () => (panel.classList.contains('is-open') ? closeOrders() : openOrders()));
$('#ordersClose').addEventListener('click', closeOrders);
backdrop.addEventListener('click', closeOrders);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeOrders());

$('#ordersList').addEventListener('click', (e) => {
  const id = e.target.closest('[data-del]')?.dataset.del;
  if (id) renderAccount(account.remove(id));
});

renderAccount();
account.refreshStatuses().then(renderAccount);
// Вернулись на вкладку — показываем свежий статус.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) account.refreshStatuses().then(renderAccount);
});
// Пока панель открыта, статусы подтягиваются сами.
setInterval(() => {
  if (panel.classList.contains('is-open')) account.refreshStatuses().then(renderAccount);
}, 30000);


// ─────────────────────────────────────────────────────────────
//  КАРУСЕЛЬ «ЧТО ПЕЧАТАЮТ»
// ─────────────────────────────────────────────────────────────
const carousel = {
  items: [], page: 0, perView: 4, gap: 16, timer: null,
  track: $('#worksTrack'), viewport: $('#worksCarousel'),
};

async function initCarousel() {
  try {
    const res = await fetch('img/gallery/manifest.json');
    carousel.items = await res.json();
  } catch {
    $('#works').hidden = true;
    return;
  }
  if (!carousel.items.length) { $('#works').hidden = true; return; }

  carousel.track.innerHTML = carousel.items.map((w, i) => `
    <article class="work" data-i="${i}" title="Подставить параметры в калькулятор">
      <img src="${w.img}" alt="${esc(w.label)}" loading="lazy" decoding="async">
      <span class="work__go">↗</span>
      <div class="work__meta"><b>${esc(w.label)}</b><span>${esc(w.hint ?? 'FDM · PLA / PETG')}</span></div>
    </article>`).join('');

  // Один блок с авторством на всю галерею — этого требуют лицензии CC BY.
  const authors = [...new Set(carousel.items.map((w) => `${w.author} (${w.license})`))];
  $('#worksCredits').innerHTML =
    'Это примеры типовых изделий, а не наши работы. Фотографии из открытых источников '
    + '(Wikimedia Commons, Flickr) по лицензиям CC BY / CC BY-SA. Авторы: '
    + authors.slice(0, 40).map(esc).join('; ')
    + '. Заменить своими: положи файлы в <code>public/img/gallery/</code> и обнови <code>manifest.json</code>.';

  layout();
  addEventListener('resize', layout);
  autoplay();
}

/** Считает, сколько карточек влезает, и подгоняет их ширину. */
function layout() {
  const w = carousel.viewport.clientWidth;
  carousel.perView = w < 560 ? 1 : w < 820 ? 2 : w < 1120 ? 3 : w < 1420 ? 4 : 5;
  const cardW = (w - carousel.gap * (carousel.perView - 1)) / carousel.perView;
  carousel.track.querySelectorAll('.work').forEach((el) => { el.style.width = cardW + 'px'; });
  carousel.pages = Math.max(1, Math.ceil(carousel.items.length / carousel.perView));
  carousel.page = Math.min(carousel.page, carousel.pages - 1);
  renderDots();
  move();
}

function move() {
  const w = carousel.viewport.clientWidth + carousel.gap;
  carousel.track.style.transform = `translateX(${-carousel.page * w}px)`;
  $('#worksPrev').disabled = carousel.page === 0;
  $('#worksNext').disabled = carousel.page >= carousel.pages - 1;
  $('#worksDots').querySelectorAll('button')
    .forEach((b, i) => b.classList.toggle('is-active', i === carousel.page));
}

function renderDots() {
  $('#worksDots').innerHTML = Array.from({ length: carousel.pages },
    (_, i) => `<button data-p="${i}" aria-label="Страница ${i + 1}"></button>`).join('');
}

function go(page, manual = true) {
  carousel.page = (page + carousel.pages) % carousel.pages;
  move();
  if (manual) autoplay();          // ручное действие сбрасывает автопрокрутку
}

function autoplay() {
  clearInterval(carousel.timer);
  carousel.timer = setInterval(() => {
    if (!document.hidden && carousel.pages > 1) go(carousel.page + 1, false);
  }, 5000);
}

$('#worksPrev').addEventListener('click', () => go(carousel.page - 1));
$('#worksNext').addEventListener('click', () => go(carousel.page + 1));
$('#worksDots').addEventListener('click', (e) => {
  const p = e.target.dataset.p;
  if (p !== undefined) go(+p);
});
carousel.viewport.addEventListener('mouseenter', () => clearInterval(carousel.timer));
carousel.viewport.addEventListener('mouseleave', autoplay);

// Клик по карточке — прокрутка к калькулятору с подставленными параметрами.
carousel.track.addEventListener('click', (e) => {
  const card = e.target.closest('.work');
  if (!card) return;
  const item = carousel.items[+card.dataset.i];
  if (item?.preset) applyPreset(item.preset);
  $('#calc').scrollIntoView({ behavior: 'smooth' });
});

function applyPreset(preset) {
  if (preset.material) $(`#matSeg .seg[data-mat="${preset.material}"]`)?.click();
  if (preset.layer) { $('#layer').value = preset.layer; $('#layer').dispatchEvent(new Event('change')); }
  if (preset.infill) { $('#infill').value = preset.infill; $('#infill').dispatchEvent(new Event('change')); }
}

// Свайп на телефоне
let touchX = null;
carousel.viewport.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
carousel.viewport.addEventListener('touchend', (e) => {
  if (touchX === null) return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 45) go(carousel.page + (dx < 0 ? 1 : -1));
  touchX = null;
});

initCarousel();
