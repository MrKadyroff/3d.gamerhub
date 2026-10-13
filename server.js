// ─────────────────────────────────────────────────────────────
//  Сервер: отдаёт лендинг, принимает заявки, сохраняет модели,
//  шлёт карточку заказа в Telegram.
// ─────────────────────────────────────────────────────────────
import 'dotenv/config';
import compression from 'compression';
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quote, fmtMoney, fmtTime, PRICING } from './public/js/pricing.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const UPLOADS = join(ROOT, 'uploads');
const PORT = process.env.PORT || 3000;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHATS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map((x) => x.trim()).filter(Boolean);
const MAX_MB = Number(process.env.MAX_UPLOAD_MB || 60);

await mkdir(UPLOADS, { recursive: true });

const ALLOWED = new Set(['.stl', '.obj', '.3mf']);
const upload = multer({
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 2 },
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, file, cb) => {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const ext = file.fieldname === 'preview' ? '.png' : extname(file.originalname).toLowerCase();
      cb(null, `${stamp}__${randomUUID().slice(0, 8)}${ext}`);
    },
  }),
  fileFilter: (req, file, cb) => {
    // preview — это PNG-снимок вьювера, модель — STL/OBJ/3MF.
    const ok = file.fieldname === 'preview'
      ? file.mimetype === 'image/png'
      : ALLOWED.has(extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Разрешены только STL, OBJ и 3MF'), ok);
  },
});

// ── Статусы заказов ──────────────────────────────────────────
//  Меняются кнопками в Telegram, читаются личным кабинетом клиента.
const STATUS_FILE = join(UPLOADS, 'status.json');
export const STATUSES = {
  new:      { label: 'Отправлена',  emoji: '🆕' },
  accepted: { label: 'Принята',     emoji: '✅' },
  printing: { label: 'Печатается',  emoji: '🖨' },
  done:     { label: 'Готова',      emoji: '📦' },
  declined: { label: 'Отклонена',   emoji: '🚫' },
};

let statuses = {};
try { statuses = JSON.parse(await readFile(STATUS_FILE, 'utf8')); } catch { /* первый запуск */ }

async function setStatus(id, code) {
  statuses[id] = { code, at: new Date().toISOString() };
  await writeFile(STATUS_FILE, JSON.stringify(statuses, null, 2));
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);          // за nginx: чтобы видеть реальный IP клиента

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// gzip: three.js и остальной JS ужимаются в 3–4 раза — главный выигрыш при первой загрузке.
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '256kb' }));
// Кэширование: код и разметку браузер обязан перепроверять на каждой загрузке,
// иначе после обновления сайта у людей остаётся старый JS и страница ломается.
// Картинки и вендорные библиотеки меняются редко — их держим долго.
app.use(express.static(join(ROOT, 'public'), {
  etag: true,
  setHeaders(res, path) {
    if (/\.(html|js|css|json)$/.test(path) && !path.includes('/vendor/')) {
      res.setHeader('Cache-Control', 'no-cache');      // 304 при отсутствии изменений
    } else {
      res.setHeader('Cache-Control', 'public, max-age=2592000');
    }
  },
}));

// ── Ограничение частоты ──────────────────────────────────────
//  Без него один скрипт завалит Telegram спамом и забьёт диск
//  шестидесятимегабайтными файлами.
const hits = new Map();

function rateLimit({ windowMs, max, message }) {
  return (req, res, next) => {
    const key = req.ip + ':' + req.path;
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now > rec.reset) {
      hits.set(key, { count: 1, reset: now + windowMs });
      return next();
    }
    if (++rec.count > max) {
      res.setHeader('Retry-After', Math.ceil((rec.reset - now) / 1000));
      return res.status(429).json({ ok: false, error: message });
    }
    next();
  };
}

// Раз в 10 минут подчищаем счётчики, чтобы Map не рос бесконечно.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 600_000).unref();

const uploadFields = upload.fields([{ name: 'model', maxCount: 1 }, { name: 'preview', maxCount: 1 }]);

