import { flow } from '../db/flow.mjs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {workshopSchema} from './catalog.mjs';
import {storedCatalog, readMedia} from './catalog-store.mjs';
import {BookingError, publicSessions} from './bookings.mjs';
import {validDay, shiftDay, formatDate, formatTime} from '../../src/scripts/services/dates.js';
const error = (code, message, status = 409) => {
  throw new BookingError(status, code, message);
};
function parse(schema, raw) {
  const result = schema.safeParse(raw);
  if (!result.success) throw new BookingError(422, 'VALIDATION', 'Проверьте поля формы.', Object.fromEntries(result.error.issues.map(i => [i.path.join('.'), i.message])));
  return result.data;
}
const revision = z.number().int().nonnegative();
const programInput = z.object({
  program: workshopSchema,
  gallery: z.array(z.string()).min(2).max(6),
  archived: z.boolean(),
  version: revision
}).strict();
const sessionInput = z.object({
  workshopId: z.string(),
  startsLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  capacity: z.number().int().min(1).max(20),
  bookingOpen: z.boolean(),
  cancel: z.boolean(),
  version: revision,
  confirmed: z.boolean().default(false),
  dates: z.array(z.string()).max(41).default([])
}).strict();
export function adminService(db) {
  const all = flow(function* () {
    return yield storedCatalog(db, {
      includeArchived: true
    });
  });
  const programSave = db.transaction(flow(function* (raw, id) {
    const media = yield readMedia(db);
    const input = parse(programInput, raw);
    const w = input.program;
    const catalog = yield all();
    const old = yield db.prepare('SELECT * FROM workshop_programs WHERE id=?').get(id);
    if (w.id !== id || old && old.slug !== w.slug) error('IMMUTABLE', 'Адрес существующей программы менять нельзя.', 422);
    if ((old?.version || 0) !== input.version) error('VERSION', 'Программу изменили в другой вкладке. Откройте её заново.');
    if (!catalog.site.categories.some(c => c.id === w.category) || !catalog.teachers.some(t => t.id === w.teacherId)) error('REFERENCE', 'Выберите направление и преподавателя из списка.', 422);
    if (!media[w.image] || input.gallery.some(id => !media[id]) || new Set(input.gallery).size !== input.gallery.length) error('IMAGE', 'Выберите разные фотографии из медиатеки.', 422);
    if (new Set(w.relatedIds).size !== w.relatedIds.length || w.relatedIds.some(related => related === w.id || !catalog.workshops.some(item => item.id === related))) error('RELATED', 'Выберите разные программы для рекомендаций.', 422);
    if (yield db.prepare('SELECT id FROM workshop_programs WHERE slug=? AND id!=?').get(w.slug, id)) error('SLUG', 'Такой адрес уже занят.', 422);
    const timestamp = new Date().toISOString();
    if (old) yield db.prepare('UPDATE workshop_programs SET data=?,gallery=?,archived=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(w), JSON.stringify(input.gallery), Number(input.archived), timestamp, id); else yield db.prepare('INSERT INTO workshop_programs (id,slug,data,gallery,archived,updated_at) VALUES (?,?,?,?,?,?)').run(id, w.slug, JSON.stringify(w), JSON.stringify(input.gallery), Number(input.archived), timestamp);
    return {
      saved: true,
      version: (old?.version || 0) + 1
    };
  }));
  const sessionSave = db.transaction(flow(function* (raw, id) {
    const input = parse(sessionInput, raw);
    const old = id ? yield db.prepare('SELECT * FROM sessions WHERE id=?').get(id) : null;
    if (id && !old) error('NOT_FOUND', 'Сеанс не найден.', 404);
    if ((old?.version || 0) !== input.version) error('VERSION', 'Сеанс изменился в другой вкладке. Откройте его заново.');
    const program = (yield all()).workshops.find(w => w.id === input.workshopId);
    if (!program || program.archived && (!old || input.bookingOpen && !input.cancel)) error('ARCHIVED', 'Для открытой записи выберите опубликованную программу.', 422);
    if (old && old.workshop_id !== input.workshopId) error('IMMUTABLE', 'Для другой программы создайте новый сеанс.', 422);
    if (old?.status === 'cancelled') error('CANCELLED', 'Отменённый сеанс нельзя восстановить. Создайте новый.');
    if (old && new Date(old.starts_at) <= new Date()) error('PAST', 'Прошедшие сеансы доступны только для просмотра.');
    if (old && input.dates.length) error('REPEAT', 'Повторение доступно при создании нового сеанса.', 422);
    const occupied = old ? (yield db.prepare("SELECT COALESCE(SUM(quantity),0) AS n FROM bookings WHERE session_id=? AND status='confirmed'").get(id)).n : 0;
    if (!input.cancel && input.capacity < occupied) error('CAPACITY', `Уже забронировано мест: ${occupied}. Вместимость не может быть меньше.`);
    const dates = [...new Set([input.startsLocal.slice(0, 10), ...input.dates])].sort();
    if (input.dates.some(day => !validDay(day) || day < input.startsLocal.slice(0, 10) || day > shiftDay(input.startsLocal.slice(0, 10), 41))) error('DATE', 'Повторение ограничено шестью неделями от первой даты.', 422);
    if (input.dates.length && input.cancel) error('REPEAT', 'Нельзя создавать отменённые повторяющиеся сеансы.', 422);
    const candidates = dates.map(date => {
      if (!validDay(date)) error('DATE', 'Проверьте дату.', 422);
      const start = new Date(`${date}T${input.startsLocal.slice(11)}:00+03:00`);
      if (Number.isNaN(start.getTime()) || start <= new Date()) error('DATE', 'Новая дата должна быть в будущем.', 422);
      return {
        start: start.toISOString(),
        end: new Date(start.getTime() + program.durationMinutes * 60000).toISOString()
      };
    });
    if (old && old.starts_at === candidates[0].start) candidates[0].end = old.ends_at;
    const changed = old && (input.cancel || candidates[0].start !== old.starts_at);
    if (changed && occupied && !input.confirmed) error('CONFIRM_REQUIRED', `Изменение затронет ${occupied} участников. Подтвердите действие и сообщите им лично.`);
    for (const candidate of candidates) {
      if (!input.cancel) {
        const duplicate = yield db.prepare('SELECT id FROM sessions WHERE workshop_id=? AND starts_at=? AND id!=?').get(program.id, candidate.start, id || '');
        if (duplicate) error('DUPLICATE_SESSION', 'Сеанс этой программы на выбранное время уже есть в истории. Выберите другую дату или время.');
        const conflict = yield db.prepare("SELECT id FROM sessions WHERE status='scheduled' AND id!=? AND starts_at<? AND ends_at>?").get(id || '', candidate.end, candidate.start);
        if (conflict || candidates.some(other => other !== candidate && other.start < candidate.end && other.end > candidate.start)) error('OVERLAP', `В мастерской уже есть занятие в выбранное время (${candidate.start.slice(0, 10)}).`);
      }
    }
    const timestamp = new Date().toISOString();
    if (old) {
      if (changed && occupied) {
        const note = input.cancel ? 'Мастерская отменила занятие. Сообщите участнику.' : `Занятие перенесено с ${formatDate(old.starts_at)} ${formatTime(old.starts_at)} на ${formatDate(candidates[0].start)} ${formatTime(candidates[0].start)} (Тула). Сообщите участнику.`;
        yield db.prepare("UPDATE bookings SET notification_required=1,change_note=? WHERE session_id=? AND status='confirmed'").run(note, id);
      }
      if (input.cancel) yield db.prepare("UPDATE bookings SET status='cancelled',cancelled_at=? WHERE session_id=? AND status='confirmed'").run(timestamp, id);
      yield db.prepare('UPDATE sessions SET starts_at=?,ends_at=?,capacity=?,booking_open=?,status=?,version=version+1 WHERE id=?').run(candidates[0].start, candidates[0].end, input.cancel ? old.capacity : input.capacity, Number(input.bookingOpen && !input.cancel), input.cancel ? 'cancelled' : 'scheduled', id);
    } else {
      if (input.cancel) error('CANCELLED', 'Создайте активный сеанс.', 422);
      for (const c of candidates) yield db.prepare('INSERT INTO sessions (id,workshop_id,starts_at,ends_at,capacity,booking_open,created_at) VALUES (?,?,?,?,?,?,?)').run(`session-${randomUUID()}`, program.id, c.start, c.end, input.capacity, Number(input.bookingOpen), timestamp);
    }
    return {
      saved: true,
      count: candidates.length,
      affectedParticipants: changed ? occupied : 0
    };
  }));
  const bookings = flow(function* bookings(query = {}) {
    const where = [];
    const args = [];
    if (query.session) {
      where.push('b.session_id=?');
      args.push(String(query.session));
    }
    if (['confirmed', 'cancelled'].includes(query.status)) {
      where.push('b.status=?');
      args.push(query.status);
    }
    if (query.day && validDay(query.day)) {
      where.push("substr(datetime(s.starts_at,'+3 hours'),1,10)=?");
      args.push(query.day);
    }
    const rows = yield db.prepare(`SELECT b.id,b.reference,b.session_id AS sessionId,b.customer_name AS name,b.phone,b.email,b.comment,b.quantity,
      b.total_kopecks/100.0 AS totalRub,b.status,b.data_erased_at AS dataErasedAt,b.notification_required AS notificationRequired,b.change_note AS changeNote,s.starts_at AS startsAt,s.workshop_id AS workshopId
      FROM bookings b JOIN sessions s ON s.id=b.session_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY b.created_at DESC,b.rowid DESC ${query.q ? '' : 'LIMIT 201'}`).all(...args);
    const normalize = value => String(value || '').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
    const filtered = query.q ? rows.filter(row => [row.reference, row.name, row.phone, row.email].some(value => normalize(value).includes(normalize(String(query.q).slice(0, 100))))) : rows;
    return {
      bookings: filtered.slice(0, 200),
      more: filtered.length > 200
    };
  });
  return {
    programSave: flow(function* (raw, id) {
      return yield programSave.immediate(raw, id);
    }),
    sessionSave: flow(function* (raw, id) {
      return yield sessionSave.immediate(raw, id);
    }),
    bootstrap: flow(function* () {
      const sessions = yield publicSessions(db);
      return {
        ...yield all(),
        images: yield readMedia(db),
        sessions
      };
    }),
    bookings,
    bookingAction: flow(function* (id, raw) {
      const {action} = parse(z.object({
        action: z.enum(['cancel', 'notified']),
        confirmed: z.literal(true)
      }).strict(), raw);
      return yield db.transaction(flow(function* () {
        const booking = yield db.prepare('SELECT id,status FROM bookings WHERE id=?').get(id);
        if (!booking) error('NOT_FOUND', 'Бронь не найдена.', 404);
        if (action === 'notified') yield db.prepare('UPDATE bookings SET notification_required=0 WHERE id=?').run(id); else if (booking.status !== 'cancelled') yield db.prepare("UPDATE bookings SET status='cancelled',cancelled_at=?,notification_required=1,change_note='Мастерская отменила бронь. Сообщите участнику.' WHERE id=?").run(new Date().toISOString(), id);
        return {
          saved: true
        };
      })).immediate();
    })
  };
}
