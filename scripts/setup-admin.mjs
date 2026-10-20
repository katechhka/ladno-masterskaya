import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase, migrate } from '../server/db/database.mjs';
import { initializeCatalog } from '../server/services/catalog-store.mjs';
import { passwordHash } from '../server/services/admin-auth.mjs';
import { projectRoot } from '../server/services/catalog.mjs';

const db = openDatabase();
try {
  migrate(db); initializeCatalog(db);
  const existing = db.prepare('SELECT id FROM admin_owner WHERE id=1').get();
  if (existing && !process.argv.includes('--reset')) {
    console.log('Владелец уже настроен. Существующий доступ сохранён. Для явного сброса: npm run admin:setup -- --reset');
  } else {
    const username = 'owner'; const password = randomBytes(18).toString('base64url'); const encoded = await passwordHash(password);
    db.transaction(() => {
      db.prepare('INSERT INTO admin_owner (id,username,password_hash) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash').run(username,encoded);
      db.prepare('DELETE FROM admin_sessions').run();
    }).immediate();
    const path = resolve(projectRoot,'storage/admin-access.txt'); mkdirSync(resolve(projectRoot,'storage'),{recursive:true});
    writeFileSync(path,`Ладно — доступ хозяйки\n\nАдрес: /admin/\nЛогин: ${username}\nПароль: ${password}\n\nСохраните пароль в менеджере паролей и удалите этот файл.\nНе публикуйте его и не пересылайте в чат.\nСброс пароля: npm run admin:setup -- --reset\nСброс завершает все сеансы входа.\n`,{mode:0o600});
    console.log('Доступ создан. Логин и случайный пароль сохранены в storage/admin-access.txt. Сохраните их в менеджере паролей и удалите файл.');
  }
} finally { db.close(); }
