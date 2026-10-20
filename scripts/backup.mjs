import { resolve } from 'node:path';
import { projectRoot } from '../server/services/catalog.mjs';
import { createBackup } from './lib/backups.mjs';

try {
  if (process.argv.length > 2) throw new Error('Команда не принимает аргументы. Настройте BACKUP_DIR в .env.');
  const result = await createBackup({
    databasePath: resolve(projectRoot, process.env.DATABASE_PATH || 'storage/ladno.sqlite'),
    uploadsDirectory: resolve(projectRoot, process.env.UPLOADS_DIR || 'storage/uploads'),
    outputDirectory: resolve(projectRoot, process.env.BACKUP_DIR || 'storage/backups')
  });
  console.log(`Резервная копия завершена: ${result.directory}. Файлов фотографий: ${result.images}. Храните копию вне публичного доступа.`);
} catch {
  console.error('Копия не создана полностью. Проверьте наличие базы, фотографий, доступ и свободное место. Каталоги без manifest.json не готовы к восстановлению.');
  process.exitCode = 1;
}
