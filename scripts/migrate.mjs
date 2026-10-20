import { openDatabase, migrate } from '../server/db/database.mjs';

const db = openDatabase();
try {
  console.log(`Применено миграций: ${migrate(db)}.`);
} finally {
  db.close();
}
