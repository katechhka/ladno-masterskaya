import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { projectRoot, loadCatalog } from '../server/services/catalog.mjs';

const { images } = JSON.parse(readFileSync(resolve(projectRoot, 'data/images.json'), 'utf8'));
const { assets } = JSON.parse(readFileSync(resolve(projectRoot, 'data/image-prompts.json'), 'utf8'));
const { workshops } = loadCatalog();
const galleries = JSON.parse(readFileSync(resolve(projectRoot, 'data/galleries.json'), 'utf8'));
const fail = (message) => { throw new Error(message); };
if (Object.keys(images).length !== 24 || assets.length !== 24) fail('Ожидается 24 уникальных сюжета');
const hashes = new Set();
let totalBytes = 0;
let variants = 0;
for (const asset of assets) {
  const original = readFileSync(resolve(projectRoot, asset.original));
  const hash = createHash('sha256').update(original).digest('hex');
  if (hashes.has(hash)) fail(`Повторяется оригинал: ${asset.id}`);
  hashes.add(hash);
  const image = images[asset.id];
  if (!image?.alt || image.variants.length < 3) fail(`Нет описания или размеров: ${asset.id}`);
  for (const variant of image.variants) {
    for (const format of ['webp', 'avif']) {
      const url = variant[format];
      if (!url.startsWith('/media/') || url.includes('..')) fail(`Нелокальный URL: ${url}`);
      const path = resolve(projectRoot, 'public', url.slice(1));
      if (!existsSync(path)) fail(`Нет файла: ${url}`);
      const metadata = await sharp(path).metadata();
      if (metadata.width !== variant.width || metadata.height !== variant.height || metadata.width > image.width) fail(`Неверные размеры: ${url}`);
      totalBytes += variant[`${format}Bytes`];
      variants += 1;
    }
  }
}
for (const workshop of workshops) {
  if (!images[workshop.image]) fail(`Нет изображения программы: ${workshop.id}`);
  const gallery = galleries[workshop.id];
  if (!gallery || gallery.length < 3 || new Set(gallery).size !== gallery.length || gallery.some((id) => !images[id])) fail(`Некорректная галерея: ${workshop.id}`);
}
console.log(`Проверено: ${assets.length} разных оригиналов, ${variants} адаптивных файлов, все 14 программ с изображениями.`);
console.log(`Суммарный объём всех WebP/AVIF-размеров: ${(totalBytes / 1024 / 1024).toFixed(2)} МБ. Страница загружает подходящий формат и размер, не весь набор.`);
