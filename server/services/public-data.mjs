import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, migrate } from '../db/database.mjs';
import { projectRoot } from './catalog.mjs';
import { initializeCatalog, storedCatalog } from './catalog-store.mjs';

export function exportPublicData() {
  let catalog;
  const filename = process.env.DATABASE_PATH || 'storage/ladno.sqlite';
  if (!existsSync(resolve(projectRoot, filename))) throw new Error('Нет базы расписания. Выполните npm run db:seed.');
  const db = openDatabase(filename);
  let sessions;
  try {
    migrate(db); initializeCatalog(db); catalog = storedCatalog(db);
    // Только публичные поля. Контакты, номера броней и хеши токенов не выбираются.
    sessions = db.prepare(`SELECT s.id, s.workshop_id AS workshopId, s.starts_at AS startsAt,
      s.ends_at AS endsAt, s.capacity, s.status,
      s.capacity - COALESCE(SUM(CASE WHEN b.status = 'confirmed' THEN b.quantity ELSE 0 END), 0) AS available
      FROM sessions s LEFT JOIN bookings b ON b.session_id = s.id
      GROUP BY s.id ORDER BY s.starts_at`).all();
  } finally { db.close(); }
  const programs = catalog.workshops.map((workshop) => ({
    id: workshop.id, slug: workshop.slug, title: workshop.title, summary: workshop.summary,
    category: workshop.category,
    categoryName: catalog.site.categories.find((category) => category.id === workshop.category).name,
    priceRub: workshop.priceRub, durationMinutes: workshop.durationMinutes,
    minAge: workshop.minAge, capacity: workshop.capacity,
    thumbnail: `/media/${workshop.image}-480.avif`, imageAlt: workshop.imageAlt
  }));
  const directory = resolve(projectRoot, 'public/data');
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'catalog.json'), `${JSON.stringify({ programs }, null, 2)}\n`);
  writeFileSync(resolve(directory, 'schedule.json'), `${JSON.stringify({
    generatedAt: new Date().toISOString(), timezone: 'Europe/Moscow', mode: 'preview', sessions
  }, null, 2)}\n`);
  return { sessions: sessions.length, programs: programs.length };
}
