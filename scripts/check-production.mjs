import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { openDatabase, migrate } from '../server/db/database.mjs';
import { loadCatalog, projectRoot } from '../server/services/catalog.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { publicSessions } from '../server/services/bookings.mjs';

const root = resolve(projectRoot, '.cache/tests'); mkdirSync(root, { recursive: true });
const directory = mkdtempSync(resolve(root, 'production-'));
const filename = resolve(directory, 'production.sqlite');
const screenshots = resolve(projectRoot, 'docs/screenshots/stage-8'); mkdirSync(screenshots, { recursive: true });
const catalog = loadCatalog();
const db = openDatabase(filename); migrate(db); seedSchedule(db, catalog.workshops);
const session = publicSessions(db).find((s) => s.available >= 2 && new Date(s.startsAt) > new Date());
const program = catalog.workshops.find((w) => w.id === session.workshopId); db.close();
const probe = createServer(); await new Promise((done) => probe.listen(0, '127.0.0.1', done));
const port = probe.address().port; await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const report = { phase: 8, startedAt: new Date().toISOString(), production: true, persistentTestDatabase: true,
  workingDatabaseTouched: false, realMessagesSent: 0, checks: [], browserErrors: [], consoleErrors: [], failedResources: [], passed: false };
let child; let browser; let output = ''; let current = 'start';
function passed(label) { report.checks.push(label); console.log(`OK: ${label}`); }
async function start() {
  child = spawn(process.execPath, ['server/index.mjs'], { cwd: projectRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', PUBLIC_ORIGIN: origin,
      DATABASE_PATH: filename, TRUST_PROXY: '0', TELEGRAM_BOT_TOKEN: '', TELEGRAM_BOT_USERNAME: '', TELEGRAM_PROXY_URL: '' } });
  output = '';
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('Production-сервер не запустился вовремя')), 15000);
    const fail = () => { clearTimeout(timeout); reject(new Error('Production-сервер завершился до готовности')); };
    child.once('error', fail); child.once('exit', fail);
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes(origin)) { clearTimeout(timeout); child.removeListener('exit', fail); done(); }
    });
  });
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((done, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Сервер не остановился вовремя')); }, 8000);
    child.once('close', () => { clearTimeout(timeout); done(); }); child.kill('SIGTERM');
  });
}
async function get(path, options = {}) { return fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15000), ...options }); }
try {
  await start();
  current = 'routes';
  const routes = ['/', '/master-classes/', '/schedule/', '/booking/', '/booking/manage/', '/rules/', '/privacy/', '/design/',
    ...catalog.workshops.map((w) => `/master-classes/${w.slug}/`)];
  for (const path of routes) {
    const response = await get(path); assert.equal(response.status, 200, path);
    const html = await response.text(); assert.match(html, /<html lang="ru">/); assert.match(html, /<title>[^<]+<\/title>/);
    assert.match(html, /name="description" content="[^"]+"/);
    if (path !== '/design/') assert.match(html, /property="og:image"/);
    assert.ok(!html.includes('/@fs/') && !html.includes('/src/scripts/'));
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'") && csp.includes('upgrade-insecure-requests'));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(response.headers.get('strict-transport-security'));
  }
  passed('22 прямых адреса: HTML, метаданные, CSP, HSTS и защитные заголовки');
  const redirect = await get('/master-classes?category=ceramics', { redirect: 'manual' });
  assert.equal(redirect.status, 308); assert.match(redirect.headers.get('location'), /\/master-classes\/\?category=ceramics$/);
  for (const path of ['/missing-page/', '/.env', '/server/index.mjs', '/storage/ladno.sqlite', '/data/workshops.json', '/src/pages/home.njk']) {
    const response = await get(path); assert.equal(response.status, 404, path); assert.match(await response.text(), /Страница не найдена/);
  }
  assert.equal((await get('/favicon.svg')).status, 200);
  passed('Переход без слеша сохраняет фильтр; оформленная 404; исходники, база и .env не выдаются');
  for (const path of ['/api/catalog', '/api/sessions', '/booking/', '/booking/manage/']) {
    assert.equal((await get(path)).headers.get('cache-control'), 'no-store');
  }
  const denied = await get('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example.test' }, body: '{}' });
  assert.equal(denied.status, 403); assert.equal((await denied.json()).error.code, 'ORIGIN');
  passed('Запрет кеширования брони/API и запросов изменения с чужого сайта');

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const [label, width, height] of [['desktop', 1440, 1000], ['mobile', 360, 800]]) {
    current = label;
    // Сбрасывается только ограничитель процесса; SQLite сохраняется между запусками.
    await stop(); await start();
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (e) => report.browserErrors.push({ viewport: label, message: e.message }));
    page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push({ viewport: label, message: message.text() }); });
    page.on('response', (r) => { if (r.status() >= 400) report.failedResources.push({ viewport: label, status: r.status(), path: new URL(r.url()).pathname }); });
    for (const path of ['/', '/master-classes/', `/master-classes/${program.slug}/`, '/schedule/']) {
      await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.goto(`${origin}/booking/?session=${session.id}&quantity=2`, { waitUntil: 'networkidle' });
    await expect(page.locator('[data-contact-form]')).toBeVisible();
    await page.locator('[name=name]').fill('Тестовый гость');
    await page.locator('[name=phone]').fill('89000000000');
    await expect(page.locator('[name=phone]')).toHaveValue('+7 (900) 000-00-00');
    await page.locator('[name=email]').fill('production@example.test');
    await page.locator('[name=privacyConsent]').check(); await page.locator('[name=policyConsent]').check(); await page.locator('[name=rulesConsent]').check();
    await page.getByRole('button', { name: 'Проверить запись' }).click();
    await expect(page.locator('[data-booking-review]')).toContainText('Оплата на месте после мастер-класса');
    await page.locator('[data-confirm-booking]').click();
    await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible();
    assert.match(page.url(), /\/booking\/manage\/#token=[a-f0-9]{64}$/);
    const managementURL = page.url(); const token = new URLSearchParams(new URL(managementURL).hash.slice(1)).get('token');
    const snapshot = openDatabase(filename);
    const row = snapshot.prepare("SELECT reference,total_kopecks,quantity FROM bookings WHERE status='confirmed' ORDER BY id DESC LIMIT 1").get(); snapshot.close();
    assert.equal(row.quantity, 2); assert.equal(row.total_kopecks, program.priceRub * 2 * 100);
    assert.equal((await (await get('/api/sessions')).json()).sessions.find((s) => s.id === session.id).available, session.capacity - 2);
    await page.screenshot({ path: resolve(screenshots, `confirmed-${label}.png`), fullPage: true });
    await stop(); await start();
    await page.goto(managementURL, { waitUntil: 'networkidle' });
    await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible();
    await expect(page.locator('[data-booking-preview]')).toContainText(row.reference);
    const unauthorized = await get(`/api/bookings/${row.reference}`); assert.equal(unauthorized.status, 404);
    const noToken = await get('/api/bookings/me'); assert.equal(noToken.status, 404);
    await page.locator('[data-open-cancel]').click(); await page.locator('[data-confirm-cancel]').click();
    await expect(page.locator('[data-booking-status=cancelled]')).toBeVisible();
    const repeat = await get('/api/bookings/me/cancel', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
    assert.equal(repeat.status, 200); assert.equal((await repeat.json()).alreadyCancelled, true);
    assert.equal((await (await get('/api/sessions')).json()).sessions.find((s) => s.id === session.id).available, session.capacity);
    await page.screenshot({ path: resolve(screenshots, `cancelled-${label}.png`), fullPage: true });
    assert.ok(!output.includes('production@example.test') && !output.includes(token) && !output.includes('+79000000000'));
    await context.close(); passed(`${width}px: телефон, запись двух участников, цена, перезапуск, защищённый доступ, отмена и повтор`);
  }
  await stop(); await start();
  const last = openDatabase(filename); assert.equal(last.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status='cancelled'").get().n, 2); last.close();
  for (let n = 0; n < 20; n++) assert.equal((await get('/api/bookings/me')).status, 404);
  const limited = await get('/api/bookings/me'); assert.equal(limited.status, 429); assert.ok(limited.headers.get('retry-after'));
  assert.equal((await limited.json()).error.code, 'RATE_LIMIT');
  passed('Отмены сохранены после перезапуска; production-лимит действий возвращает 429 и Retry-After');
  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.failedResources, []);
  function inspectFiles(path) {
    for (const file of readdirSync(path, { withFileTypes: true })) {
      const absolute = resolve(path, file.name);
      if (file.isDirectory()) inspectFiles(absolute);
      else {
        assert.ok(!/\.(?:sqlite|sqlite3|db)(?:-wal|-shm)?$|^\.env/.test(file.name), 'В dist есть закрытый файл');
        if (/\.(html|js|css|json|map)$/.test(file.name)) {
          const text = readFileSync(absolute, 'utf8');
          assert.ok(!/api\.telegram\.org\/bot\d+:|BEGIN (?:RSA )?PRIVATE KEY|TELEGRAM_BOT_TOKEN/.test(text), 'В dist обнаружен секретный маркер');
        }
      }
    }
  }
  inspectFiles(resolve(projectRoot, 'dist'));
  passed('Нет ошибок браузера/CSP, неудачных загрузок и закрытых файлов в dist'); report.passed = true;
} catch (error) {
  // Только этап и текст проверки: URL управления и токены в отчёт не включаются.
  report.failure = { step: current, message: error.message.replace(/[a-f0-9]{64}/g, '[token]') }; throw error;
} finally {
  await browser?.close(); await stop();
  report.finishedAt = new Date().toISOString(); writeFileSync(resolve(projectRoot, 'docs/production-check.json'), `${JSON.stringify(report, null, 2)}\n`);
  const inside = relative(root, directory);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('Небезопасный путь тестовой базы');
  rmSync(directory, { recursive: true, force: true });
}
