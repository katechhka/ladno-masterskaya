import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase, migrate } from '../server/db/database.mjs';
import { initializeCatalog, storedCatalog } from '../server/services/catalog-store.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { createBookingService, publicSessions } from '../server/services/bookings.mjs';
import { savePhoto } from '../server/services/media.mjs';
import { projectRoot } from '../server/services/catalog.mjs';
import { createBackup, restoreBackup } from '../scripts/lib/backups.mjs';

function fixture(t) {
  const root = resolve(projectRoot, '.cache/tests'); mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(resolve(root, 'backup-'));
  const path = resolve(directory, 'live.sqlite'), uploads = resolve(directory, 'uploads');
  const db = openDatabase(path); migrate(db); initializeCatalog(db);
  seedSchedule(db, storedCatalog(db).workshops);
  t.after(() => {
    if (db.open) db.close();
    const rel = relative(root, directory); assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const session = publicSessions(db).find(item => new Date(item.startsAt) > new Date());
  const program = storedCatalog(db).workshops.find(item => item.id === session.workshopId);
  const token = randomBytes(32).toString('hex'), key = randomUUID();
  const input = { sessionId: session.id, quantity: 2, expectedUnitPriceRub: program.priceRub,
    name: 'Проверка копии', phone: '+79000000000', email: 'backup@example.test', comment: '',
    privacyConsent: true, policyConsent: true, rulesConsent: true, managementToken: token };
  const service = createBookingService(db, { catalog: () => storedCatalog(db, { includeArchived: true }) });
  service.create(input, key);
  return { directory, db, path, uploads, session, token, key, input,
    options: { databasePath: path, uploadsDirectory: uploads, outputDirectory: resolve(directory, 'copies') } };
}

test('Копия работающей WAL-базы и фото: CLI, восстановление, сумма, места, токен, повтор и отмена', async t => {
  const f = fixture(t);
  const image = await savePhoto(f.db, readFileSync(resolve(projectRoot, 'src/assets/images/originals/hero.png')), 'Глиняная чаша на рабочем столе', { directory: f.uploads });
  const env = { ...process.env, DATABASE_PATH: f.path, UPLOADS_DIR: f.uploads, BACKUP_DIR: f.options.outputDirectory };
  const created = spawnSync(process.execPath, ['scripts/backup.mjs'], { cwd: projectRoot, env, encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const { readdirSync } = await import('node:fs');
  const backup = resolve(f.options.outputDirectory, readdirSync(f.options.outputDirectory)[0]);
  const target = resolve(f.directory, 'restored');
  const restored = spawnSync(process.execPath, ['scripts/restore.mjs', '--from', backup, '--to', target], { cwd: projectRoot, env, encoding: 'utf8' });
  assert.equal(restored.status, 0, restored.stderr);
  assert.ok(!created.stdout.includes(f.input.email));
  assert.ok(!restored.stdout.includes(f.token));
  const db = openDatabase(resolve(target, 'ladno.sqlite'));
  try {
    const service = createBookingService(db, { catalog: () => storedCatalog(db, { includeArchived: true }) });
    assert.equal(service.get(f.token).totalRub, f.input.expectedUnitPriceRub * 2);
    assert.equal(service.create(f.input, f.key).replayed, true);
    assert.equal(publicSessions(db).find(item => item.id === f.session.id).available, f.session.capacity - 2);
    assert.deepEqual(readFileSync(resolve(target, 'uploads', image.src.slice(7))), readFileSync(resolve(f.uploads, image.src.slice(7))));
    service.cancel(f.token); service.cancel(f.token);
    assert.equal(publicSessions(db).find(item => item.id === f.session.id).available, f.session.capacity);
    assert.equal(f.db.prepare('SELECT status FROM bookings').get().status, 'confirmed');
  } finally { db.close(); }
});

test('Повреждённая копия и подмена пути отклоняются до создания назначения', async t => {
  const f = fixture(t); const copy = await createBackup(f.options);
  const manifestPath = resolve(copy.directory, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const target = resolve(f.directory, 'rejected');
  manifest.database.name = '../live.sqlite';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(restoreBackup({ backupDirectory: copy.directory, targetDirectory: target }));
  assert.equal(existsSync(target), false);
  manifest.database.name = 'ladno.sqlite'; writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(resolve(copy.directory, 'ladno.sqlite'), 'повреждённая база');
  await assert.rejects(restoreBackup({ backupDirectory: copy.directory, targetDirectory: target }), /Контрольная сумма/);
  assert.equal(existsSync(target), false);
});

test('Восстановление не перезаписывает существующий каталог и не создаёт пустую исходную базу', async t => {
  const f = fixture(t); const copy = await createBackup(f.options);
  const target = resolve(f.directory, 'existing'); mkdirSync(target); writeFileSync(resolve(target, 'keep.txt'), 'оставить');
  await assert.rejects(restoreBackup({ backupDirectory: copy.directory, targetDirectory: target }), { code: 'EEXIST' });
  assert.equal(readFileSync(resolve(target, 'keep.txt'), 'utf8'), 'оставить');
  const absent = resolve(f.directory, 'absent.sqlite');
  await assert.rejects(createBackup({ ...f.options, databasePath: absent }));
  assert.equal(existsSync(absent), false);
});

test('После восстановления очищаются старые контакты, входы отзываются, Telegram не переотправляется', async t => {
  const f = fixture(t), now = new Date();
  f.db.prepare('INSERT INTO admin_sessions VALUES (?,?,?)').run('a'.repeat(64), 'csrf', new Date(now.getTime() + 3600000).toISOString());
  const booking = f.db.prepare('SELECT id FROM bookings').get();
  f.db.prepare("INSERT INTO telegram_confirmations (booking_id,token_hash,expires_at,status,updated_at) VALUES (?,?,?,'pending',?)")
    .run(booking.id, 'b'.repeat(64), new Date(now.getTime() + 600000).toISOString(), now.toISOString());
  const copy = await createBackup(f.options), target = resolve(f.directory, 'safe');
  await restoreBackup({ backupDirectory: copy.directory, targetDirectory: target });
  const db = openDatabase(resolve(target, 'ladno.sqlite'));
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get().n, 0);
    assert.equal(db.prepare('SELECT status FROM telegram_confirmations').get().status, 'unknown');
  } finally { db.close(); }
  const oldTarget = resolve(f.directory, 'later');
  const result = await restoreBackup({ backupDirectory: copy.directory, targetDirectory: oldTarget, now: new Date(now.getTime() + 150 * 86400000) });
  assert.equal(result.erased, 1);
  const oldDb = openDatabase(resolve(oldTarget, 'ladno.sqlite'));
  try {
    assert.ok(oldDb.prepare('SELECT data_erased_at FROM bookings').get().data_erased_at);
    assert.notEqual(oldDb.prepare('SELECT email FROM bookings').get().email, f.input.email);
    assert.equal(oldDb.prepare('SELECT COUNT(*) AS n FROM telegram_confirmations').get().n, 0);
  } finally { oldDb.close(); }
});
