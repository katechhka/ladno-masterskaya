import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import nunjucks from 'nunjucks';
import { loadCatalog, projectRoot, workshopPath } from '../server/services/catalog.mjs';
import { exportPublicData } from '../server/services/public-data.mjs';

export function renderDocuments(catalog = loadCatalog(), { entryScript = `/@fs/${resolve(projectRoot, 'src/scripts/main.js').replaceAll('\\', '/')}`, styles = [], path, media, publicOrigin = (process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '') } = {}) {
  const designDirections = catalog.site.categories.map((category) => {
    const programs = catalog.workshops.filter((workshop) => workshop.category === category.id);
    return { ...category, count: programs.length, countLabel: programs.length === 1 ? 'занятие' : 'занятия', image: programs[0]?.image };
  }).filter((direction) => direction.count);
  const images = media || JSON.parse(readFileSync(resolve(projectRoot, 'data/images.json'), 'utf8')).images;
  const galleries = JSON.parse(readFileSync(resolve(projectRoot, 'data/galleries.json'), 'utf8'));
  const legal = JSON.parse(readFileSync(resolve(projectRoot,'data/legal.json'),'utf8'));
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(resolve(projectRoot, 'src')), {
    autoescape: true, throwOnUndefined: true, noCache: true
  });
  const routes = [
    { path: '/design/', title: 'Визуальная система — Ладно', description: 'Авторский дизайн, компоненты и сгенерированные изображения мастерской «Ладно».', kind: 'design' },
    { path: '/', title: 'Ладно — творческая мастерская в Туле', description: catalog.site.hero.description, kind: 'home' },
    { path: '/master-classes/', title: 'Мастер-классы — Ладно', description: 'Программы для знакомства с красками, глиной, графикой и украшениями.', kind: 'catalog' },
    { path: '/schedule/', title: 'Расписание — Ладно', description: 'Даты творческих мастер-классов в Туле. Время указано по Москве.', kind: 'schedule' },
    { path: '/booking/', title: 'Запись на занятие — Ладно', description: 'Демонстрационная запись на мастер-класс.', kind: 'booking' },
    { path: '/booking/manage/', title: 'Управление бронью — Ладно', description: 'Просмотр и отмена записи по персональной ссылке.', kind: 'manage' },
    { path: '/rules/', title: 'Правила посещения — Ладно', description: 'Материалы, сопровождение, отмена записи и получение работ.', kind: 'rules' },
    ...['privacy','consent','cookies'].map(kind=>({path:`/${kind}/`,title:`${legal[kind].title} — Ладно`,description:legal[kind].intro,kind,document:legal[kind]})),
    { path: '/404.html', title: 'Страница не найдена — Ладно', description: 'Такой страницы нет. Вернитесь к выбору мастер-класса.', kind: '404' },
    { path: '/admin/', title: 'Управление мастерской — Ладно', description: 'Закрытая панель управления мастерской.', kind: 'admin' },
    ...catalog.workshops.map((workshop) => ({ path: workshopPath(workshop), title: `${workshop.title} — Ладно`, description: workshop.summary, kind: 'workshop', workshop }))
  ];
  const headings = { home: 'Главная', catalog: 'Мастер-классы', schedule: 'Расписание', booking: 'Запись', manage: 'Управление записью', rules: 'Правила посещения', privacy: 'Политика обработки данных', consent:'Согласие на обработку',cookies:'Cookie', '404': 'Страница не найдена', design: 'Визуальная система' };
  const templates = { home: 'home', catalog: 'catalog', workshop: 'workshop', schedule: 'schedule', rules: 'info', privacy: 'legal',consent:'legal',cookies:'legal', booking: 'booking-preview', manage: 'booking-preview', '404': 'not-found', design: 'design', admin: 'admin' };
  env.addFilter('money', (value) => `${new Intl.NumberFormat('ru-RU').format(value)} ₽`);
  env.addFilter('duration', (value) => [Math.floor(value / 60) ? `${Math.floor(value / 60)} ч` : '', value % 60 ? `${value % 60} мин` : ''].filter(Boolean).join(' '));
  return routes.filter((page) => !path || page.path === path).map((page) => {
    page.heading = headings[page.kind];
    page.shareImage = `/media/${page.workshop?.image || 'hero'}-1200.webp`;
    if (page.kind === 'workshop') {
      page.gallery = page.workshop.gallery || galleries[page.workshop.id];
      page.teacher = { ...catalog.teachers.find((teacher) => teacher.id === page.workshop.teacherId) };
      page.teacher.initials = page.teacher.name.split(' ').map((part) => part[0]).join('');
      page.category = catalog.site.categories.find((category) => category.id === page.workshop.category);
      page.related = page.workshop.relatedIds.map((id) => catalog.workshops.find((workshop) => workshop.id === id)).filter(Boolean);
    }
    const template = `pages/${templates[page.kind]}.njk`;
    return { path: page.path, html: env.render(template, { ...catalog, images, legal, designDirections, page, entryScript, styles, publicOrigin }) };
  });
}

export function generatePages() {
  exportPublicData();
  return renderDocuments().map(({ path, html }) => {
    const filename = path.endsWith('.html') ? path.slice(1) : `${path.slice(1)}index.html`;
    const absolute = resolve(projectRoot, '.generated', filename); mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, html, 'utf8'); return absolute;
  });
}
