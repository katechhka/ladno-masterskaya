import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { openDatabase, migrate } from '../server/db/database.mjs';
import { loadCatalog } from '../server/services/catalog.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { createBookingService, publicSessions } from '../server/services/bookings.mjs';
import { createTelegramService, telegramClient } from '../server/services/telegram.mjs';
import { createApp } from '../server/app.mjs';
import { runTelegramBot } from '../server/services/telegram-worker.mjs';

export const testConfig = { enabled: true, token: '123456:local_test_token_never_sent_to_telegram', username: 'ladno_test_bot' };
function fixture(t) {
  const db = openDatabase(':memory:'); migrate(db); seedSchedule(db, loadCatalog().workshops); t.after(() => db.close());
  const session = publicSessions(db).find((s) => new Date(s.startsAt) > new Date());
  const program = loadCatalog().workshops.find((w) => w.id === session.workshopId);
  const managementToken = randomBytes(32).toString('hex');
  const booking = createBookingService(db).create({ sessionId: session.id, quantity: 1, expectedUnitPriceRub: program.priceRub,
    name: 'Тестовый гость', phone: '+79000000000', email: 'demo@example.test', comment: 'Не передавать',
    privacyConsent: true, policyConsent: true, rulesConsent: true, managementToken }, randomUUID()).booking;
  const service = createTelegramService(db, { config: testConfig });
  return { db, booking, service, managementToken };
}
const startToken = (result) => new URL(result.url).searchParams.get('start');
const update = (token, type = 'private') => ({ update_id: 1, message: { text: `/start ${token}`, chat: { id: 1234567, type } } });

