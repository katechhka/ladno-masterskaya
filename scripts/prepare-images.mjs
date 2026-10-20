import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { projectRoot, loadCatalog } from '../server/services/catalog.mjs';

const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'data/image-prompts.json'), 'utf8'));
const { workshops } = loadCatalog();
const captions = {
  hero: 'Руки формируют глиняную чашу за деревянным столом в светлой мастерской',
  'studio-wide': 'Общий деревянный стол у окна и полки с материалами в вымышленной мастерской',
  'gallery-ceramic-result': 'Готовые керамические чашка, пиала и тарелка с прозрачной глазурью',
  'gallery-paint-detail': 'Фактурные терракотовые и кобальтовые мазки акрила на холсте',
  'gallery-print-detail': 'Растительная линогравюра терракотовой краской на фактурной бумаге',
  'gallery-jewelry-detail': 'Готовая пара геометричных серёг из полимерной глины на керамическом подносе',
  'materials-table': 'Глина, бумага, краски, карандаши и льняная ткань на рабочем столе',
  'process-together': 'Двое участников рисуют акварелью за общим рабочим столом',
  'studio-shelves': 'Полки с керамикой, кистями, деревянными инструментами и льняными фартуками',
  'clay-tools': 'Деревянные стеки, губка, петля и миска со шликером для работы с глиной'
};
const outputDir = resolve(projectRoot, 'public/media');
mkdirSync(outputDir, { recursive: true });
const images = {};
// Небольшой параллелизм ограничивает потребление памяти при подготовке AVIF.
sharp.concurrency(2);
for (const entry of manifest.assets) {
  const source = resolve(projectRoot, entry.original);
  const metadata = await sharp(source).metadata();
  const widths = [480, 800, 1200];
  if (['hero', 'studio-wide'].includes(entry.id)) widths.push(1536);
  const variants = [];
  for (const width of widths.filter((width) => width <= metadata.width)) {
    const base = `${entry.id}-${width}`;
    const height = Math.round(metadata.height * width / metadata.width);
    const [webp, avif] = await Promise.all([
      sharp(source).resize({ width, withoutEnlargement: true }).webp({ quality: 80, effort: 4 }).toFile(resolve(outputDir, `${base}.webp`)),
      sharp(source).resize({ width, withoutEnlargement: true }).avif({ quality: 48, effort: 4 }).toFile(resolve(outputDir, `${base}.avif`))
    ]);
    variants.push({ width, height, webp: `/media/${base}.webp`, avif: `/media/${base}.avif`, webpBytes: webp.size, avifBytes: avif.size });
  }
  images[entry.id] = {
    id: entry.id, alt: workshops.find((workshop) => workshop.image === entry.id)?.imageAlt || captions[entry.id],
    width: metadata.width, height: metadata.height, focalPoint: entry.id === 'hero' ? '59% 50%' : '50% 50%',
    src: variants.at(-1).webp,
    webpSrcset: variants.map((item) => `${item.webp} ${item.width}w`).join(', '),
    avifSrcset: variants.map((item) => `${item.avif} ${item.width}w`).join(', '), variants
  };
  if (!images[entry.id].alt) throw new Error(`Нет альтернативного текста: ${entry.id}`);
  console.log(`Подготовлено: ${entry.id}`);
}
writeFileSync(resolve(projectRoot, 'data/images.json'), `${JSON.stringify({ generator: 'built-in image_gen', images }, null, 2)}\n`);
console.log(`Готово: ${Object.keys(images).length} оригинальных сюжетов, WebP и AVIF.`);
