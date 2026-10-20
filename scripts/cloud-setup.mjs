import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openTurso } from '../server/db/turso.mjs';
import { migrate } from '../server/db/database.mjs';
import { initializeCatalog, storedCatalog } from '../server/services/catalog-store.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { passwordHash } from '../server/services/admin-auth.mjs';
const db = openTurso();
try {
  await migrate(db); console.log('Схема облачной базы обновлена.');
  await initializeCatalog(db);
  console.log('Каталог облачной базы готов.');
  const catalog=await storedCatalog(db,{includeArchived:true});
  const result=await seedSchedule(db,catalog.workshops);
  if(!await db.prepare('SELECT id FROM admin_owner WHERE id=1').get()) {
    const password=randomBytes(24).toString('base64url');
    await db.prepare('INSERT INTO admin_owner (id,username,password_hash) VALUES (1,?,?)').run('owner',await passwordHash(password));
    mkdirSync('storage',{recursive:true});
    writeFileSync('storage/cloud-admin-access.txt',`Доступ к опубликованной мастерской «Ладно»\n\nЛогин: owner\nПароль: ${password}\n\nСохраните пароль в менеджере паролей. Этот файл не публикуется.\n`,{mode:0o600,flag:'wx'});
    console.log('Отдельный облачный доступ сохранён в закрытом storage/cloud-admin-access.txt.');
  }
  console.log(`Каталог: ${catalog.workshops.length} программ. Всего сеансов: ${result.total}. Существующие записи сохранены.`);
} catch(error) {
  console.error('Облачная настройка не завершена:',error.code||error.name,error.cause?.code||'');
  // SQL migration errors contain no contact data; omit arbitrary provider URLs.
  console.error(String(error.message).replace(/https?:\/\/\S+/g,'[provider]').slice(0,300));
  process.exitCode=1;
} finally {await db.close();}
