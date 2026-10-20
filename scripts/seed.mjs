import { openDatabase, migrate } from '../server/db/database.mjs';
import { loadCatalog } from '../server/services/catalog.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { initializeCatalog } from '../server/services/catalog-store.mjs';

const { workshops } = loadCatalog();
const db = openDatabase();
try {
  migrate(db);
  initializeCatalog(db);
  const result = seedSchedule(db, workshops);
  console.log(`Дата наполнения (Тула): ${result.anchorDay}. Добавлено сеансов: ${result.inserted}. Всего: ${result.total}.`);
  console.log('Существующие записи и брони сохранены. Контактные данные в вывод не включаются.');
} finally {
  db.close();
}
