import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { openDatabase, migrate } from '../server/db/database.mjs';
import { loadCatalog, projectRoot } from '../server/services/catalog.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { createBookingService, publicSessions } from '../server/services/bookings.mjs';
import { createApp } from '../server/app.mjs';

function fixture(filename = ':memory:') {
  const db = openDatabase(filename); migrate(db); seedSchedule(db, loadCatalog().workshops);
  const session = publicSessions(db).find((s) => new Date(s.startsAt) > new Date());
  const program = loadCatalog().workshops.find((w) => w.id === session.workshopId);
  const input = { sessionId: session.id, quantity: 2, expectedUnitPriceRub: program.priceRub,
    name: 'Тестовый участник', phone: '+7 (900) 000-00-00', email: 'demo@example.test', comment: '',
    privacyConsent: true, policyConsent: true, rulesConsent: true, managementToken: randomBytes(32).toString('hex') };
  return { db, session, program, input, service: createBookingService(db) };
}
test('Цена берётся с сервера, сумма фиксируется, телефон нормализуется; неверная цена отклоняется', () => {
  const { db, service, input, program } = fixture();
  try {
    assert.throws(() => service.create({ ...input, expectedUnitPriceRub: 1 }, randomUUID()), { code: 'PRICE_CHANGED' });
    const { booking } = service.create(input, randomUUID());
    assert.equal(booking.totalRub, program.priceRub * 2); assert.equal(booking.phone, '+79000000000');
    assert.equal(db.prepare('SELECT total_kopecks AS total FROM bookings').get().total, program.priceRub * 200);
    assert.equal(db.prepare('SELECT management_token_hash AS hash FROM bookings').get().hash.length, 64);
    assert.ok(!JSON.stringify(booking).includes(input.managementToken));
  } finally { db.close(); }
});
test('Телефон обязателен на сервере; количество, согласия и подмена полей проверяются', () => {
  const { db, service, input } = fixture();
  try {
    for (const bad of [{ phone: '' }, { phone: '12345' }, { phone: undefined }, { quantity: 1.5 }, { quantity: 0 }, { privacyConsent: false }, { rulesConsent: false }, { unitPriceRub: 1 }]) {
      assert.throws(() => service.create({ ...input, ...bad }, randomUUID()), { code: 'VALIDATION' });
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 0);
  } finally { db.close(); }
});
test('Повтор запроса возвращает ту же бронь; изменение тела не создаёт дубль', () => {
  const { db, service, input } = fixture(); const key = randomUUID();
  try {
    const first = service.create(input, key); const retry = service.create(input, key);
    assert.equal(retry.replayed, true); assert.equal(retry.booking.reference, first.booking.reference);
    assert.throws(() => service.create({ ...input, quantity: 1 }, key), { code: 'REQUEST_CHANGED' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 1);
  } finally { db.close(); }
});
test('Отмена по токену освобождает места ровно один раз, посторонний токен не работает', () => {
  const { db, service, input, session } = fixture();
  try {
    service.create(input, randomUUID());
    assert.equal(publicSessions(db).find((s) => s.id === session.id).available, session.capacity - 2);
    assert.throws(() => service.get('0'.repeat(64)), { code: 'NOT_FOUND' });
    assert.throws(() => service.cancel('0'.repeat(64)), { code: 'NOT_FOUND' });
    assert.equal(service.cancel(input.managementToken).alreadyCancelled, false);
    assert.equal(service.cancel(input.managementToken).alreadyCancelled, true);
    assert.equal(publicSessions(db).find((s) => s.id === session.id).available, session.capacity);
  } finally { db.close(); }
});
test('Прошедшие и отменённые сеансы закрыты; онлайн-отмена после начала закрыта', () => {
  const { db, service, input, session } = fixture();
  try {
    // Понедельник и вторник — выходные: seed не обязан создавать прошедший
    // сеанс в день запуска. Проверка сама задаёт нужное временное состояние.
    const past = { id: `past-${randomUUID()}` };
    db.prepare('INSERT INTO sessions (id,workshop_id,starts_at,ends_at,capacity,created_at) VALUES (?,?,?,?,?,?)')
      .run(past.id, session.workshopId, new Date(Date.now() - 2 * 86400000).toISOString(),
        new Date(Date.now() - 86400000).toISOString(), session.capacity, new Date().toISOString());
    assert.throws(() => service.create({ ...input, sessionId: past.id }, randomUUID()), { code: 'UNAVAILABLE' });
    db.prepare("UPDATE sessions SET status='cancelled' WHERE id=?").run(session.id);
    assert.throws(() => service.create(input, randomUUID()), { code: 'UNAVAILABLE' });
    db.prepare("UPDATE sessions SET status='scheduled' WHERE id=?").run(session.id);
    service.create(input, randomUUID());
    const later = createBookingService(db, { now: () => new Date(session.endsAt) });
    assert.throws(() => later.cancel(input.managementToken), { code: 'TOO_LATE' });
  } finally { db.close(); }
});
test('HTTP: одновременные запросы не превышают вместимость; закрытые данные, Origin и JSON', async () => {
  const { db, input, session } = fixture();
  db.prepare('UPDATE sessions SET capacity=2 WHERE id=?').run(session.id);
  const { app } = createApp({ db, limits: false });
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (body, key = randomUUID(), extra = {}) => fetch(`${base}/bookings`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...extra }, body: JSON.stringify(body) });
  try {
    const key = randomUUID();
    const repeated = await Promise.all([post(input, key), post(input, key)]);
    assert.deepEqual(repeated.map((r) => r.status).sort(), [200, 201]);
    const created = await repeated[0].json();
    const competing = await Promise.all(Array.from({ length: 6 }, () => post({ ...input, quantity: 1, managementToken: randomBytes(32).toString('hex') })));
    assert.ok(competing.every((r) => r.status === 409));
    assert.equal(db.prepare("SELECT SUM(quantity) AS n FROM bookings WHERE status='confirmed'").get().n, 2);
    assert.equal((await fetch(`${base}/bookings/${created.booking.reference}`)).status, 404);
    assert.equal((await fetch(`${base}/bookings/me`)).status, 404);
    assert.equal((await post(input, randomUUID(), { Origin: 'https://example.test' })).status, 403);
    const publicData = await (await fetch(`${base}/sessions`)).text();
    assert.ok(!publicData.includes('phone') && !publicData.includes(input.email) && !publicData.includes('token'));
    const result = await fetch(`${base}/bookings/me`, { headers: { Authorization: `Bearer ${input.managementToken}` } });
    assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
    const cancel = () => fetch(`${base}/bookings/me/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.managementToken}` }, body: '{}' });
    const cancelled = await Promise.all([cancel(), cancel()]);
    assert.ok(cancelled.every((r) => r.status === 200));
    assert.equal(publicSessions(db).find((s) => s.id === session.id).available, 2);
    const racers = [0, 1].map(() => ({ ...input, managementToken: randomBytes(32).toString('hex') }));
    const race = await Promise.all(racers.map((body) => post(body)));
    assert.deepEqual(race.map((r) => r.status).sort(), [201, 409]);
    assert.equal(db.prepare("SELECT SUM(quantity) AS n FROM bookings WHERE status='confirmed'").get().n, 2);
  } finally { await new Promise((resolve) => server.close(resolve)); db.close(); }
});
test('Запись и повтор запроса восстанавливаются после перезапуска HTTP-сервера и открытия SQLite', async () => {
  const root = resolve(projectRoot, '.cache/tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(resolve(root, 'booking-persistence-')); const filename = resolve(directory, 'test.sqlite');
  let state = fixture(filename); const key = randomUUID(); const { input } = state;
  let server;
  async function start() {
    server = createApp({ db: state.db, limits: false }).app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${server.address().port}/api`;
  }
  try {
    let base = await start();
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(input) };
    const first = await (await fetch(`${base}/bookings`, options)).json();
    await new Promise((resolve) => server.close(resolve)); state.db.close();
    state = { db: openDatabase(filename) }; base = await start();
    const second = await (await fetch(`${base}/bookings`, options)).json();
    assert.equal(second.booking.reference, first.booking.reference); assert.equal(second.replayed, true);
    const restored = await (await fetch(`${base}/bookings/me`, { headers: { Authorization: `Bearer ${input.managementToken}` } })).json();
    assert.equal(restored.booking.quantity, 2);
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve)); if (state.db.open) state.db.close();
    if (relative(root, directory).startsWith('..')) throw new Error('Небезопасный путь тестовой базы');
    rmSync(directory, { recursive: true, force: true });
  }
});
