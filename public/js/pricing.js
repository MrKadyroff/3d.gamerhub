// ─────────────────────────────────────────────────────────────
//  ВСЕ ЦЕНЫ И КОЭФФИЦИЕНТЫ — ЗДЕСЬ. Правь только этот файл.
//  Модуль используется и на фронте, и на сервере (пересчёт заявки).
// ─────────────────────────────────────────────────────────────
export const PRICING = {
  currency: '₸',

  // Пластик: цена за грамм (с учётом износа сопла, брака и т.п.)
  materials: {
    // Себестоимость катушки в Алматы ~8 500 ₸/кг PLA и ~10 000 ₸/кг PETG.
    // Ниже — отпускная цена за грамм материала (время печати считается отдельно).
    PLA:  { label: 'PLA',  pricePerGram: 22, density: 1.24, note: 'Жёсткий, точный, матовый. Для декора, макетов, корпусов.' },
    PETG: { label: 'PETG', pricePerGram: 27, density: 1.27, note: 'Прочнее и термостойче. Для функциональных деталей.' },
  },

  // Режим печати
  modes: {
    single: { label: 'Одним цветом', materialMult: 1.00, timeMult: 1.00, fee: 0 },
    ams:    { label: 'AMS · мультицвет', materialMult: 1.35, timeMult: 1.45, fee: 600,
              perExtraColor: 400 },   // ₸ за каждый цвет сверх второго
  },

  // Высота слоя → качество/скорость
  layers: {
    '0.28': { label: '0.28 мм · черновое', timeMult: 0.75 },
    '0.20': { label: '0.20 мм · стандарт', timeMult: 1.00 },
    '0.12': { label: '0.12 мм · детально', timeMult: 1.55 },
  },

  infills: [
    { value: 0.10, label: '10% · лёгкое, декор' },
    { value: 0.20, label: '20% · стандарт' },
    { value: 0.40, label: '40% · нагруженное' },
    { value: 0.80, label: '80% · максимум прочности' },
  ],

  machineRatePerHour: 700,   // ₸/час работы принтера
  setupFee: 400,             // подготовка модели / нарезка / съём
  minOrder: 1500,            // минимальная сумма заказа (рынок Алматы ~1 500 ₸)
  rushMult: 1.4,             // «срочно, за 24 часа»
  supportsMult: 1.12,        // если нужны поддержки

  qtyDiscounts: [            // от какого количества → множитель
    { from: 25, mult: 0.75 },
    { from: 10, mult: 0.82 },
    { from: 5,  mult: 0.90 },
  ],

  // Физика оценки времени
  throughputMm3PerSec: 10,   // реальная средняя производительность P1S
  startupMinutes: 7,         // прогрев, калибровка, снятие
  wallThicknessCm: 0.12,     // 3 периметра по 0.4

  // Цвета пластика в наличии. hex — как показывать в превью.
  colors: [
    { id: 'white',  label: 'Белый',        hex: '#f2f4f5' },
    { id: 'black',  label: 'Чёрный',       hex: '#1e2126' },
    { id: 'grey',   label: 'Серый',        hex: '#8b939b' },
    { id: 'orange', label: 'Оранжевый',    hex: '#ff7a29' },
    { id: 'red',    label: 'Красный',      hex: '#e03131' },
    { id: 'blue',   label: 'Синий',        hex: '#2f6fed' },
    { id: 'green',  label: 'Зелёный',      hex: '#37b24d' },
    { id: 'yellow', label: 'Жёлтый',       hex: '#fcc419' },
    { id: 'purple', label: 'Фиолетовый',   hex: '#7c4dff' },
    { id: 'silk',   label: 'Шёлк-золото',  hex: '#d4af37', silk: true },
  ],

  // Область построения P1S, мм
  buildVolume: { x: 256, y: 256, z: 256 },
};

/**
 * Расчёт массы материала: оболочка целиком + внутренний объём по заполнению.
 * @param {number} volumeCm3 сплошной объём модели
 * @param {number} areaCm2 площадь поверхности
 */
export function materialVolume(volumeCm3, areaCm2, infill) {
  const shell = Math.min(volumeCm3, areaCm2 * PRICING.wallThicknessCm);
  const inner = Math.max(0, volumeCm3 - shell);
  return shell + inner * infill;
}

/**
 * Главная функция. Возвращает разбивку по стоимости.
 * @param {{volumeCm3:number, areaCm2:number, material:string, mode:string,
 *          colors:number, layer:string, infill:number, qty:number,
 *          supports:boolean, rush:boolean}} o
 */
export function quote(o) {
  const mat = PRICING.materials[o.material] ?? PRICING.materials.PLA;
  const mode = PRICING.modes[o.mode] ?? PRICING.modes.single;
  const layer = PRICING.layers[o.layer] ?? PRICING.layers['0.20'];
  const qty = Math.max(1, o.qty | 0);

  const matVolCm3 = materialVolume(o.volumeCm3, o.areaCm2, o.infill) * mode.materialMult;
  const grams = matVolCm3 * mat.density;

  const seconds = (matVolCm3 * 1000) / PRICING.throughputMm3PerSec * layer.timeMult * mode.timeMult;
  let hours = seconds / 3600 + PRICING.startupMinutes / 60;
  if (o.supports) hours *= PRICING.supportsMult;

  const materialCost = grams * mat.pricePerGram * (o.supports ? PRICING.supportsMult : 1);
  const machineCost = hours * PRICING.machineRatePerHour;
  const colorFee = mode.fee + (mode.perExtraColor ? Math.max(0, (o.colors ?? 2) - 2) * mode.perExtraColor : 0);

  let perItem = materialCost + machineCost + colorFee + PRICING.setupFee;
  if (o.rush) perItem *= PRICING.rushMult;
  perItem = Math.max(perItem, PRICING.minOrder);

  const discount = PRICING.qtyDiscounts.find(d => qty >= d.from)?.mult ?? 1;
  const total = perItem * qty * discount;

  return {
    grams: round(grams, 1),
    hours: round(hours, 2),
    materialCost: Math.round(materialCost),
    machineCost: Math.round(machineCost),
    colorFee: Math.round(colorFee),
    setupFee: PRICING.setupFee,
    discount,
    perItem: Math.round(perItem),
    total: Math.round(total / 50) * 50,
    qty,
  };
}

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

export function fmtMoney(n) {
  return new Intl.NumberFormat('ru-RU').format(Math.round(n)) + ' ' + PRICING.currency;
}

export function fmtTime(h) {
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60), mm = total % 60;
  return hh ? `${hh} ч ${mm} мин` : `${mm} мин`;
}