app.post('/api/order',
  rateLimit({ windowMs: 15 * 60_000, max: 6, message: 'Слишком много заявок подряд. Напишите в Telegram или WhatsApp.' }),
  uploadFields,
  async (req, res) => {
  try {
    const o = JSON.parse(req.body.order || '{}');
    // Единственное обязательное поле — контакт (телефон или @ник).
    if (!o.contact) return res.status(400).json({ ok: false, error: 'Нужен номер телефона' });

    // Цену пересчитываем на сервере — фронту не доверяем.
    const server = quote({
      volumeCm3: +o.volumeCm3 || 0, areaCm2: +o.areaCm2 || 0,
      material: o.material, mode: o.mode, colors: +o.colors || 1,
      layer: o.layer, infill: +o.infill || 0.2, qty: +o.qty || 1,
      supports: !!o.supports, rush: !!o.rush,
    });

    const id = Date.now().toString(36).toUpperCase().slice(-6);
    const record = {
      id, at: new Date().toISOString(),
      name: o.name || 'Без имени', contact: o.contact, comment: o.comment || '',
      originalName: o.fileName,
      storedName: req.files?.model?.[0]?.filename ?? null,
      previewName: req.files?.preview?.[0]?.filename ?? null,
      params: {
        material: o.material, mode: o.mode, colors: o.colors, layer: o.layer,
        infill: o.infill, qty: o.qty, supports: o.supports, rush: o.rush,
        scale: o.scale, size: o.size, color: o.color,
        source: o.source || 'upload', makerText: o.makerText, makerStyle: o.makerStyle,
      },
      clientQuote: o.quote, serverQuote: server,
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    };
    await appendFile(join(UPLOADS, 'orders.jsonl'), JSON.stringify(record) + '\n');

    notifyTelegram(record, req.files?.model?.[0], req.files?.preview?.[0]).catch((e) => console.error('telegram:', e.message));
    res.json({ ok: true, id, total: server.total });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Личный кабинет спрашивает статусы по своим id (они у него в localStorage).
app.get('/api/status', rateLimit({ windowMs: 60_000, max: 60, message: 'Слишком часто' }), (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 50);
  const out = {};
  for (const id of ids) out[id] = statuses[id]?.code ?? 'new';
  res.json(out);
});

app.get('/healthz', (req, res) => res.json({
  ok: true,
  telegram: Boolean(TG_TOKEN && TG_CHATS.length),
  uptime: Math.round(process.uptime()),
}));

app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ ok: false, error: err.message });
  next();
});

async function notifyTelegram(r, file, preview) {
  if (!TG_TOKEN || !TG_CHATS.length) return console.warn('Telegram не настроен — заявка только в orders.jsonl');
  const p = r.params, q = r.serverQuote;
  const s = p.size ? `${p.size.x.toFixed(1)} × ${p.size.y.toFixed(1)} × ${p.size.z.toFixed(1)} мм` : '—';

  const text = [
    `🖨 <b>Заявка №${r.id}</b>`,
    ``,
    `👤 <b>${esc(r.name)}</b>`,
    `📞 ${esc(r.contact)}`,
    r.comment ? `💬 ${esc(r.comment)}` : '',
    ``,
    p.source === 'maker'
      ? `🎮 <b>Конструктор:</b> ${esc(p.makerStyle || '')} «${esc(p.makerText || '')}»`
      : `📦 <code>${esc(r.originalName || '—')}</code>`,
    `📐 ${s} · масштаб ${Math.round((p.scale || 1) * 100)}%`,
    `🧵 ${p.material}${p.color ? ` · ${esc(p.color)}` : ''} · ${PRICING.modes[p.mode]?.label ?? p.mode}${p.mode === 'ams' ? ` (${p.colors} цв.)` : ''}`,
    `⚙️ слой ${p.layer} мм · заполнение ${Math.round(p.infill * 100)}%`,
    [p.supports ? 'поддержки' : '', p.rush ? '🔥 СРОЧНО 24ч' : ''].filter(Boolean).join(' · '),
    ``,
    `⚖️ ${q.grams} г · ⏱ ${fmtTime(q.hours)}${q.qty > 1 ? ` × ${q.qty} шт` : ''}`,
    `💰 <b>${fmtMoney(q.total)}</b>${q.qty > 1 ? ` (${fmtMoney(q.perItem)} / шт)` : ''}`,
  ].filter((l) => l !== undefined).join('\n');

  // Кнопки: написать клиенту в один тап прямо из уведомления.
  const buttons = [];
  const nick = String(r.contact).match(/@([A-Za-z0-9_]{4,})/);
  if (nick) buttons.push({ text: '✍️ Написать в Telegram', url: `https://t.me/${nick[1]}` });
  const phone = String(r.contact).replace(/[^\d+]/g, '');
  if (phone.length >= 10) {
    buttons.push({ text: '💬 WhatsApp', url: `https://wa.me/${phone.replace(/^\+/, '')}` });
  }
  const markup = { inline_keyboard: [...(buttons.length ? [buttons] : []), statusRow(r.id, 'new')] };

  for (const chat of TG_CHATS) await sendTo(chat, { text, markup, r, file, preview });
}

