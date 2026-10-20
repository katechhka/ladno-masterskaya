import { loadCatalog } from '../server/services/catalog.mjs';

const { workshops, teachers, site } = loadCatalog();
console.log(`Контент проверен: ${workshops.length} программ, ${teachers.length} преподавателя, ${site.categories.length} направлений.`);
console.log('Файлы и размеры изображений проверяются отдельно: npm run assets:check.');
