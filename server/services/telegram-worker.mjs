import { setTimeout as delay } from 'node:timers/promises';
import { createTelegramService } from './telegram.mjs';

export async function runTelegramBot({ db, config, client, signal, onError = () => {}, onUpdate = () => {}, onReady = () => {} }) {
  const identity = await client('getMe', {}, signal);
  if (!identity?.is_bot || identity.username?.toLowerCase() !== config.username.toLowerCase()) throw new Error('Имя TELEGRAM_BOT_USERNAME не соответствует токену. Проверьте настройки бота.');
  const service = createTelegramService(db, { config }); service.recoverInterrupted();
  onReady();
  const offsetKey = `telegram_update_offset:${config.token.split(':')[0]}`;
  let offset = Number(db.prepare('SELECT value FROM app_metadata WHERE key=?').get(offsetKey)?.value || 0);
  while (!signal.aborted) {
    try {
      const updates = await client('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, signal);
      if (!Array.isArray(updates)) throw new Error('INVALID_UPDATES');
      for (const update of updates) {
        if (!Number.isSafeInteger(update.update_id)) continue;
        const handled = await service.handleUpdate(update, (body) => client('sendMessage', body));
        onUpdate({ privateChat: update.message?.chat?.type === 'private', start: Boolean(update.message?.text?.startsWith('/start')), hasCode: /^\/start(?:@\w+)? [a-f0-9]{64}$/.test(update.message?.text || ''), handled });
        if (!handled && update.message?.chat?.type === 'private' && Number.isSafeInteger(update.message.chat.id) && /^\/start(?:@[A-Za-z0-9_]+)?(?: \S+)?$/.test(update.message.text || '')) {
          await client('sendMessage', { chat_id: update.message.chat.id, text: 'Чтобы получить подтверждение, откройте персональную страницу брони на сайте и нажмите «Получить в Telegram». Ссылка действует 15 минут. Если подтверждение уже получено, оно находится выше в этом чате.' });
        }
        offset = Math.max(offset, update.update_id + 1);
        db.prepare('INSERT INTO app_metadata (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(offsetKey, String(offset));
      }
    } catch {
      if (signal.aborted) break;
      onError();
      await delay(3000, undefined, { signal }).catch(() => {});
    }
  }
}
