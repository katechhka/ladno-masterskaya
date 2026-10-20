import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, copyFile, writeFile, lstat, realpath, readdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { constants } from 'node:fs';
import { z } from 'zod';
import { migrate } from '../../server/db/database.mjs';
import { uploadFilename } from '../../server/services/media.mjs';
import { purgeExpiredContacts } from '../../server/services/privacy.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileSchema = z.object({ name: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const manifestSchema = z.object({
  format: z.literal('ladno-backup-v1'), createdAt: z.iso.datetime(),
  database: fileSchema.extend({ name: z.literal('ladno.sqlite') }),
  images: z.array(fileSchema.extend({ name: z.string().regex(uploadFilename) })).max(3000)
}).strict();

function inside(parent, child) {
  const path = relative(parent, child);
  return path && !path.startsWith('..') && !isAbsolute(path);
}

async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Ожидался обычный файл без символической ссылки.');
}

function inspectDatabase(db) {
  if (db.pragma('quick_check', { simple: true }) !== 'ok' || db.pragma('foreign_key_check').length) {
    throw new Error('Проверка целостности SQLite не пройдена.');
  }
  const installed = db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map(row => row.name);
  if (!installed.includes('005-privacy.sql')) throw new Error('Сначала обновите базу до текущей версии проекта.');
  const names = new Set();
  for (const row of db.prepare('SELECT data FROM media_uploads').all()) {
    const image = JSON.parse(row.data);
    for (const variant of image.variants) {
      for (const url of [variant.webp, variant.avif]) {
        if (typeof url !== 'string' || !url.startsWith('/media/') || !uploadFilename.test(url.slice(7))) {
          throw new Error('В базе обнаружен некорректный путь фотографии.');
        }
        names.add(url.slice(7));
      }
    }
  }
  return { installed, names: [...names].sort() };
}

export async function createBackup({ databasePath, uploadsDirectory, outputDirectory }) {
  const source = resolve(databasePath);
  await regularFile(source);
  const root = resolve(outputDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const destination = resolve(root, `ladno-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`);
  await mkdir(destination, { mode: 0o700 });
  const databaseFile = resolve(destination, 'ladno.sqlite');
  const live = new Database(source, { readonly: true, fileMustExist: true });
  try { live.pragma('busy_timeout = 5000'); await live.backup(databaseFile); }
  finally { live.close(); }
  const snapshot = new Database(databaseFile, { readonly: true, fileMustExist: true });
  let names;
  try { names = inspectDatabase(snapshot).names; }
  finally { snapshot.close(); }
  await mkdir(resolve(destination, 'uploads'), { mode: 0o700 });
  const images = [];
  for (const name of names) {
    const path = resolve(uploadsDirectory, name);
    await regularFile(path);
    const bytes = await readFile(path);
    await writeFile(resolve(destination, 'uploads', name), bytes, { flag: 'wx', mode: 0o600 });
    images.push({ name, sha256: digest(bytes) });
  }
  const manifest = { format: 'ladno-backup-v1', createdAt: new Date().toISOString(),
    database: { name: 'ladno.sqlite', sha256: digest(await readFile(databaseFile)) }, images };
  // Маркер завершения пишется последним: неполная копия не принимается восстановлением.
  await writeFile(resolve(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { directory: destination, images: images.length };
}

export async function restoreBackup({ backupDirectory, targetDirectory, now = new Date() }) {
  const source = await realpath(resolve(backupDirectory));
  const target = resolve(targetDirectory);
  // Назначение должно быть новым, а не находиться внутри восстанавливаемой копии.
  const parent = await realpath(dirname(target));
  const physicalTarget = resolve(parent, basename(target));
  if (physicalTarget === source || inside(source, physicalTarget)) throw new Error('Выберите новый каталог вне резервной копии.');
  await regularFile(resolve(source, 'manifest.json'));
  const manifest = manifestSchema.parse(JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8')));
  const files = [{ ...manifest.database, path: manifest.database.name }, ...manifest.images.map(file => ({ ...file, path: `uploads/${file.name}` }))];
  if (new Set(manifest.images.map(file => file.name)).size !== manifest.images.length) throw new Error('В копии повторяются имена фотографий.');
  if (manifest.images.length) {
    const uploads = await lstat(resolve(source, 'uploads'));
    if (!uploads.isDirectory() || uploads.isSymbolicLink()) throw new Error('Каталог фотографий не должен быть символической ссылкой.');
  }
  for (const file of files) {
    const path = resolve(source, file.path);
    await regularFile(path);
    if (digest(await readFile(path)) !== file.sha256) throw new Error('Контрольная сумма не совпала. Копия повреждена или изменена.');
  }
  const snapshot = new Database(resolve(source, 'ladno.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const { names, installed } = inspectDatabase(snapshot);
    const known = await readdir(new URL('../../server/db/migrations/', import.meta.url));
    if (installed.some(name => !known.includes(name))) throw new Error('Копия создана более новой версией проекта. Сначала обновите код.');
    if (JSON.stringify(names) !== JSON.stringify(manifest.images.map(file => file.name).sort())) throw new Error('Фотографии копии не соответствуют базе.');
  } finally { snapshot.close(); }
  await mkdir(physicalTarget, { mode: 0o700 });
  await mkdir(resolve(physicalTarget, 'uploads'), { mode: 0o700 });
  for (const file of files) await copyFile(resolve(source, file.path), resolve(physicalTarget, file.path), constants.COPYFILE_EXCL);
  const db = new Database(resolve(physicalTarget, 'ladno.sqlite'));
  let erased;
  try {
    db.pragma('foreign_keys = ON'); migrate(db);
    erased = purgeExpiredContacts(db, now);
    db.transaction(() => {
      db.prepare('DELETE FROM admin_sessions').run();
      db.prepare("UPDATE telegram_confirmations SET status='unknown', updated_at=? WHERE status IN ('pending','sending')").run(now.toISOString());
    }).immediate();
    inspectDatabase(db);
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
  return { directory: physicalTarget, images: manifest.images.length, erased };
}
