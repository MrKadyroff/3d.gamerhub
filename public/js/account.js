// ─────────────────────────────────────────────────────────────
//  Личный кабинет: история заказов в браузере клиента.
//  Ничего не требует от него — ни регистрации, ни пароля.
// ─────────────────────────────────────────────────────────────
const KEY = 'gamerhub.orders';
const LIMIT = 20;          // localStorage не резиновый: держим последние 20

export const STATUS_UI = {
  new:      { label: 'Отправлена', hint: 'Ждём подтверждения', cls: 'st--new' },
  accepted: { label: 'Принята',    hint: 'Заказ в очереди',    cls: 'st--ok' },
  printing: { label: 'Печатается', hint: 'Принтер работает',   cls: 'st--run' },
  done:     { label: 'Готова',     hint: 'Можно забирать',     cls: 'st--done' },
  declined: { label: 'Отклонена',  hint: 'Напишите нам',       cls: 'st--bad' },
};

export function all() {
  try { return JSON.parse(localStorage.getItem(KEY)) ?? []; } catch { return []; }
}

export function save(order) {
  const list = [order, ...all().filter((o) => o.id !== order.id)].slice(0, LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Переполнение — выкидываем превью у старых записей и пробуем ещё раз.
    const light = list.map((o, i) => (i ? { ...o, thumb: null } : o));
    try { localStorage.setItem(KEY, JSON.stringify(light)); } catch { /* сдаёмся молча */ }
  }
  return list;
}

export function remove(id) {
  const list = all().filter((o) => o.id !== id);
  localStorage.setItem(KEY, JSON.stringify(list));
  return list;
}

/** Подтягивает актуальные статусы с сервера. */
export async function refreshStatuses() {
  const list = all();
  if (!list.length) return list;
  try {
    const res = await fetch('/api/status?ids=' + list.map((o) => o.id).join(','));
    const map = await res.json();
    const next = list.map((o) => ({ ...o, status: map[o.id] ?? o.status ?? 'new' }));
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch {
    return list;   // офлайн — показываем что есть
  }
}

/**
 * Сжимает превью до миниатюры, иначе localStorage забьётся за пару заказов.
 * Декодирование может зависнуть — поэтому с таймаутом: миниатюра приятна,
 * но заказ важнее, и ждать её вечно нельзя.
 */
export async function thumbnail(blob, size = 260, timeoutMs = 4000) {
  if (!blob) return null;
  const bmp = await Promise.race([
    createImageBitmap(blob),
    new Promise((_, rej) => setTimeout(() => rej(new Error('decode timeout')), timeoutMs)),
  ]);
  const scale = size / Math.max(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL('image/jpeg', 0.72);
}

export function formatDate(iso) {
  return new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
