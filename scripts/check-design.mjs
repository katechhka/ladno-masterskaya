import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from '../server/services/catalog.mjs';

const baseURL = process.env.PREVIEW_URL || 'http://127.0.0.1:5173';
const directory = resolve(projectRoot, 'docs/screenshots');
mkdirSync(directory, { recursive: true });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
const report = { revision: 'v2 — афиша мастерской', page: '/design/', viewports: [], errors: [], failedRequests: [], externalRequests: [] };
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['tablet', 768, 1024], ['mobile', 390, 844], ['small-mobile', 360, 800]]) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (error) => report.errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') report.errors.push(message.text()); });
    page.on('response', (response) => { if (response.status() >= 400) report.failedRequests.push({ url: response.url(), status: response.status() }); });
    page.on('request', (request) => { if (!request.url().startsWith(baseURL) && /^https?:/.test(request.url())) report.externalRequests.push(request.url()); });
    await page.goto(`${baseURL}/design/`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    // Догружаем внеэкранные изображения для полного скриншота, не меняя их содержимое.
    await page.evaluate(async () => {
      const images = [...document.querySelectorAll('main > section img')].filter((image) => !image.closest('details'));
      images.forEach((image) => { image.loading = 'eager'; });
      await Promise.all(images.map((image) => image.decode()));
    });
    const metrics = await page.evaluate(() => ({
      viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      fontFamily: getComputedStyle(document.querySelector('h1')).fontFamily,
      loadedFonts: [...document.fonts].filter((font) => font.status === 'loaded').map((font) => `${font.family} ${font.style}`),
      brokenImages: [...document.images].filter((image) => !image.closest('details') && (!image.complete || !image.naturalWidth)).length,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
    }));
    assert.ok(metrics.scrollWidth <= width, `${name}: горизонтальное переполнение`);
    assert.equal(metrics.brokenImages, 0, `${name}: не загрузилось изображение`);
    assert.ok(metrics.loadedFonts.some((font) => font.includes('Unbounded')), `${name}: не загрузился Unbounded`);
    assert.ok(metrics.loadedFonts.some((font) => font.includes('Onest')), `${name}: не загрузился Onest`);
    assert.ok(metrics.loadedFonts.every((font) => !/Literata|Golos|Manrope/.test(font)), `${name}: загружается старый шрифт`);
    assert.ok(metrics.reducedMotion);
    await page.keyboard.press('Tab');
    assert.ok(await page.locator('.skip-link').evaluate((element) => element === document.activeElement));
    await page.keyboard.press('Enter');
    assert.equal(new URL(page.url()).hash, '#main');
    // Переключение материала работает мышью и клавиатурой, состояние озвучивается.
    const paintButton = page.locator('[data-material-select="paint"]');
    await paintButton.focus();
    await page.keyboard.press('Enter');
    assert.equal(await paintButton.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-material-panel="paint"]').isVisible(), true);
    assert.equal(await page.locator('[data-material-panel="clay"]').isVisible(), false);
    await page.locator('[data-material-select="print"]').click();
    assert.equal(await page.locator('[data-material-panel="print"]').isVisible(), true);
    await page.locator('[data-material-select="clay"]').click();
    assert.equal(await page.locator('[data-material-panel="clay"]').isVisible(), true);
    assert.equal(await page.locator('.material-index__row').count(), 7);
    await page.locator('h1').click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: resolve(directory, `stage-2-v2-${name}-viewport.png`) });
    await page.screenshot({ path: resolve(directory, `stage-2-v2-${name}.png`), fullPage: true });
    // Открываем медиатеку и проверяем все сгенерированные сюжеты.
    await page.locator('.image-library__summary').click();
    await page.evaluate(async () => {
      const images = [...document.querySelectorAll('.image-library img')];
      images.forEach((image) => { image.loading = 'eager'; });
      await Promise.all(images.map((image) => image.decode()));
    });
    assert.equal(await page.locator('.image-library img').count(), 24);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (name === 'desktop') await page.locator('.image-library').screenshot({ path: resolve(directory, 'stage-2-v2-image-library.png') });
    report.viewports.push({ name, width, height, ...metrics, libraryImages: 24 });
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.failedRequests, []);
  assert.deepEqual(report.externalRequests, []);
  console.log('Дизайн проверен в Chrome: 1440, 768, 390 и 360 px. Переполнений, ошибок и внешних запросов нет. Все 24 изображения доступны.');
} finally {
  await browser.close();
  writeFileSync(resolve(projectRoot, 'docs/design-check-v2.json'), `${JSON.stringify(report, null, 2)}\n`);
}
