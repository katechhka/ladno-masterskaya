import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCatalog, projectRoot } from '../server/services/catalog.mjs';
import { dayKey, mondayKey, sessionState } from '../src/scripts/services/dates.js';

const base = process.env.PREVIEW_URL || 'http://127.0.0.1:5173';
const { workshops } = loadCatalog();
const schedule = await (await fetch(`${base}/api/sessions`)).json();
const first = schedule.sessions.find((session) => sessionState(session).canSelect);
assert.ok(first, 'Для проверки нужны будущие сеансы. Продлите расписание или наполните свежую тестовую базу.');
const firstProgram = workshops.find((program) => program.id === first.workshopId);
const firstWeek = mondayKey(first.startsAt);
const screenshotDir = resolve(projectRoot, 'docs/screenshots/stage-3');
mkdirSync(screenshotDir, { recursive: true });
const report = { phase: 3, base, checks: [], viewports: [], errors: [], failedResources: [] };
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
let activeCheck = '';
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', (error) => report.errors.push(error.message));
  async function check(name, callback) {
    activeCheck = name;
    await callback();
    report.checks.push(name);
    console.log(`OK: ${name}`);
  }

  await check('Главная: реальные ближайшие сеансы, FAQ и честное расположение', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await expect(page.locator('[data-upcoming-sessions] .session-row')).toHaveCount(3);
    await expect(page.locator('#about')).toBeVisible();
    await page.locator('.faq__question').first().click();
    assert.equal(await page.locator('.faq__item').first().getAttribute('open'), '');
    await expect(page.locator('.location-block')).toContainText('Реального адреса');
  });

  await check('Каталог: 14 программ, URL-фильтр, обновление страницы', async () => {
    await page.goto(`${base}/master-classes/?category=ceramics`, { waitUntil: 'networkidle' });
    await expect(page.locator('[data-catalog-card]:visible')).toHaveCount(3);
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('select[name="category"]')).toHaveValue('ceramics');
    await expect(page.locator('[data-catalog-card]:visible')).toHaveCount(3);
  });

  await check('Каталог: поиск, отсутствие результатов, сброс', async () => {
    await page.locator('button[type="reset"]').click();
    await expect(page.locator('[data-catalog-card]:visible')).toHaveCount(14);
    await page.locator('input[name="q"]').fill('чашка');
    await expect(page.locator('[data-catalog-card]:visible')).toHaveCount(1);
    await expect(page.locator('[data-catalog-card]:visible')).toContainText('Чашка в ладонях');
    assert.ok(new URL(page.url()).searchParams.get('q') === 'чашка');
    await page.locator('input[name="q"]').fill('такого занятия нет');
    await expect(page.locator('[data-catalog-empty]')).toBeVisible();
    await page.locator('[data-catalog-reset]').click();
    await expect(page.locator('[data-catalog-card]:visible')).toHaveCount(14);
    assert.equal(new URL(page.url()).search, '');
  });

  await check('Каталог: возраст, сортировка цены и длительности, назад/вперёд', async () => {
    await page.locator('select[name="age"]').selectOption('8');
    await expect(page.locator('[data-catalog-card]:visible')).toHaveCount(2);
    await page.locator('button[type="reset"]').click();
    await page.locator('select[name="sort"]').selectOption('price-asc');
    const prices = await page.locator('[data-catalog-card]:visible').evaluateAll((cards) => cards.map((card) => Number(card.dataset.price)));
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
    await page.locator('select[name="sort"]').selectOption('duration-desc');
    const times = await page.locator('[data-catalog-card]:visible').evaluateAll((cards) => cards.map((card) => Number(card.dataset.duration)));
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
    await page.locator('select[name="category"]').selectOption('painting');
    await expect(page.locator('[data-catalog-card]:visible')).toHaveCount(2);
    await page.goBack();
    await expect(page.locator('[data-catalog-card]:visible')).toHaveCount(14);
    await page.goForward();
    await expect(page.locator('[data-catalog-card]:visible')).toHaveCount(2);
  });

  await check('Галерея: миниатюры, стрелки, свайп, увеличение и Escape с возвратом фокуса', async () => {
    await page.goto(`${base}/master-classes/chashka-v-ladonyakh/`, { waitUntil: 'networkidle' });
    await expect(page.locator('.session-picker')).toBeVisible();
    await page.locator('.gallery__controls [data-gallery-next]').click();
    await expect(page.locator('[data-gallery-counter]')).toHaveText('2 / 3');
    await page.locator('[data-gallery-index="2"]').click();
    await expect(page.locator('[data-gallery-counter]')).toHaveText('3 / 3');
    await page.locator('[data-gallery-viewport]').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-gallery-counter]')).toHaveText('1 / 3');
    await page.locator('[data-gallery-viewport]').dispatchEvent('pointerdown', { clientX: 300, clientY: 100 });
    await page.locator('[data-gallery-viewport]').dispatchEvent('pointerup', { clientX: 180, clientY: 100 });
    await expect(page.locator('[data-gallery-counter]')).toHaveText('2 / 3');
    await page.locator('[data-gallery-open]').click();
    await expect(page.locator('dialog')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('[data-gallery-counter]')).toHaveText('3 / 3');
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog')).not.toBeVisible();
    await expect(page.locator('[data-gallery-open]')).toBeFocused();
  });

  await check('Выбор нескольких участников: корректная сумма и обязательный телефон', async () => {
    await page.locator('input[name="quantity"]').fill('2');
    await expect(page.locator('.session-picker__total')).toContainText('6 400');
    await page.locator('.session-picker button[type="submit"]').click();
    await expect(page.locator('.booking-summary')).toContainText('6 400');
    await expect(page.locator('.booking-preview__notice')).toContainText('демоверсия');
    await expect(page.locator('input[name=phone]')).toHaveAttribute('required', '');
    assert.equal(await page.locator('input[type="email"]').count(), 1);
  });

  await check('Расписание: дни без занятий, переход недель, фильтр и история URL', async () => {
    await page.goto(`${base}/schedule/?week=${firstWeek}`, { waitUntil: 'networkidle' });
    await expect(page.locator('.week-day')).toHaveCount(8);
    await page.locator(`[data-select-day="${firstWeek}"]`).click();
    await expect(page.locator('.schedule .empty-state')).toBeVisible();
    await page.locator('[data-select-day=""]').click();
    await expect(page.locator('.schedule-day')).toHaveCount(7);
    await page.locator('[data-week-next]').click();
    const next = new URL(page.url()).searchParams.get('week');
    assert.notEqual(next, firstWeek);
    await page.locator('[data-week-prev]').click();
    assert.equal(new URL(page.url()).searchParams.get('week'), firstWeek);
    await page.locator('[data-schedule-category]').selectOption('ceramics');
    await expect(page).toHaveURL(/category=ceramics/);
    const categories = await page.locator('.session-row__category').allTextContents();
    assert.ok(categories.every((category) => category === 'Керамика'));
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('[data-schedule-category]')).toHaveValue('ceramics');
  });

  await check('Все 14 детальных страниц открываются напрямую с общей ценой и метаданными', async () => {
    for (const program of workshops) {
      const response = await context.request.get(`${base}/master-classes/${program.slug}/`);
      assert.equal(response.status(), 200);
      const html = await response.text();
      assert.ok(html.includes(program.title));
      assert.ok(html.includes('property="og:title"'));
      assert.ok(html.includes('name="description"'));
      assert.ok(!html.includes('Техническая страница'));
    }
  });

  await check('Публичный снимок не содержит контактов, номеров броней и токенов', async () => {
    const response = await context.request.get(`${base}/api/sessions`);
    const data = await response.json();
    const allowed = ['id', 'workshopId', 'startsAt', 'endsAt', 'capacity', 'status', 'available'];
    for (const session of data.sessions) assert.deepEqual(Object.keys(session).sort(), [...allowed].sort());
    for (const path of ['/rules/', '/privacy/', '/booking/manage/']) {
      assert.equal((await context.request.get(`${base}${path}`)).status(), 200);
    }
  });

  await check('Несуществующий URL возвращает оформленную 404 с кодом 404', async () => {
    const response = await page.goto(`${base}/master-classes/unknown-program/`, { waitUntil: 'networkidle' });
    assert.equal(response.status(), 404);
    await expect(page.locator('h1')).toContainText('чистый лист');
    await expect(page.locator('a.button')).toHaveAttribute('href', '/master-classes/');
  });

  await context.close();

  // Фикстуры меняют только ответ браузеру; рабочая база не модифицируется.
  const fixtureContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const fixturePage = await fixtureContext.newPage();
  await check('Ошибка получения расписания и успешная повторная попытка', async () => {
    let calls = 0;
    await fixturePage.route('**/api/sessions', (route) => ++calls === 1 ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.fulfill({ json: schedule }));
    await fixturePage.goto(`${base}/schedule/`, { waitUntil: 'networkidle' });
    await expect(fixturePage.locator('[role="alert"]')).toBeVisible();
    await fixturePage.locator('[data-retry]').click();
    await expect(fixturePage.locator('.session-row').first()).toBeVisible();
    await fixturePage.unroute('**/api/sessions');
  });

  await check('Загрузка: до ответа показано ожидание, без фиктивной доступности', async () => {
    let release;
    await fixturePage.route('**/api/sessions', async (route) => { await new Promise((resolve) => { release = resolve; }); await route.fulfill({ json: schedule }); });
    await fixturePage.goto(`${base}/schedule/`, { waitUntil: 'domcontentloaded' });
    await expect(fixturePage.locator('.loading-state')).toBeVisible();
    await expect.poll(() => Boolean(release)).toBe(true);
    assert.equal(await fixturePage.locator('.session-row').count(), 0);
    release();
    await expect(fixturePage.locator('.session-row').first()).toBeVisible();
    await fixturePage.unroute('**/api/sessions');
  });

  await check('Заполненный и прошедший сеанс нельзя выбрать', async () => {
    const full = structuredClone(schedule);
    full.sessions.find((session) => session.id === first.id).available = 0;
    await fixturePage.route('**/api/sessions', (route) => route.fulfill({ json: full }));
    await fixturePage.goto(`${base}/schedule/?week=${firstWeek}&day=${dayKey(first.startsAt)}`, { waitUntil: 'networkidle' });
    await expect(fixturePage.locator(`[data-session-id="${first.id}"] button`)).toBeDisabled();
    await expect(fixturePage.locator(`[data-session-id="${first.id}"]`)).toContainText('Мест нет');
    const past = schedule.sessions.find((session) => new Date(session.startsAt).getTime() < Date.now());
    assert.ok(past);
    await fixturePage.goto(`${base}/schedule/?week=${mondayKey(past.startsAt)}&day=${dayKey(past.startsAt)}`, { waitUntil: 'networkidle' });
    await expect(fixturePage.locator(`[data-session-id="${past.id}"] button`)).toBeDisabled();
    await expect(fixturePage.locator(`[data-session-id="${past.id}"]`)).toContainText('Уже прошло');
    await fixturePage.unroute('**/api/sessions');
  });

  await check('Нет доступных дат у программы: честное пустое состояние', async () => {
    const none = structuredClone(schedule);
    none.sessions.filter((session) => session.workshopId === first.workshopId).forEach((session) => { session.available = 0; });
    await fixturePage.route('**/api/sessions', (route) => route.fulfill({ json: none }));
    await fixturePage.goto(`${base}/master-classes/${firstProgram.slug}/`, { waitUntil: 'networkidle' });
    await expect(fixturePage.locator('[data-session-picker]')).toContainText('пока нет доступных дат');
    assert.equal(await fixturePage.locator('.session-picker').count(), 0);
    await fixturePage.unroute('**/api/sessions');
  });

  await check('Недействительный сеанс и число участников не дают ложного подтверждения', async () => {
    for (const query of ['session=unknown', `session=${first.id}&quantity=999`, `session=${first.id}&quantity=-1`]) {
      await fixturePage.goto(`${base}/booking/?${query}`, { waitUntil: 'networkidle' });
      await expect(fixturePage.locator('[data-booking-preview] .empty-state')).toBeVisible();
      assert.equal(await fixturePage.locator('.booking-summary').count(), 0);
    }
  });
  await fixtureContext.close();

  const routes = [['home', '/'], ['catalog', '/master-classes/'], ['workshop', '/master-classes/chashka-v-ladonyakh/'], ['schedule', `/schedule/?week=${firstWeek}`]];
  for (const [viewportName, width, height] of [['desktop', 1440, 1000], ['tablet', 768, 1024], ['mobile', 390, 844], ['small-mobile', 360, 800]]) {
    const viewContext = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', deviceScaleFactor: 1 });
    const viewPage = await viewContext.newPage();
    viewPage.on('pageerror', (error) => report.errors.push(error.message));
    viewPage.on('response', (response) => { if (response.status() >= 400) report.failedResources.push({ url: response.url(), status: response.status() }); });
    for (const [name, path] of routes) {
      activeCheck = `${name} / ${width}px`;
      await viewPage.goto(`${base}${path}`, { waitUntil: 'networkidle' });
      await viewPage.evaluate(async () => { await document.fonts.ready; const images = [...document.images].filter((image) => !image.closest('[hidden], dialog')); images.forEach((image) => { image.loading = 'eager'; }); await Promise.all(images.map((image) => image.decode())); });
      const metrics = await viewPage.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, headings: document.querySelectorAll('h1').length, brokenImages: [...document.images].filter((image) => !image.closest('[hidden], dialog') && (!image.complete || !image.naturalWidth)).length }));
      assert.ok(metrics.scrollWidth <= width, `${name} при ${width}px: переполнение ${metrics.scrollWidth}`);
      assert.equal(metrics.headings, 1);
      assert.equal(metrics.brokenImages, 0);
      await viewPage.evaluate(() => window.scrollTo(0, 0));
      const file = `${name}-${viewportName}.png`;
      await viewPage.screenshot({ path: resolve(screenshotDir, file), fullPage: true });
      if (viewportName === 'desktop' || viewportName === 'mobile') await viewPage.screenshot({ path: resolve(screenshotDir, `${name}-${viewportName}-viewport.png`) });
      report.viewports.push({ name, viewportName, ...metrics, screenshot: `screenshots/stage-3/${file}` });
      console.log(`OK: ${name}, ${width}px`);
    }
    await viewContext.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.failedResources, []);
  console.log(`Готово: ${report.checks.length} функциональных проверок и ${report.viewports.length} проверок страниц по размерам.`);
} catch (error) {
  report.failure = { check: activeCheck, message: error.message };
  throw error;
} finally {
  await browser.close();
  writeFileSync(resolve(projectRoot, 'docs/pages-check.json'), `${JSON.stringify(report, null, 2)}\n`);
}
