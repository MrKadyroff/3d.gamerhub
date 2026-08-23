// Ждёт первое сообщение боту и записывает chat_id в .env.
// Запуск: npm run tg:chat  →  затем напиши боту /start
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error('Нет TELEGRAM_BOT_TOKEN в .env'); process.exit(1); }

const api = (m, q = '') => fetch(`https://api.telegram.org/bot${TOKEN}/${m}${q}`).then((r) => r.json());

const me = await api('getMe');
console.log(`Бот @${me.result.username}. Напиши ему /start в Telegram…`);

const deadline = Date.now() + 180_000;
let offset = 0;

while (Date.now() < deadline) {
  const upd = await api('getUpdates', `?timeout=25&offset=${offset}`);
  for (const u of upd.result ?? []) {
    offset = u.update_id + 1;
    const chat = (u.message ?? u.channel_post ?? u.my_chat_member)?.chat;
    if (!chat) continue;

    const env = readFileSync('.env', 'utf8').replace(/^TELEGRAM_CHAT_ID=.*$/m, `TELEGRAM_CHAT_ID=${chat.id}`);
    writeFileSync('.env', env);
    console.log(`\n  chat_id = ${chat.id}  (${chat.username ?? chat.title ?? chat.first_name})`);
    console.log('  Записан в .env. Перезапусти сервер: npm start\n');

    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat.id, text: '✅ 3D.GAMERHUB подключён. Заявки с сайта будут приходить сюда.' }),
    });
    process.exit(0);
  }
}
console.error('Не дождался сообщения за 3 минуты. Запусти скрипт снова.');
process.exit(1);