/** Отправляет один комплект: фото с карточкой, кнопки, файл модели. */
async function sendTo(TG_CHAT, { text, markup, r, file, preview }) {
  if (preview) {
    // Фото модели + вся карточка в подписи: видно суть, не открывая файл.
    const form = new FormData();
    form.append('chat_id', TG_CHAT);
    form.append('photo', await streamToBlob(join(UPLOADS, preview.filename)), 'preview.png');
    form.append('caption', text.slice(0, 1024));
    form.append('parse_mode', 'HTML');
    if (markup) form.append('reply_markup', JSON.stringify(markup));
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, { method: 'POST', body: form });
    if (!res.ok) {
      // Не прошло фото — карточка всё равно должна дойти.
      console.error('sendPhoto:', await res.text());
      await tg('sendMessage', { chat_id: TG_CHAT, text, parse_mode: 'HTML', reply_markup: markup });
    }
  } else {
    await tg('sendMessage', { chat_id: TG_CHAT, text, parse_mode: 'HTML', reply_markup: markup });
  }

  if (file) {
    const form = new FormData();
    form.append('chat_id', TG_CHAT);
    form.append('caption', `Модель к заявке №${r.id}`);
    form.append('document', await streamToBlob(join(UPLOADS, file.filename)), r.originalName || file.filename);
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: 'POST', body: form });
    if (!res.ok) console.error('sendDocument:', await res.text());
  }
}

/** Ряд кнопок смены статуса; текущий помечен точкой. */
function statusRow(id, current) {
  return [['accepted', '✅ Принял'], ['printing', '🖨 Печатаю'], ['done', '📦 Готов']]
    .map(([code, label]) => ({
      text: current === code ? `• ${label}` : label,
      callback_data: `st:${id}:${code}`,
    }));
}

/** Длинный опрос: ловим нажатия кнопок и обновляем статус заказа. */
async function pollCallbacks() {
  if (!TG_TOKEN || !TG_CHATS.length) return;
  let offset = 0;
  for (;;) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates?timeout=30&offset=${offset}&allowed_updates=["callback_query"]`);
      const data = await r.json();
      for (const u of data.result ?? []) {
        offset = u.update_id + 1;
        const cb = u.callback_query;
        if (!cb?.data?.startsWith('st:')) continue;

        const [, id, code] = cb.data.split(':');
        if (!STATUSES[code]) continue;
        await setStatus(id, code);

        await tg('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: `Заявка №${id}: ${STATUSES[code].label}`,
        });
        await tg('editMessageReplyMarkup', {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          reply_markup: { inline_keyboard: [...cb.message.reply_markup.inline_keyboard.slice(0, -1), statusRow(id, code)] },
        }).catch(() => {});
        console.log(`Заявка №${id} → ${STATUSES[code].label}`);
      }
    } catch (e) {
      console.error('poll:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${method}: ${res.status} ${await res.text()}`);
}

async function streamToBlob(path) {
  const chunks = [];
  for await (const c of createReadStream(path)) chunks.push(c);
  return new Blob([Buffer.concat(chunks)]);
}

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

pollCallbacks();

const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`\n  3D.GAMERHUB → http://localhost:${PORT}`);
  console.log(`  Telegram: ${TG_TOKEN && TG_CHATS.length ? `настроен ✓ (${TG_CHATS.join(', ')})` : 'НЕ настроен (см. .env.example)'}`);
  console.log(`  Заявки:   uploads/orders.jsonl\n`);
});
