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
import { mondayKey } from '../src/scripts/services/dates.js';
import { visualMetrics } from './lib/visual-metrics.mjs';

const db = openDatabase(':memory:'); migrate(db); const catalog = loadCatalog(); seedSchedule(db, catalog.workshops);
const session = publicSessions(db).find((s) => new Date(s.startsAt) > new Date());
const program = catalog.workshops.find((w) => w.id === session.workshopId);
const token = randomBytes(32).toString('hex');
createBookingService(db).create({ sessionId: session.id, quantity: 1, expectedUnitPriceRub: program.priceRub,
  name: 'Тестовый участник', phone: '+79000000000', email: 'demo@example.test', comment: '', privacyConsent: true, policyConsent: true, rulesConsent: true, managementToken: token }, randomUUID());
const { app } = createApp({ db, staticFiles: true, production: false, limits: false,
  telegramConfig: { enabled: true, username: 'ladno_visual_test_bot' } });
const server = app.listen(0, '127.0.0.1'); await new Promise((done) => server.once('listening', done));
const base = `http://127.0.0.1:${server.address().port}`;
const directory = resolve(projectRoot, 'docs/screenshots/stage-7'); mkdirSync(directory, { recursive: true });
const report = { phase: 7, isolatedDatabase: true, realMessagesSent: 0, captures: [], checks: [], errors: [], unexpectedHttpErrors: [], failure: null };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
let active;
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['wide', 1920, 1080], ['tablet', 768, 1024], ['mobile', 390, 844], ['small-mobile', 360, 800]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.errors.push({ viewport: name, message: error.message }));
    page.on('response', (response) => { if (response.status() >= 400 && !response.url().endsWith('/404.html')) report.unexpectedHttpErrors.push({ viewport: name, status: response.status(), path: new URL(response.url()).pathname }); });
    async function ready() {
      await page.evaluate(async () => {
        await document.fonts.ready;
        const images = [...document.images].filter((image) => !image.closest('[hidden], dialog:not([open])'));
        images.forEach((image) => { image.loading = 'eager'; });
        await Promise.all(images.map((image) => image.decode()));
      });
    }
    async function capture(label, { full = true, locator } = {}) {
      active = `${name}/${label}`; await ready();
      const metrics = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
        brokenImages: [...document.images].filter((image) => !image.closest('[hidden], dialog:not([open])') && (!image.complete || !image.naturalWidth)).length,
        font: getComputedStyle(document.body).fontFamily }));
      assert.ok(metrics.document <= width, `Переполнение ${active}: ${metrics.document}`); assert.equal(metrics.brokenImages, 0);
      assert.ok(metrics.font.includes('Onest'));
      const file = `${label}-${name}.jpg`;
      if (locator) await page.locator(locator).screenshot({ path: resolve(directory, file), type: 'jpeg', quality: 88 });
      else await page.screenshot({ path: resolve(directory, file), type: 'jpeg', quality: 88, fullPage: full });
      report.captures.push({ viewport: name, width, label, file: `screenshots/stage-7/${file}`, ...metrics });
    }
    const routes = [
      ['home', '/'], ['catalog', '/master-classes/'], ['workshop', '/master-classes/chashka-v-ladonyakh/'],
      ['schedule', `/schedule/?week=${mondayKey(session.startsAt)}`], ['booking', `/booking/?session=${session.id}&quantity=1`],
      ['manage', `/booking/manage/#token=${token}`], ['rules', '/rules/'], ['privacy', '/privacy/'], ['404', '/404.html']
    ];
    for (const [label, path] of routes) {
      active = `${name}/${label}`;
      await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
      if (label === 'booking') await expect(page.locator('[name=phone]')).toBeVisible();
      if (label === 'manage') await expect(page.locator('[data-booking-status]')).toBeVisible();
      const readability = await page.evaluate(visualMetrics);
      report.checks.push({ viewport: name, check: `readability-${label}`, ...readability });
      if (width <= 650 && readability.minInputFont !== null) assert.ok(readability.minInputFont >= 16, `Мелкие поля ${name}/${label}`);
      if (width <= 390 && label === 'home') assert.ok(readability.heroButtonBottom + 5 <= height, `Кнопка первого экрана выходит за экран ${name}: ${readability.heroButtonBottom}`);
      if (label === 'booking') {
        const space = await page.locator('[name=phone]').evaluate((el) => {
          const style = getComputedStyle(el); const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d'); ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - ctx.measureText('+7 (900) 000-00-00').width;
        });
        assert.ok(space >= 0, `Маска телефона обрезана ${name}: ${space}`);
      }
      await capture(label);
      if (['home', 'catalog', 'workshop', 'booking'].includes(label)) await capture(`${label}-viewport`, { full: false });
      if (label === 'home') {
        const boxes = await page.locator('.material-board__selector').evaluateAll((items) => items.map((el) => ({ top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height })));
        assert.ok(boxes.every((b) => b.top === boxes[0].top && b.height === boxes[0].height));
        await page.locator('.material-board__selector').nth(2).click();
        await capture('hero-print', { locator: '.workshop-poster' });
        await page.reload({ waitUntil: 'networkidle' }); await page.keyboard.press('Tab');
        await expect(page.locator('.skip-link')).toBeFocused();
        await capture('keyboard-focus', { full: false });
      }
      if (label === 'workshop') {
        await page.locator('[data-gallery-open]').click(); await expect(page.locator('dialog')).toBeVisible();
        await capture('gallery-dialog', { full: false }); await page.keyboard.press('Escape');
        if (width <= 900) {
          await page.locator('.mobile-booking-bar').click(); await expect(page.locator('.session-picker')).toBeVisible();
          await capture('mobile-session-picker', { full: false });
          const overlap = await page.locator('.session-picker button[type=submit]').evaluate((el) => {
            const button = el.getBoundingClientRect(); const bar = document.querySelector('.mobile-booking-bar').getBoundingClientRect();
            return button.bottom > bar.top && button.top < bar.bottom;
          });
          report.checks.push({ viewport: name, check: 'picker-button-overlap', overlaps: overlap });
        }
      }
      if (label === 'booking') {
        await page.getByRole('button', { name: 'Проверить запись' }).click();
        await capture('booking-errors');
      }
      if (label === 'catalog') {
        await page.locator('input[name=q]').fill('ничего-похожего-нет'); await capture('catalog-empty');
      }
      if (label === 'manage') {
        await page.locator('[data-connect-telegram]').click(); await expect(page.locator('[data-open-telegram]')).toBeVisible();
        await capture('telegram');
        await page.locator('[data-open-cancel]').click(); await capture('cancel-confirmation');
        await page.getByRole('button', { name: 'Оставить запись' }).click();
      }
    }
    // Все заголовки программ: длинные названия и реальные фотографии.
    for (const workshop of catalog.workshops) {
      await page.goto(`${base}/master-classes/${workshop.slug}/`, { waitUntil: 'networkidle' });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Переполнение названия ${workshop.slug}/${width}`);
    }
    report.checks.push({ viewport: name, check: 'all-14-workshop-headings', passed: true });
    console.log(`OK: ${name} ${width}px — страницы, состояния, 14 названий`);
    await context.close();
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedHttpErrors, []);
} catch (error) { report.failure = { active, message: error.message }; throw error; }
finally {
  await browser.close(); await new Promise((done) => server.close(done)); db.close();
  writeFileSync(resolve(projectRoot, 'docs/visual-check.json'), `${JSON.stringify(report, null, 2)}\n`);
}
