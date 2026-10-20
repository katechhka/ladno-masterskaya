import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from '../server/services/catalog.mjs';

// Локальный список создаётся из путей, возвращённых встроенным image_gen.
const assets = JSON.parse(readFileSync(resolve(projectRoot, '.cache/image-import.json'), 'utf8'));
const output = resolve(projectRoot, 'src/assets/images/originals');
mkdirSync(output, { recursive: true });
for (const asset of assets) {
  if (!/^[a-z0-9-]+$/.test(asset.id)) throw new Error('Недопустимый идентификатор изображения');
  copyFileSync(asset.source, resolve(output, `${asset.id}.png`));
}
console.log(`Скопировано сгенерированных оригиналов: ${assets.length}.`);
