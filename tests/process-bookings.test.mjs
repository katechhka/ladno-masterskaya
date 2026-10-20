import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { processFixture, request } from './helpers/process-fixture.mjs';

test('Четыре Node.js-процесса: 48 разных запросов занимают ровно три места', { timeout: 45000 }, async (t) => {
  const fixture = await processFixture(t, 3);
  const servers = await Promise.all(Array.from({ length: 4 }, () => fixture.start()));
  const results = await Promise.all(Array.from({ length: 48 }, (_, index) => request(servers[index % 4], '/bookings', { body: fixture.input(), key: randomUUID() })));
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.equal(results.filter((r) => r.status === 409 && r.data.error.code === 'NO_SEATS').length, 45);
  assert.deepEqual(fixture.inspect((db) => db.prepare("SELECT COUNT(*) AS bookings, SUM(quantity) AS quantity FROM bookings WHERE status='confirmed'").get()), { bookings: 3, quantity: 3 });
  const sessions = await request(servers[0], '/sessions');
  assert.equal(sessions.data.sessions[0].available, 0);
});

test('Четыре процесса и общий ключ: 16 запросов создают одну бронь', { timeout: 45000 }, async (t) => {
  const fixture = await processFixture(t);
  const servers = await Promise.all(Array.from({ length: 4 }, () => fixture.start()));
  const body = fixture.input(2); const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) => request(servers[index % 4], '/bookings', { body, key })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 200 && r.data.replayed).length, 15);
  assert.equal(new Set(results.map((r) => r.data.booking.reference)).size, 1);
  assert.equal(fixture.inspect((db) => db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get().n), 1);
  assert.equal((await request(servers[0], '/sessions')).data.sessions[0].available, 1);
});

test('Два процесса и один ключ с разным телом: побеждает только один запрос', { timeout: 30000 }, async (t) => {
  const fixture = await processFixture(t);
  const servers = await Promise.all([fixture.start(), fixture.start()]); const key = randomUUID();
  const body = fixture.input();
  const results = await Promise.all(servers.map((server, index) => request(server, '/bookings', { body: { ...body, quantity: index + 1 }, key })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(results.find((r) => r.status === 409).data.error.code, 'REQUEST_CHANGED');
  assert.equal(fixture.inspect((db) => db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n), 1);
});

test('Параллельная отмена и повтор старого запроса не восстанавливают отменённую бронь', { timeout: 45000 }, async (t) => {
  const fixture = await processFixture(t, 2);
  const servers = await Promise.all(Array.from({ length: 4 }, () => fixture.start()));
  const body = fixture.input(2); const key = randomUUID();
  const first = await request(servers[0], '/bookings', { body, key }); assert.equal(first.status, 201);
  const cancellations = await Promise.all(Array.from({ length: 12 }, (_, index) => request(servers[index % 4], '/bookings/me/cancel', { body: {}, token: body.managementToken })));
  assert.ok(cancellations.every((r) => r.status === 200 && r.data.booking.status === 'cancelled'));
  assert.equal(cancellations.filter((r) => !r.data.alreadyCancelled).length, 1);
  const repeated = await request(servers[1], '/bookings', { body, key });
  assert.equal(repeated.status, 200); assert.equal(repeated.data.booking.status, 'cancelled');
  assert.equal(repeated.data.booking.reference, first.data.booking.reference);
  const replacement = await request(servers[2], '/bookings', { body: fixture.input(2), key: randomUUID() }); assert.equal(replacement.status, 201);
  await request(servers[3], '/bookings/me/cancel', { body: {}, token: body.managementToken });
  assert.equal((await request(servers[0], '/sessions')).data.sessions[0].available, 0);
  assert.equal(fixture.inspect((db) => db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n), 2);
});

test('Принудительная остановка Node.js: бронь, цена, токен и идемпотентность сохраняются', { timeout: 45000 }, async (t) => {
  const fixture = await processFixture(t, 2); const body = fixture.input(2); const key = randomUUID();
  let server = await fixture.start();
  const first = await request(server, '/bookings', { body, key }); assert.equal(first.status, 201);
  await server.stop('SIGKILL');
  server = await fixture.start();
  const restored = await request(server, '/bookings/me', { token: body.managementToken });
  assert.equal(restored.status, 200); assert.equal(restored.data.booking.reference, first.data.booking.reference);
  assert.equal(restored.data.booking.totalRub, fixture.program.priceRub * 2);
  assert.equal(restored.data.booking.phone, body.phone);
  const repeat = await request(server, '/bookings', { body, key }); assert.equal(repeat.status, 200); assert.equal(repeat.data.replayed, true);
  assert.equal((await request(server, '/bookings/me', { token: '0'.repeat(64) })).status, 404);
  await request(server, '/bookings/me/cancel', { body: {}, token: body.managementToken });
  await server.stop('SIGKILL'); server = await fixture.start();
  assert.equal((await request(server, '/bookings/me', { token: body.managementToken })).data.booking.status, 'cancelled');
  assert.equal((await request(server, '/sessions')).data.sessions[0].available, 2);
});

test('Сбой после INSERT брони откатывает всю транзакцию; тот же запрос можно повторить', { timeout: 30000 }, async (t) => {
  const fixture = await processFixture(t); const server = await fixture.start(); const body = fixture.input(); const key = randomUUID();
  fixture.inspect((db) => db.exec("CREATE TRIGGER test_fail_key BEFORE INSERT ON idempotency_keys BEGIN SELECT RAISE(ABORT, 'TEST_ATOMICITY'); END;"));
  const failed = await request(server, '/bookings', { body, key }); assert.equal(failed.status, 503);
  assert.deepEqual(fixture.inspect((db) => ({ bookings: db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, keys: db.prepare('SELECT COUNT(*) AS n FROM idempotency_keys').get().n })), { bookings: 0, keys: 0 });
  assert.equal((await request(server, '/sessions')).data.sessions[0].available, fixture.capacity);
  fixture.inspect((db) => db.exec('DROP TRIGGER test_fail_key'));
  const retried = await request(server, '/bookings', { body, key }); assert.equal(retried.status, 201);
  assert.equal(fixture.inspect((db) => db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n), 1);
});
