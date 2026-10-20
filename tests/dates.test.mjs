import test from 'node:test';
import assert from 'node:assert/strict';
import { dayKey, mondayKey, shiftDay, validDay, sessionState, money, duration, places } from '../src/scripts/services/dates.js';

test('Публичное расписание считает даты по Туле, в том числе в полночь UTC', () => {
  assert.equal(dayKey('2026-10-19T21:01:00Z'), '2026-10-20');
  assert.equal(mondayKey('2026-10-25'), '2026-10-19');
  assert.equal(mondayKey('2026-10-19'), '2026-10-19');
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(validDay('2026-02-30'), false);
  assert.equal(validDay('2028-02-29'), true);
});

test('UI не предлагает прошедшие, отменённые и заполненные сеансы', () => {
  const now = new Date('2026-10-19T12:00:00Z').getTime();
  const session = { startsAt: '2026-10-20T12:00:00Z', status: 'scheduled', available: 3, capacity: 6 };
  assert.equal(sessionState(session, now).canSelect, true);
  assert.equal(sessionState({ ...session, available: 0 }, now).canSelect, false);
  assert.equal(sessionState({ ...session, status: 'cancelled' }, now).canSelect, false);
  assert.equal(sessionState({ ...session, startsAt: '2026-10-19T12:00:00Z' }, now).canSelect, false);
});

test('Цена, длительность и места имеют согласованное русское представление', () => {
  assert.equal(money(6400).replaceAll('\u00a0', ' '), '6 400 ₽');
  assert.equal(duration(150), '2 ч 30 мин');
  assert.equal(duration(120), '2 ч');
  assert.equal(places(1), '1 место');
  assert.equal(places(3), '3 места');
  assert.equal(places(8), '8 мест');
});
