import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { openDatabase, migrate } from '../../server/db/database.mjs';
import { loadCatalog, projectRoot } from '../../server/services/catalog.mjs';

export async function processFixture(t, capacity = 3) {
  const root = resolve(projectRoot, '.cache/tests');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(resolve(root, 'process-bookings-'));
  const filename = resolve(directory, 'test.sqlite');
  const program = loadCatalog().workshops[0];
  const sessionId = `test-${randomUUID()}`;
  const startsAt = new Date(Date.now() + 3 * 86400000).toISOString();
  const db = openDatabase(filename); migrate(db);
  db.prepare('INSERT INTO sessions (id,workshop_id,starts_at,ends_at,capacity,created_at) VALUES (?,?,?,?,?,?)')
    .run(sessionId, program.id, startsAt, new Date(new Date(startsAt).getTime() + program.durationMinutes * 60000).toISOString(), capacity, new Date().toISOString());
  db.close();
  const children = [];
  async function stop(child, signal = 'SIGTERM') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((done, reject) => {
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Тестовый сервер не завершился вовремя')); }, 8000);
      child.once('close', () => { clearTimeout(timeout); done(); });
      child.kill(signal);
    });
  }
  t.after(async () => {
    await Promise.all(children.map((child) => stop(child)));
    const path = relative(root, directory);
    if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error('Тестовая база находится вне разрешённого каталога');
    rmSync(directory, { recursive: true, force: true });
  });
  async function start() {
    // Запускается настоящий production-entry, а не его копия или заглушка.
    const child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DATABASE_PATH: filename, PORT: '0', HOST: '127.0.0.1',
        NODE_ENV: 'development', TRUST_PROXY: '0', PUBLIC_ORIGIN: '' }
    });
    children.push(child);
    const origin = await new Promise((done, reject) => {
      let output = '';
      // Four cold Node.js processes on Windows can start slowly under load.
      // This bounds process readiness only; booking assertions are unchanged.
      const timeout = setTimeout(() => reject(new Error('Не получен адрес тестового Node.js-сервера')), 45000);
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Тестовый сервер завершился до готовности')); });
      // Потребляем stderr, но не публикуем содержимое запросов в результатах тестов.
      child.stderr.on('data', () => {});
      child.stdout.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-2000);
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timeout); done(match[0]); }
      });
    });
    return { origin, stop: (signal) => stop(child, signal) };
  }
  function inspect(callback) {
    const connection = openDatabase(filename);
    try { return callback(connection); } finally { connection.close(); }
  }
  function input(quantity = 1) {
    return { sessionId, quantity, expectedUnitPriceRub: program.priceRub,
      name: 'Тестовый участник', phone: '+79000000000', email: 'demo@example.test', comment: '',
      privacyConsent: true, policyConsent: true, rulesConsent: true, managementToken: randomBytes(32).toString('hex') };
  }
  return { start, inspect, input, sessionId, program, capacity };
}

export async function request(server, path, { body, key, token } = {}) {
  const response = await fetch(`${server.origin}/api${path}`, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { status: response.status, data: await response.json() };
}
