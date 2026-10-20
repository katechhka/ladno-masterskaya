import { flow } from '../db/flow.mjs';
import {createHash, randomBytes} from 'node:crypto';
import {loadCatalog} from './catalog.mjs';
import {BookingError} from './bookings.mjs';
import {ProxyAgent} from 'undici';
import {storedCatalog} from './catalog-store.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
export function telegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const username = process.env.TELEGRAM_BOT_USERNAME || '';
  return {
    token,
    username,
    enabled: (/^\d{5,}:[A-Za-z0-9_-]{20,}$/).test(token) && (/^[A-Za-z0-9_]{5,32}$/).test(username)
  };
}
export function createTelegramService(db, {config = telegramConfig(), now = () => new Date()} = {}) {
  const state = flow(function* state(reference) {
    const row = yield db.prepare('SELECT n.status,n.expires_at FROM bookings b LEFT JOIN telegram_confirmations n ON n.booking_id=b.id WHERE b.reference=?').get(reference);
    return {
      enabled: config.enabled,
      status: row?.status || 'not_requested',
      expired: row?.status === 'pending' && row.expires_at <= now().toISOString()
    };
  });
  const issue = db.transaction(flow(function* (reference) {
    if (!config.enabled) throw new BookingError(503, 'TELEGRAM_NOT_CONFIGURED', 'Telegram пока не подключён. Подтверждение записи доступно на сайте.');
    const booking = yield db.prepare('SELECT id,status,data_erased_at FROM bookings WHERE reference=?').get(reference);
    if (!booking || booking.status !== 'confirmed' || booking.data_erased_at) throw new BookingError(409, 'BOOKING_CANCELLED', 'Запись отменена или согласие отозвано. Подтверждение не отправляется.');
    const current = yield state(reference);
    if (['sent', 'sending', 'unknown'].includes(current.status)) return {
      ...current,
      url: null
    };
    const token = randomBytes(32).toString('hex');
    const timestamp = now().toISOString();
    yield db.prepare(`INSERT INTO telegram_confirmations (booking_id,token_hash,expires_at,status,updated_at) VALUES (?,?,?,'pending',?)
      ON CONFLICT(booking_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,
      status='pending',chat_id=NULL,message_id=NULL,error_code=NULL,updated_at=excluded.updated_at`).run(booking.id, hash(token), new Date(now().getTime() + 15 * 60000).toISOString(), timestamp);
    return {
      ...yield state(reference),
      url: `https://t.me/${config.username}?start=${token}`
    };
  }));
  const claim = db.transaction(flow(function* (token, chatId) {
    const row = yield db.prepare(`SELECT n.booking_id,n.status,n.expires_at,b.reference,b.quantity,b.total_kopecks,
      b.status AS booking_status,s.workshop_id,s.starts_at FROM telegram_confirmations n
      JOIN bookings b ON b.id=n.booking_id JOIN sessions s ON s.id=b.session_id WHERE n.token_hash=?`).get(hash(token));
    if (!row || row.status !== 'pending' || row.expires_at <= now().toISOString()) return null;
    yield db.prepare("UPDATE telegram_confirmations SET status='sending',chat_id=?,updated_at=? WHERE booking_id=?").run(String(chatId), now().toISOString(), row.booking_id);
    return row;
  }));
  async function handleUpdate(update, sendMessage) {
    const message = update?.message;
    if (message?.chat?.type !== 'private' || !Number.isSafeInteger(message.chat.id)) return false;
    const match = message.text?.match(/^\/start(?:@[A-Za-z0-9_]+)? ([a-f0-9]{64})$/);
    if (!match) return false;
    const row = await claim.immediate(match[1], message.chat.id);
    if (!row) return false;
    const date = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      dateStyle: 'long',
      timeStyle: 'short'
    }).format(new Date(row.starts_at));
    try {
      const program = ((await storedCatalog(db, {
        includeArchived: true
      })).workshops.length ? await storedCatalog(db, {
        includeArchived: true
      }) : loadCatalog()).workshops.find(w => w.id === row.workshop_id);
      const text = [`Ладно · демонстрационная мастерская`, row.booking_status === 'cancelled' ? 'Запись отменена.' : 'Ваша запись подтверждена.', `Бронь ${row.reference}`, program?.title || 'Мастер-класс', `${date} (Тула)`, `Участников: ${row.quantity}`, `Сумма: ${row.total_kopecks / 100} ₽. Оплата на месте после мастер-класса.`, 'Это портфолио-проект: реального занятия и оплаты нет.', 'Управление и отмена — по персональной ссылке, сохранённой на сайте.'].join('\n');
      const result = await sendMessage({
        chat_id: message.chat.id,
        text,
        protect_content: true
      });
      if (!Number.isSafeInteger(result?.message_id)) throw new Error('UNKNOWN_RESULT');
      await db.prepare("UPDATE telegram_confirmations SET status='sent',message_id=?,updated_at=? WHERE booking_id=?").run(String(result.message_id), now().toISOString(), row.booking_id);
    } catch (error) {
      await db.prepare('UPDATE telegram_confirmations SET status=?,error_code=?,updated_at=? WHERE booking_id=?').run(error.definitelyRejected ? 'failed' : 'unknown', error.definitelyRejected ? 'PROVIDER_REJECTED' : 'UNKNOWN_RESULT', now().toISOString(), row.booking_id);
    }
    return true;
  }
  return {
    state,
    issue: flow(function* (reference) {
      return yield issue.immediate(reference);
    }),
    handleUpdate,
    recoverInterrupted: flow(function* () {
      return yield db.prepare("UPDATE telegram_confirmations SET status='unknown',error_code='INTERRUPTED',updated_at=? WHERE status='sending'").run(now().toISOString());
    })
  };
}
export function telegramClient(token, {fetchImpl = fetch, proxyUrl = process.env.TELEGRAM_PROXY_URL || ''} = {}) {
  let dispatcher;
  try {
    if (proxyUrl) dispatcher = new ProxyAgent(proxyUrl);
  } catch {
    throw new Error('Неверный адрес прокси Telegram.');
  }
  const request = async (method, data, signal) => {
    let response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(data),
        ...dispatcher ? {
          dispatcher
        } : {},
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(12000)
      });
      const json = await response.json();
      if (!json.ok) throw Object.assign(new Error('Telegram отклонил запрос'), {
        definitelyRejected: true
      });
      return json.result;
    } catch (error) {
      throw Object.assign(new Error('Не удалось выполнить запрос Telegram'), {
        definitelyRejected: Boolean(error.definitelyRejected)
      });
    }
  };
  request.close = async () => {
    await dispatcher?.close();
  };
  return request;
}
