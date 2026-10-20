import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { openDatabase, migrate } from '../server/db/database.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { loadCatalog, projectRoot } from '../server/services/catalog.mjs';
import { createBookingService, publicSessions } from '../server/services/bookings.mjs';

const db = openDatabase(':memory:'); migrate(db); seedSchedule(db, loadCatalog().workshops);
const first = publicSessions(db).find((s) => new Date(s.startsAt) > new Date());
const program = loadCatalog().workshops.find((w) => w.id === first.workshopId);
const service = createBookingService(db);
const { app } = createApp({ db, staticFiles: true, production: false, limits: false });
const server = app.listen(0, '127.0.0.1'); await new Promise((done) => server.once('listening', done));
const base = `http://127.0.0.1:${server.address().port}`;
const directory = resolve(projectRoot, 'docs/screenshots/stage-5'); mkdirSync(directory, { recursive: true });
const report = { phase: 5, checks: [], errors: [], screenshots: [], failure: null };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const count = () => db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n;
const available = () => publicSessions(db).find((s) => s.id === first.id).available;
const url = (quantity = 1) => `${base}/booking/?session=${first.id}&quantity=${quantity}`;
function reserve(quantity = 1, overrides = {}) {
  const managementToken = randomBytes(32).toString('hex');
  const result = service.create({ sessionId: first.id, quantity, expectedUnitPriceRub: program.priceRub,
    name: 'Тестовый участник', phone: '+79000000000', email: 'demo@example.test', comment: '',
    privacyConsent: true, policyConsent: true, rulesConsent: true, managementToken, ...overrides }, randomUUID());
  return { ...result, token: managementToken };
}
async function fill(page, { phone = '+7 900 000-00-00', comment = '', review = true } = {}) {
  await expect(page.locator('[data-contact-form]')).toBeVisible();
  await page.locator('[name=name]').fill('Тестовый гость'); await page.locator('[name=phone]').fill(phone);
  await page.locator('[name=email]').fill('demo@example.test'); await page.locator('[name=comment]').fill(comment);
  await page.locator('[name=privacyConsent]').check(); await page.locator('[name=policyConsent]').check(); await page.locator('[name=rulesConsent]').check();
  if (review) { await page.getByRole('button', { name: 'Проверить запись' }).click(); await expect(page.locator('[data-booking-review]')).toBeVisible(); }
}
async function shot(page, name) {
  await page.screenshot({ path: resolve(directory, `${name}.png`), fullPage: true }); report.screenshots.push(`screenshots/stage-5/${name}.png`);
}
let active;
async function check(name, run, viewport = { width: 1440, height: 1000 }) {
  active = name;
  db.exec('DELETE FROM idempotency_keys; DELETE FROM bookings;');
  db.prepare("UPDATE sessions SET capacity=2, status='scheduled' WHERE id=?").run(first.id);
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' }); const page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push({ check: name, message: error.message }));
  try { await run(page, context); report.checks.push(name); console.log(`OK: ${name}`); }
  finally { await context.close(); }
}
try {
  await check('Обязательные поля, невалидный телефон и количество не отправляют запрос', async (page) => {
    let requests = 0; page.on('request', (r) => { if (r.method() === 'POST') requests++; });
    await page.goto(url()); await fill(page, { phone: '123', review: false });
    await page.getByRole('button', { name: 'Проверить запись' }).click();
    await expect(page.locator('[name=phone]')).toBeFocused(); await expect(page.locator('[data-error=phone]')).not.toBeEmpty();
    await page.locator('[name=phone]').fill('8 (900) 000-00-00'); await page.locator('[name=quantity]').fill('1.5');
    await page.getByRole('button', { name: 'Проверить запись' }).click(); await expect(page.locator('[data-error=quantity]')).not.toBeEmpty();
    await page.locator('[name=quantity]').fill('1'); await page.locator('[name=privacyConsent]').uncheck();
    await page.getByRole('button', { name: 'Проверить запись' }).click(); await expect(page.locator('[name=privacyConsent]')).toBeFocused();
    assert.equal(requests, 0); assert.equal(count(), 0);
  });
  await check('Потеря ответа после сохранения и обновление страницы восстанавливают бронь', async (page) => {
    await page.goto(url(2)); await fill(page);
    await page.route('**/api/bookings', async (route) => { await route.fetch(); await route.abort('failed'); });
    await page.locator('[data-confirm-booking]').click(); await expect(page.locator('[data-booking-review] [role=alert]')).toContainText('Повторите запрос');
    assert.equal(count(), 1); assert.equal(available(), 0);
    const stored = await page.evaluate(() => JSON.stringify(sessionStorage));
    assert.ok(!stored.includes('demo@example.test') && !stored.includes('79000000000') && !stored.includes('Тестовый'));
    await page.reload(); await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible();
    assert.equal(count(), 1); await shot(page, 'recovered-after-reload');
  });
  await check('503 до записи, повтор и двойное нажатие создают одну бронь', async (page) => {
    await page.goto(url()); await fill(page); let unavailable = true;
    await page.route('**/api/bookings', async (route) => unavailable ? route.fulfill({ status: 503, json: { error: { code: 'SERVER_UNAVAILABLE', message: 'Сервис временно недоступен.' } } }) : route.continue());
    await page.locator('[data-confirm-booking]').click(); await expect(page.locator('[role=alert]')).toContainText('недоступен');
    assert.equal(count(), 0); assert.equal(await page.locator('[data-booking-status]').count(), 0);
    unavailable = false;
    await page.locator('[data-confirm-booking]').evaluate((button) => { button.click(); button.click(); });
    await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible(); assert.equal(count(), 1);
  });
  await check('Запрет sessionStorage не мешает записи и безопасному повтору', async (page, context) => {
    await context.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }); });
    await page.goto(url()); await fill(page); await page.locator('[data-confirm-booking]').click();
    await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible(); assert.equal(count(), 1);
  });
  await check('Остаток уменьшился: контакты сохранены, максимум обновлён, группа выбирается заново', async (page) => {
    await page.goto(url(2)); await fill(page); reserve(1);
    await page.locator('[data-confirm-booking]').click(); await expect(page.locator('[role=alert]')).toContainText('осталось мест: 1');
    await expect(page.locator('[data-confirm-booking]')).toBeDisabled();
    await page.getByRole('button', { name: 'Изменить данные' }).click();
    await expect(page.locator('[name=quantity]')).toHaveAttribute('max', '1'); await expect(page.locator('[name=phone]')).toHaveValue('+7 (900) 000-00-00');
    await page.locator('[name=quantity]').fill('1'); await page.getByRole('button', { name: 'Проверить запись' }).click();
    await page.locator('[data-confirm-booking]').click(); await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible(); assert.equal(available(), 0);
  });
  await check('Цена изменилась: новая сумма требует повторной проверки', async (page) => {
    let oldPrice = true;
    await page.route('**/api/catalog', async (route) => {
      const data = await (await route.fetch()).json();
      if (oldPrice) data.programs.find((p) => p.id === program.id).priceRub -= 100;
      await route.fulfill({ json: data });
    });
    await page.goto(url()); await fill(page); oldPrice = false;
    await page.locator('[data-confirm-booking]').click(); await expect(page.locator('[role=alert]')).toContainText('Цена изменилась');
    assert.equal(count(), 0); await page.getByRole('button', { name: 'Изменить данные' }).click();
    await page.getByRole('button', { name: 'Проверить запись' }).click(); await page.locator('[data-confirm-booking]').click();
    await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible();
    assert.equal(db.prepare('SELECT unit_price_kopecks AS price FROM bookings').get().price, program.priceRub * 100);
  });
  await check('Последние места заняты в другой вкладке: ложного подтверждения нет', async (page) => {
    await page.goto(url()); await fill(page); reserve(2);
    await page.locator('[data-confirm-booking]').click(); await expect(page.getByRole('alert')).toContainText('осталось мест: 0');
    assert.equal(count(), 1); assert.equal(await page.locator('[data-booking-status]').count(), 0); await shot(page, 'last-seats-conflict');
    await page.reload(); await expect(page.locator('[data-booking-preview]')).toContainText('недоступен');
  });
  await check('Чужой токен и номер брони не раскрывают контактные данные', async (page, context) => {
    const record = reserve();
    for (const path of [`/api/bookings/${record.booking.reference}`, '/api/bookings/me']) {
      const response = await context.request.get(`${base}${path}`); assert.equal(response.status(), 404); assert.ok(!(await response.text()).includes('demo@example.test'));
    }
    await page.goto(`${base}/booking/manage/#token=${'a'.repeat(64)}`); await expect(page.locator('[role=alert]')).toContainText('не найдена');
    assert.equal(await page.locator('[data-booking-reference]').count(), 0);
  });
  await check('Сеанс отменён во время заполнения: форма закрывает отправку и предлагает другие даты', async (page) => {
    await page.goto(url()); await fill(page);
    db.prepare("UPDATE sessions SET status='cancelled' WHERE id=?").run(first.id);
    await page.locator('[data-confirm-booking]').click(); await expect(page.getByRole('alert')).toContainText('закрыта');
    await page.getByRole('button', { name: 'Изменить данные' }).click();
    await expect(page.locator('[data-contact-form] [type=submit]')).toBeDisabled();
    await expect(page.getByRole('link', { name: 'Открыть расписание' })).toBeVisible(); assert.equal(count(), 0);
  });
  await check('Неизвестный результат и недоступность проверки после обновления не открывают новую запись', async (page) => {
    await page.goto(url()); await fill(page);
    await page.route('**/api/bookings', (route) => route.abort('failed'));
    await page.locator('[data-confirm-booking]').click(); await expect(page.locator('[role=alert]')).toContainText('Повторите запрос');
    let offline = true;
    await page.route('**/api/bookings/me', (route) => offline ? route.fulfill({ status: 503, json: { error: { message: 'Недоступно' } } }) : route.continue());
    await page.reload(); await expect(page.locator('[role=alert]')).toContainText('предыдущую запись');
    assert.equal(await page.locator('[data-contact-form]').count(), 0); assert.equal(count(), 0);
    offline = false; await page.getByRole('button', { name: 'Проверить результат', exact: true }).click();
    await expect(page.locator('[data-contact-form]')).toBeVisible(); assert.equal(count(), 0);
  });
  await check('Комментарий отображается как текст; HTML и обработчики не исполняются', async (page) => {
    await page.goto(url()); const comment = '<img src=x onerror="window.injected=true">'; await fill(page, { comment });
    await page.locator('[data-confirm-booking]').click(); await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible();
    await expect(page.locator('[data-booking-preview]')).toContainText(comment);
    assert.equal(await page.locator('[data-booking-preview] img').count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
  });
  await check('Ошибка загрузки управления и ошибка отмены допускают повтор; отказ от отмены сохраняет место', async (page) => {
    const record = reserve(); let failRead = true; let failCancel = true;
    await page.route('**/api/bookings/me', (route) => failRead ? route.fulfill({ status: 503, json: { error: { message: 'Временно недоступно.' } } }) : route.continue());
    await page.goto(`${base}/booking/manage/#token=${record.token}`); await expect(page.locator('[role=alert]')).toContainText('недоступно');
    failRead = false; await page.getByRole('button', { name: 'Повторить запрос' }).click(); await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible();
    await page.locator('[data-open-cancel]').click(); await page.getByRole('button', { name: 'Оставить запись' }).click(); assert.equal(available(), 1);
    await page.locator('[data-open-cancel]').click();
    await page.route('**/api/bookings/me/cancel', (route) => failCancel ? route.fulfill({ status: 503, json: { error: { message: 'Отмена временно недоступна.' } } }) : route.continue());
    await page.locator('[data-confirm-cancel]').click(); await expect(page.locator('[role=alert]')).toContainText('недоступна'); assert.equal(available(), 1);
    failCancel = false; await page.locator('[data-confirm-cancel]').click(); await expect(page.locator('[data-booking-status=cancelled]')).toBeVisible(); assert.equal(available(), 2);
  });
  await check('Потеря ответа отмены: повтор освобождает место один раз', async (page) => {
    const record = reserve(); await page.goto(`${base}/booking/manage/#token=${record.token}`); await page.locator('[data-open-cancel]').click();
    let lost = true;
    await page.route('**/api/bookings/me/cancel', async (route) => { if (lost) { lost = false; await route.fetch(); await route.abort('failed'); } else await route.continue(); });
    await page.locator('[data-confirm-cancel]').click(); await expect(page.locator('[role=alert]')).toContainText('Повторите запрос'); assert.equal(available(), 2);
    await page.locator('[data-confirm-cancel]').click(); await expect(page.locator('[data-booking-status=cancelled]')).toBeVisible(); assert.equal(available(), 2);
  }, { width: 360, height: 800 });
  await check('Возврат в расписание после отмены показывает освобождённые места', async (page) => {
    const record = reserve(2); await page.goto(`${base}/booking/manage/#token=${record.token}`);
    await page.locator('[data-open-cancel]').click(); await page.locator('[data-confirm-cancel]').click(); await expect(page.locator('[data-booking-status=cancelled]')).toBeVisible();
    await page.getByRole('link', { name: 'Посмотреть расписание' }).click();
    await expect(page.locator(`[data-session-id="${first.id}"] .availability`)).toContainText('2 места');
  });
  await check('API: JSON, Origin, размер запроса, приватные файлы и лимит частоты', async (_page, context) => {
    const limited = createApp({ db, staticFiles: true, production: false }).app.listen(0, '127.0.0.1');
    await new Promise((done) => limited.once('listening', done)); const origin = `http://127.0.0.1:${limited.address().port}`;
    try {
      const request = context.request;
      assert.equal((await request.post(`${origin}/api/bookings`, { headers: { 'Content-Type': 'text/plain' }, data: '{}' })).status(), 415);
      assert.equal((await request.post(`${origin}/api/bookings`, { headers: { 'Content-Type': 'application/json', Origin: 'https://example.test' }, data: '{}' })).status(), 403);
      assert.equal((await request.post(`${origin}/api/bookings`, { headers: { 'Content-Type': 'application/json' }, data: '{' })).status(), 400);
      assert.equal((await request.post(`${origin}/api/bookings`, { headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ comment: 'x'.repeat(18000) }) })).status(), 400);
      for (const path of ['/storage/ladno.sqlite', '/.env', '/server/app.mjs']) assert.equal((await request.get(`${origin}${path}`)).status(), 404);
      let last;
      for (let i = 0; i < 21; i++) last = await request.get(`${origin}/api/bookings/me`);
      assert.equal(last.status(), 429); assert.equal((await last.json()).error.code, 'RATE_LIMIT');
      assert.equal(count(), 0);
    } finally { await new Promise((done) => limited.close(done)); }
  });
  assert.deepEqual(report.errors, []);
} catch (error) { report.failure = { check: active, message: error.message }; throw error; }
finally {
  await browser.close(); await new Promise((done) => server.close(done)); db.close();
  writeFileSync(resolve(projectRoot, 'docs/functional-check.json'), `${JSON.stringify(report, null, 2)}\n`);
}
