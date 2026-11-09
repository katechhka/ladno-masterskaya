import { build } from 'vite';
import { openDatabase, migrate } from '../server/db/database.mjs';
import { initializeCatalog, storedCatalog } from '../server/services/catalog-store.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const base = process.env.PAGES_BASE || '/ladno-masterskaya/';
if (!/^\/[a-zA-Z0-9_-]+\/$/.test(base)) throw new Error('Invalid Pages base');
// Always seed a separate empty database. Never export real bookings or owner edits.
mkdirSync(resolve('.cache'), { recursive: true });
const temporary = mkdtempSync(join(resolve('.cache'), 'ladno-pages-'));
process.env.DATABASE_PATH = join(temporary, 'preview.sqlite');
process.env.PAGES_BASE = base;
process.env.VITE_STATIC_DEMO = 'true';
process.env.PUBLIC_ORIGIN = 'https://katechhka.github.io';
try {
  const db = openDatabase();
  try { migrate(db); initializeCatalog(db); seedSchedule(db, storedCatalog(db).workshops); }
  finally { db.close(); }
  await build();
  const output = resolve('dist');
  const banner = '<aside class="notice container" aria-label="Демонстрационная версия">Демо для портфолио: расписание примерное, бронь не создаётся, контакты не отправляются. Используйте вымышленные данные.</aside>';
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (entry.name.endsWith('.html')) {
        let html = readFileSync(file, 'utf8');
        // Vite handles imported assets; template links, srcsets and JSON images need the same prefix.
        html = html.replace(/((?:href|src|srcset|content)="|, )\/(?!\/)/g, `$1${base}`)
          .replaceAll(`${base}${base.slice(1)}`, base)
          .replace(/(<main\b[^>]*>)/, `$1${banner}`);
        html = html.replace('Бронь сохраняется в демонстрационной базе;', 'В этой версии бронь не сохраняется;')
          .replace('Отменить запись можно по персональной ссылке до начала занятия.', 'Персональная ссылка в этой версии не создаётся.')
          .replace('Сохраните её и не пересылайте посторонним.', '')
          .replaceAll('Сохраните её и не передавайте посторонним.', '')
          .replaceAll('Демонстрационный проект: запись сохраняется в тестовой базе, реальное занятие не проводится. Используйте тестовые контактные данные.', 'Статическая демонстрация: запись не сохраняется, контакты не отправляются. Реальные занятия не проводятся.')
          .replaceAll('Используем технические cookie для входа хозяйки и сохранения этого уведомления. Во вкладке временно сохраняется ключ незавершённой записи. Аналитики и рекламы нет.', 'Сохраняем только отметку о прочтении этого уведомления. В этой версии нет входа хозяйки, сохранения записи, аналитики и рекламы.')
          .replace('Демонстрационное расписание. Доступность мест обновляется из базы при открытии страницы.', 'Пример расписания на дату сборки. Места условные, онлайн-бронирование отключено.');
        writeFileSync(file, html);
      } else if (entry.name.endsWith('.json') && directory.endsWith('data')) {
        writeFileSync(file, readFileSync(file, 'utf8').replaceAll('"/media/', `"${base}media/`));
      }
    }
  }
  visit(output);
  // These server-only workflows are deliberately absent from the static site.
  for (const sub of ['admin', 'booking/manage', '.vite']) rmSync(join(output, sub), { recursive: true, force: true });
  writeFileSync(join(output, '.nojekyll'), '');
  console.log(`Static demo ready at ${base}; no server or private data included.`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
