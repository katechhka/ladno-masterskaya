import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog, validateCatalog, workshopPath } from '../server/services/catalog.mjs';
import { createDemoSessions, moscowDay } from '../server/services/schedule-seed.mjs';

test('Каталог содержит полные программы и корректные связи', () => {
  const catalog = loadCatalog();
  assert.equal(catalog.workshops.length, 14);
  assert.equal(catalog.teachers.length, 4);
  assert.equal(catalog.site.categories.length, 7);
  assert.equal(workshopPath(catalog.workshops[0]), '/master-classes/tsvet-tikhogo-utra/');
  assert.ok(catalog.workshops.filter((item) => item.category === 'ceramics').every((item) => item.pickup.includes('21–28')));
});

test('Ошибки цены, адреса и ссылок останавливают сборку контента', () => {
  const invalidPrice = loadCatalog();
  invalidPrice.workshops[0].priceRub = -1;
  assert.throws(() => validateCatalog(invalidPrice));
  const duplicateSlug = loadCatalog();
  duplicateSlug.workshops[0].slug = duplicateSlug.workshops[1].slug;
  assert.throws(() => validateCatalog(duplicateSlug), /адрес программы/);
  const invalidTeacher = loadCatalog();
  invalidTeacher.workshops[0].teacherId = 'missing';
  assert.throws(() => validateCatalog(invalidTeacher), /Неизвестный преподаватель/);
});

test('Дата наполнения учитывает полночь в Туле', () => {
  assert.equal(moscowDay(new Date('2026-10-19T21:30:00.000Z')), '2026-10-20');
});

test('Шесть недель: занятия не пересекаются и программы представлены все', () => {
  const { workshops } = loadCatalog();
  const sessions = createDemoSessions(workshops, { anchorDay: '2026-10-19', createdAt: '2026-10-19T08:00:00.000Z' });
  assert.equal(new Set(sessions.map((item) => item.workshopId)).size, 14);
  assert.equal(new Set(sessions.map((item) => item.id)).size, sessions.length);
  assert.ok(sessions.some((item) => item.startsAt < '2026-10-19T00:00:00.000Z'));
  assert.ok(sessions.every((item) => item.startsAt < '2026-11-30T00:00:00.000Z'));
  for (let index = 1; index < sessions.length; index += 1) {
    assert.ok(sessions[index - 1].endsAt <= sessions[index].startsAt, 'В одной мастерской не должно быть одновременных занятий');
  }
});
