import { restoreBackup } from './lib/backups.mjs';

try {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--from' || args[2] !== '--to') {
    throw new Error('Формат: npm run backup:restore -- --from ПУТЬ_КОПИИ --to НОВЫЙ_КАТАЛОГ');
  }
  const result = await restoreBackup({ backupDirectory: args[1], targetDirectory: args[3] });
  console.log(`Восстановлено в новый каталог: ${result.directory}. Файлов фото: ${result.images}. Очищено устаревших контактов: ${result.erased}.`);
  console.log('Рабочие пути не менялись. Остановите сайт и бота, проверьте результат и укажите новые DATABASE_PATH и UPLOADS_DIR в .env. Затем запустите их заново. Старые сеансы входа отозваны.');
} catch {
  console.error('Восстановление не завершено. Нужны --from ПУТЬ_КОПИИ --to НОВЫЙ_КАТАЛОГ с существующим родителем. Проверьте целостность копии, права и свободное место. Рабочая база не заменяется; неполный новый каталог не подключайте.');
  process.exitCode = 1;
}
