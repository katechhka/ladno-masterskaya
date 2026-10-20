import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase, migrate } from '../server/db/database.mjs';
import { loadCatalog, projectRoot } from '../server/services/catalog.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';

const now = new Date('2026-10-19T08:00:00.000Z');
function fixture() {
  const db = openDatabase(':memory:');
  migrate(db);
  seedSchedule(db, loadCatalog().workshops, { now });
  return db;
}

function addBooking(db, session, quantity = 1, overrides = {}) {
  const id = randomUUID();
  return db.prepare(`INSERT INTO bookings
    (id, reference, session_id, quantity, unit_price_kopecks, total_kopecks, customer_name, phone, email, management_token_hash, consent_version, consent_at, created_at)
    VALUES (@id, @reference, @sessionId, @quantity, @unit, @total, @name, @phone, @email, @token, @consent, @now, @now)`)
    .run({ id, reference: `LD-${id}`, sessionId: session.id, quantity, unit: 200000, total: quantity * 200000,
      name: 'Тестовый участник', phone: '+70000000000', email: 'demo@example.test',
      token: createHash('sha256').update(id).digest('hex'), consent: 'demo-v1', now: now.toISOString(), ...overrides });
}

test('Миграции и наполнение повторяются без удаления брони и сдвига дат', () => {
  const db = fixture();
  try {
    const session = db.prepare('SELECT * FROM sessions ORDER BY starts_at DESC LIMIT 1').get();
    addBooking(db, session);
    const count = db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
    assert.equal(migrate(db), 0);
    const result = seedSchedule(db, loadCatalog().workshops, { now: new Date('2027-01-01T08:00:00.000Z') });
    assert.equal(result.anchorDay, '2026-10-19');
    assert.equal(result.inserted, 0);
    assert.equal(result.total, count);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bookings').get().count, 1);
  } finally { db.close(); }
});

test('База отклоняет превышение вместимости и уменьшение группы ниже занятого', () => {
  const db = fixture();
  try {
    const session = db.prepare('SELECT * FROM sessions LIMIT 1').get();
    addBooking(db, session, session.capacity);
    assert.throws(() => addBooking(db, session), /CAPACITY_EXCEEDED/);
    assert.throws(() => db.prepare('UPDATE sessions SET capacity = ? WHERE id = ?').run(session.capacity - 1, session.id), /CAPACITY_BELOW_BOOKED/);
  } finally { db.close(); }
});

test('Отменённые записи не занимают места; повторная отмена не создаёт лишние', () => {
  const db = fixture();
  try {
    const session = db.prepare('SELECT * FROM sessions LIMIT 1').get();
    addBooking(db, session, session.capacity);
    const cancel = db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE session_id = ? AND status = 'confirmed'");
    assert.equal(cancel.run(now.toISOString(), session.id).changes, 1);
    assert.equal(cancel.run(now.toISOString(), session.id).changes, 0);
    addBooking(db, session, session.capacity);
    assert.throws(() => addBooking(db, session), /CAPACITY_EXCEEDED/);
  } finally { db.close(); }
});

test('База не принимает ошибочную сумму и неизвестный сеанс', () => {
  const db = fixture();
  try {
    const session = db.prepare('SELECT * FROM sessions LIMIT 1').get();
    assert.throws(() => addBooking(db, session, 2, { total: 1 }), /CHECK constraint/);
    assert.throws(() => addBooking(db, { id: 'missing' }), /FOREIGN KEY/);
  } finally { db.close(); }
});

test('Уникальный ключ повторного запроса нельзя привязать ко второй брони', () => {
  const db = fixture();
  try {
    const session = db.prepare('SELECT * FROM sessions LIMIT 1').get();
    addBooking(db, session);
    addBooking(db, session);
    const bookings = db.prepare('SELECT id FROM bookings').all();
    const insert = db.prepare('INSERT INTO idempotency_keys (key, request_hash, booking_id, created_at) VALUES (?, ?, ?, ?)');
    insert.run('same-key', 'a'.repeat(64), bookings[0].id, now.toISOString());
    assert.throws(() => insert.run('same-key', 'a'.repeat(64), bookings[1].id, now.toISOString()), /UNIQUE constraint/);
  } finally { db.close(); }
});

test('Бронь сохраняется при закрытии и повторном открытии файла SQLite', () => {
  const testRoot = resolve(projectRoot, '.cache', 'tests');
  mkdirSync(testRoot, { recursive: true });
  const directory = mkdtempSync(resolve(testRoot, 'ladno-db-test-'));
  const filename = resolve(directory, 'test.sqlite');
  let db;
  try {
    db = openDatabase(filename);
    migrate(db);
    seedSchedule(db, loadCatalog().workshops, { now });
    addBooking(db, db.prepare('SELECT * FROM sessions LIMIT 1').get(), 2);
    db.close();
    db = openDatabase(filename);
    assert.equal(db.prepare('SELECT quantity FROM bookings').get().quantity, 2);
  } finally {
    if (db?.open) db.close();
    // Удаляем только отдельный временный каталог, созданный этим тестом.
    if (!directory.startsWith(`${testRoot}\\`) && !directory.startsWith(`${testRoot}/`)) throw new Error('Путь тестовой базы вне рабочего каталога');
    rmSync(directory, { recursive: true, force: true });
  }
});
