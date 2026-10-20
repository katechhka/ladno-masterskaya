import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const read = (name) => JSON.parse(readFileSync(new URL(`../../data/${name}.json`, import.meta.url), 'utf8'));
const text = z.string().trim().min(1);
const identifier = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const workshopSchema = z.object({
  id: identifier, slug: identifier, title: text, category: identifier,
  summary: text, process: z.array(text).min(3), result: text,
  priceRub: z.number().int().positive().max(100000),
  durationMinutes: z.number().int().min(30).max(480),
  minAge: z.number().int().min(6).max(18), level: text,
  capacity: z.number().int().min(1).max(20), teacherId: identifier,
  materials: z.array(text).min(4), preparation: text, pickup: text,
  image: identifier, imageAlt: text, relatedIds: z.array(identifier).min(2)
}).strict();
const teacherSchema = z.object({ id: identifier, name: text, role: text, bio: text }).strict();
const sectionSchema = z.object({ title: text, text });
const siteSchema = z.object({
  name: text, tagline: text, city: text, timezone: z.literal('Europe/Moscow'), currency: z.literal('RUB'),
  hero: z.object({ title: text, description: text }), about: text,
  location: text, locationNote: text, demoNotice: text, footerNotice: text, paymentNotice: text,
  categories: z.array(z.object({ id: identifier, name: text, description: text })).min(7),
  rules: z.array(sectionSchema).min(6),
  faq: z.array(z.object({ question: text, answer: text })).min(5),
  privacy: z.object({ title: text, paragraphs: z.array(text).min(4) })
}).strict();

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`Повторяющиеся значения: ${label}`);
}

export function validateCatalog(input) {
  const workshops = z.array(workshopSchema).min(12).max(15).parse(input.workshops);
  const teachers = z.array(teacherSchema).min(3).max(4).parse(input.teachers);
  const site = siteSchema.parse(input.site);
  unique(workshops.map((item) => item.id), 'ID программы');
  unique(workshops.map((item) => item.slug), 'адрес программы');
  unique(teachers.map((item) => item.id), 'ID преподавателя');
  unique(site.categories.map((item) => item.id), 'ID направления');
  const teacherIds = new Set(teachers.map((item) => item.id));
  const categoryIds = new Set(site.categories.map((item) => item.id));
  const workshopIds = new Set(workshops.map((item) => item.id));
  for (const item of workshops) {
    if (!teacherIds.has(item.teacherId)) throw new Error(`Неизвестный преподаватель: ${item.id}`);
    if (!categoryIds.has(item.category)) throw new Error(`Неизвестное направление: ${item.id}`);
    unique(item.relatedIds, `связанные программы ${item.id}`);
    if (item.relatedIds.some((id) => !workshopIds.has(id) || id === item.id)) {
      throw new Error(`Некорректные связанные программы: ${item.id}`);
    }
  }
  for (const category of site.categories) {
    if (!workshops.some((item) => item.category === category.id)) throw new Error(`Пустое направление: ${category.id}`);
  }
  return { site, workshops, teachers };
}

export function loadCatalog() {
  return validateCatalog({ workshops: read('workshops'), teachers: read('teachers'), site: read('site') });
}

export const workshopPath = (workshop) => `/master-classes/${workshop.slug}/`;
