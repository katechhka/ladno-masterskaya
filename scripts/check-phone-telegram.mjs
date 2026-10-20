import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../server/app.mjs';
import { openDatabase, migrate } from '../server/db/database.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { loadCatalog, projectRoot } from '../server/services/catalog.mjs';
import { publicSessions } from '../server/services/bookings.mjs';
import { createTelegramService } from '../server/services/telegram.mjs';

// Фальшивый токен используется только с локальным транспортом: внешних отправок нет.
const config = { enabled: true, token: '123456:local_test_only_not_a_real_bot_token', username: 'ladno_test_bot' };
const db = openDatabase(':memory:'); migrate(db); seedSchedule(db, loadCatalog().workshops);
const session = publicSessions(db).find((s) => new Date(s.startsAt) > new Date());
const telegram = createTelegramService(db, { config });
const { app } = createApp({ db, staticFiles: true, production: false, limits: false, telegramConfig: config });
const server = app.listen(0, '127.0.0.1'); await new Promise((done) => server.once('listening', done));
const base = `http://127.0.0.1:${server.address().port}`;
const directory = resolve(projectRoot, 'docs/screenshots/phone-telegram'); mkdirSync(directory, { recursive: true });
const report = { simulatedTelegramTransport: true, realMessagesSent: 0, checks: [], errors: [], passed: false };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [1440, 360]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.on('pageerror', (error) => report.errors.push(error.message));
    try {
      await page.goto(`${base}/booking/?session=${session.id}&quantity=1`);
      const phone = page.locator('[name=phone]'); await expect(phone).toBeVisible();
      await phone.pressSequentially('900000000012345678901234567890');
      await expect(phone).toHaveValue('+7 (900) 000-00-00');
      await phone.evaluate((el) => {
        const clipboardData = new DataTransfer(); clipboardData.setData('text', '8 (912) 345-67-891234567890');
        el.select(); el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
      });
      await expect(phone).toHaveValue('+7 (912) 345-67-89');
      await phone.evaluate((el) => el.setSelectionRange(4, 5)); await page.keyboard.press('8');
      await expect(phone).toHaveValue('+7 (812) 345-67-89');
      await phone.press('ControlOrMeta+A'); await phone.press('Backspace'); await expect(phone).toHaveValue('');
      await phone.fill('+12025550123123456789'); await expect(phone).toHaveValue('+120255501231234');
      await phone.fill('+7 900 000-00-00'); await page.locator('[name=name]').fill('Тестовый участник');
      await page.locator('[name=email]').fill('demo@example.test'); await page.locator('[name=privacyConsent]').check(); await page.locator('[name=policyConsent]').check(); await page.locator('[name=rulesConsent]').check();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: resolve(directory, `phone-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: 'Проверить запись' }).click(); await page.locator('[data-confirm-booking]').click();
      await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible();
      await page.locator('[data-connect-telegram]').click(); await expect(page.locator('[data-open-telegram]')).toBeVisible();
      const link = await page.locator('[data-open-telegram]').getAttribute('href');
      assert.equal(new URL(link).hostname, 't.me'); const token = new URL(link).searchParams.get('start');
      assert.notEqual(token, new URLSearchParams(new URL(page.url()).hash.slice(1)).get('token'));
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
      await page.locator('[data-copy-telegram-command]').click();
      await expect(page.locator('[data-telegram] input[readonly]')).toHaveValue(`/start ${token}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: resolve(directory, `telegram-link-${width}.png`), fullPage: true });
      let calls = 0;
      const send = async (body) => { calls++; assert.ok(body.text.includes('Бронь LD-')); assert.ok(!body.text.includes('demo@example.test')); return { message_id: width }; };
      const update = { update_id: width, message: { text: `/start ${token}`, chat: { type: 'private', id: width } } };
      await telegram.handleUpdate(update, send); await telegram.handleUpdate(update, send); assert.equal(calls, 1);
      await page.reload(); await expect(page.locator('[data-telegram]')).toContainText('отправлено в ваш личный чат');
      assert.equal(await page.locator('[data-connect-telegram]').count(), 0);
      report.checks.push({ width, typingAndPasteLimit: true, editingAndClearing: true, telegramLink: true, singleSimulatedMessage: true });
      console.log(`OK: ${width}px — маска / вставка / редактирование / Telegram / защита от дублей`);
    } finally { await context.close(); }
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  await browser.close(); await new Promise((done) => server.close(done)); db.close();
  writeFileSync(resolve(projectRoot, 'docs/phone-telegram-check.json'), `${JSON.stringify(report, null, 2)}\n`);
}
