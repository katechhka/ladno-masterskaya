import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../server/app.mjs';
import { openDatabase, migrate } from '../server/db/database.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { loadCatalog, projectRoot } from '../server/services/catalog.mjs';
import { publicSessions } from '../server/services/bookings.mjs';

// Самостоятельный production-preview с отдельной БД. Рабочие брони не меняются.
const db = openDatabase(':memory:'); migrate(db); seedSchedule(db, loadCatalog().workshops);
const first = publicSessions(db).find((s) => new Date(s.startsAt) > new Date());
const { app } = createApp({ db, staticFiles: true, production: false, limits: false });
const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const directory = resolve(projectRoot, 'docs/screenshots/stage-4'); mkdirSync(directory, { recursive: true });
const report = { phase: 4, checks: [], viewports: [], errors: [] };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['tablet', 768, 1024], ['mobile', 360, 800]]) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.errors.push(error.message));
    async function screen(label) {
      await page.evaluate(async () => {
        await document.fonts.ready;
        const images = [...document.images].filter((image) => !image.closest('[hidden], dialog'));
        images.forEach((image) => { image.loading = 'eager'; });
        await Promise.all(images.map((image) => image.decode()));
      });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Переполнение ${name}/${label}`);
      await page.screenshot({ path: resolve(directory, `${label}-${name}.png`), fullPage: true });
    }
    await page.goto(base, { waitUntil: 'networkidle' });
    const tabs = page.locator('.material-board__selector');
    const boxes = await tabs.evaluateAll((items) => items.map((el) => { const b = el.getBoundingClientRect(); return { top: b.top, height: b.height }; }));
    assert.ok(boxes.every((box) => box.top === boxes[0].top && box.height === boxes[0].height));
    await tabs.nth(1).click(); await expect(tabs.nth(1)).toHaveAttribute('aria-pressed', 'true');
    await screen('home-tabs');
    await page.goto(`${base}/booking/?session=${first.id}&quantity=2`, { waitUntil: 'networkidle' });
    await expect(page.locator('[data-contact-form]')).toBeVisible();
    await page.getByRole('button', { name: 'Проверить запись' }).click();
    await expect(page.locator('[data-error=phone]')).toContainText('Укажите телефон');
    assert.equal(await page.locator('[data-booking-review]').count(), 0);
    await page.locator('[name=name]').fill('Тестовый гость');
    await page.locator('[name=phone]').fill('+7 900 000-00-00');
    await page.locator('[name=email]').fill('demo@example.test');
    await page.locator('[name=privacyConsent]').check(); await page.locator('[name=policyConsent]').check(); await page.locator('[name=rulesConsent]').check();
    await screen('booking-form');
    await page.getByRole('button', { name: 'Проверить запись' }).click();
    await expect(page.locator('[data-booking-review]')).toContainText('+79000000000');
    await expect(page.locator('[data-booking-review]')).toContainText('Оплата на месте после мастер-класса');
    await screen('booking-review');
    // Сервер успел записать бронь, но ответ потерян: повтор должен вернуть её же.
    if (name === 'desktop') {
      let lost = true;
      await page.route('**/api/bookings', async (route) => {
        if (lost) { lost = false; await route.fetch(); await route.abort('failed'); }
        else await route.continue();
      });
      await page.locator('[data-confirm-booking]').click();
      await expect(page.locator('[data-booking-review] [role=alert]')).toContainText('Повторите запрос');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 1);
      await expect(page.getByRole('button', { name: 'Изменить данные' })).toBeDisabled();
      await page.locator('[data-confirm-booking]').click();
    } else await page.locator('[data-confirm-booking]').click();
    await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible();
    assert.equal(publicSessions(db).find((s) => s.id === first.id).available, first.capacity - 2);
    await expect(page.locator('[data-booking-preview]')).toContainText('+79000000000');
    await screen('booking-confirmed');
    const savedURL = page.url();
    assert.ok(savedURL.includes('#token=') && !savedURL.includes('phone'));
    await page.reload({ waitUntil: 'networkidle' }); await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible();
    await page.locator('[data-open-cancel]').click();
    await expect(page.locator('[data-cancel-confirmation]')).toBeVisible();
    await screen('booking-cancel-confirmation');
    await page.locator('[data-confirm-cancel]').click();
    await expect(page.locator('[data-booking-status=cancelled]')).toBeVisible();
    assert.equal(publicSessions(db).find((s) => s.id === first.id).available, first.capacity);
    await screen('booking-cancelled');
    await page.reload({ waitUntil: 'networkidle' }); await expect(page.locator('[data-booking-status=cancelled]')).toBeVisible();
    report.viewports.push({ name, width, height, tabsAligned: true, phoneRequired: true, bookingAndCancellation: true });
    console.log(`OK: ${name}, табы / телефон / запись группы / отмена`);
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 3);
  report.checks.push('Обязательный телефон и согласия', 'Проверка перед отправкой', 'Запись двух участников', 'Потеря ответа после сохранения и безопасный повтор', 'Защищённая ссылка и обновление страницы', 'Подтверждение отмены и освобождение мест', 'Ровные табы на трёх размерах', 'Нет горизонтальной прокрутки и ошибок JavaScript');
} finally {
  await browser.close(); await new Promise((resolve) => server.close(resolve)); db.close();
  writeFileSync(resolve(projectRoot, 'docs/booking-check.json'), `${JSON.stringify(report, null, 2)}\n`);
}
