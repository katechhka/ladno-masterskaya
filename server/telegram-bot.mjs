import { openDatabase, migrate } from './db/database.mjs';
import { telegramClient, telegramConfig } from './services/telegram.mjs';
import { runTelegramBot } from './services/telegram-worker.mjs';

const config = telegramConfig();
if (!config.enabled) throw new Error('Заполните TELEGRAM_BOT_TOKEN и TELEGRAM_BOT_USERNAME в .env. Инструкция: docs/TELEGRAM.md');
const db = openDatabase(); migrate(db);
const client = telegramClient(config.token); const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => controller.abort());
console.log('Проверяем бота и запускаем обработчик подтверждений.');
try {
  await runTelegramBot({ db, config, client, signal: controller.signal,
    onReady: () => console.log('Бот подключён. Ожидаем команды /start.'),
    onUpdate: ({ privateChat, start, hasCode, handled }) => console.log(`Telegram: private=${privateChat}, start=${start}, code=${hasCode}, handled=${handled}`),
    onError: () => console.error('Telegram временно недоступен. Проверяем соединение повторно.') });
} finally { await client.close(); db.close(); }