test('Telegram-ссылка одноразовая, ограничена по времени и не содержит токен управления', (t) => {
  const { db, booking, service, managementToken } = fixture(t);
  const result = service.issue(booking.reference); const token = startToken(result);
  assert.equal(token.length, 64); assert.ok(!result.url.includes(managementToken));
  const stored = db.prepare('SELECT * FROM telegram_confirmations').get();
  assert.equal(stored.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(stored).includes(token)); assert.ok(new Date(stored.expires_at) > new Date());
});
test('Два одновременных /start отправляют одно подтверждение без телефона и email', async (t) => {
  const { booking, service } = fixture(t); const token = startToken(service.issue(booking.reference)); const calls = [];
  const send = async (body) => { calls.push(body); return { message_id: 10 }; };
  await Promise.all([service.handleUpdate(update(token), send), service.handleUpdate(update(token), send)]);
  assert.equal(calls.length, 1); assert.ok(calls[0].text.includes(booking.reference));
  assert.ok(calls[0].text.includes('подтверждена')); assert.ok(calls[0].text.includes('демонстрационная'));
  assert.ok(!calls[0].text.includes(booking.phone) && !calls[0].text.includes(booking.email) && !calls[0].text.includes('Не передавать'));
  assert.equal(service.state(booking.reference).status, 'sent'); assert.equal(service.issue(booking.reference).url, null);
});
test('Чужая, истёкшая и заменённая ссылка и групповой чат не получают подтверждение', async (t) => {
  const { db, booking, service } = fixture(t); let calls = 0; const send = async () => { calls++; return { message_id: 11 }; };
  const old = startToken(service.issue(booking.reference)); const current = startToken(service.issue(booking.reference));
  assert.equal(await service.handleUpdate(update(old), send), false);
  assert.equal(await service.handleUpdate(update('0'.repeat(64)), send), false);
  assert.equal(await service.handleUpdate(update(current, 'group'), send), false);
  db.prepare('UPDATE telegram_confirmations SET expires_at=?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal(await service.handleUpdate(update(current), send), false); assert.equal(calls, 0);
});
test('Неизвестный результат не повторяется, прерванная отправка помечается явно', async (t) => {
  const { db, booking, service } = fixture(t); const token = startToken(service.issue(booking.reference)); let calls = 0;
  const send = async () => { calls++; throw new Error('TIMEOUT'); };
  await service.handleUpdate(update(token), send); await service.handleUpdate(update(token), send);
  assert.equal(calls, 1); assert.equal(service.state(booking.reference).status, 'unknown'); assert.equal(service.issue(booking.reference).url, null);
  db.prepare("UPDATE telegram_confirmations SET status='sending'").run(); service.recoverInterrupted();
  assert.equal(service.state(booking.reference).status, 'unknown');
});
test('Явный отказ Telegram допускает новую попытку; отменённая бронь не выдаётся за подтверждённую', async (t) => {
  const { db, booking, service } = fixture(t); const token = startToken(service.issue(booking.reference));
  await service.handleUpdate(update(token), async () => { throw Object.assign(new Error('REJECTED'), { definitelyRejected: true }); });
  assert.equal(service.state(booking.reference).status, 'failed');
  const retry = startToken(service.issue(booking.reference)); assert.notEqual(token, retry);
  db.prepare("UPDATE bookings SET status='cancelled',cancelled_at=?").run(new Date().toISOString());
  let text; await service.handleUpdate(update(retry), async (body) => { text = body.text; return { message_id: 12 }; });
  assert.ok(text.includes('отменена')); assert.ok(!text.includes('подтверждена'));
});
test('API Telegram требует персональный токен; без настройки не сообщает об отправке', async (t) => {
  const { db, managementToken } = fixture(t);
  const { app } = createApp({ db, limits: false, telegramConfig: { enabled: false } });
  const server = app.listen(0, '127.0.0.1'); await new Promise((done) => server.once('listening', done));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/bookings/me/telegram`;
    assert.equal((await fetch(base)).status, 404);
    const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${managementToken}` }, body: '{}' });
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'TELEGRAM_NOT_CONFIGURED');
  } finally { await new Promise((done) => server.close(done)); }
});
test('Клиент Telegram использует POST и скрывает токен и ответ провайдера в ошибке', async () => {
  const client = telegramClient('private-test-token', { proxyUrl: '', fetchImpl: async (_url, options) => {
    assert.equal(options.method, 'POST'); assert.equal(JSON.parse(options.body).chat_id, 1);
    return { json: async () => ({ ok: false, description: 'private-test-token' }) };
  } });
  await assert.rejects(client('sendMessage', { chat_id: 1, text: 'Тест' }), (error) => error.definitelyRejected && !error.message.includes('private-test-token'));
});
test('Прокси применяется только к Telegram-клиенту, закрывается и не раскрывает настройки в ошибке', async () => {
  const client = telegramClient('test-token', { proxyUrl: 'http://127.0.0.1:9', fetchImpl: async (_url, options) => {
    assert.ok(options.dispatcher); return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  } });
  try { assert.equal((await client('sendMessage', { chat_id: 1, text: 'Локальный тест' })).message_id, 1); }
  finally { await client.close(); }
  assert.throws(() => telegramClient('test-token', { proxyUrl: 'invalid-proxy-address' }), { message: 'Неверный адрес прокси Telegram.' });
});
test('Обработчик проверяет бота, получает /start, отправляет подтверждение и сохраняет offset', async (t) => {
  const { db, booking, service } = fixture(t); const token = startToken(service.issue(booking.reference));
  let confirmations = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    await runTelegramBot({ db, config: testConfig, signal: controller.signal, client: async (method, data) => {
      if (method === 'getMe') return { is_bot: true, username: testConfig.username };
      if (method === 'getUpdates') { assert.equal(data.offset, attempt ? 11 : 0); return [{ ...update(token), update_id: 10 }]; }
      assert.equal(method, 'sendMessage'); if (data.text.includes(booking.reference)) confirmations++;
      controller.abort(); return { message_id: 42 };
    } });
    assert.equal(db.prepare("SELECT value FROM app_metadata WHERE key='telegram_update_offset:123456'").get().value, '11');
  }
  assert.equal(confirmations, 1); assert.equal(service.state(booking.reference).status, 'sent');
});
test('Обработчик не опрашивает и не отправляет сообщения при несовпадении имени бота', async (t) => {
  const { db } = fixture(t); let calls = 0;
  await assert.rejects(runTelegramBot({ db, config: testConfig, signal: new AbortController().signal,
    client: async (method) => { calls++; assert.equal(method, 'getMe'); return { is_bot: true, username: 'wrong_bot' }; } }), /не соответствует/);
  assert.equal(calls, 1);
});
