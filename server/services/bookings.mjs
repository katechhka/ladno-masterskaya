import { flow } from '../db/flow.mjs';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {z} from 'zod';
import {loadCatalog} from './catalog.mjs';
import {normalizePhone, isValidPhone} from '../../shared/phone.js';
import {CONSENT_VERSION} from '../../shared/consents.js';
import {eraseBookingContacts} from './privacy.mjs';
export {normalizePhone} from '../../shared/phone.js';
export class BookingError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    Object.assign(this, {
      status,
      code,
      fields
    });
  }
}
const hash = value => createHash('sha256').update(value).digest('hex');
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const inputSchema = z.object({
  sessionId: z.string().min(1).max(100),
  quantity: z.number().int().min(1).max(20),
  expectedUnitPriceRub: z.number().int().positive(),
  name: z.string().trim().min(2, 'Укажите имя: от 2 символов.').max(100),
  phone: z.string().max(40).transform(normalizePhone).refine(isValidPhone, 'Введите полный номер телефона. Для +7 нужно 10 цифр после кода страны.'),
  email: z.string().trim().toLowerCase().pipe(z.email('Проверьте адрес email.').max(254)),
  comment: z.string().trim().max(1000).default(''),
  privacyConsent: z.literal(true, 'Нужно согласие на обработку данных.'),
  policyConsent: z.literal(true, 'Подтвердите ознакомление с политикой обработки данных.'),
  rulesConsent: z.literal(true, 'Подтвердите условия записи.'),
  managementToken: tokenSchema
}).strict();
export function publicPrograms(catalog = loadCatalog()) {
  return catalog.workshops.map(w => ({
    id: w.id,
    slug: w.slug,
    title: w.title,
    summary: w.summary,
    category: w.category,
    categoryName: catalog.site.categories.find(c => c.id === w.category).name,
    priceRub: w.priceRub,
    durationMinutes: w.durationMinutes,
    minAge: w.minAge,
    capacity: w.capacity,
    thumbnail: `/media/${w.image}-480.avif`,
    imageAlt: w.imageAlt
  }));
}
export const publicSessions = flow(function* publicSessions(db) {
  return yield db.prepare(`SELECT s.id, s.version, s.booking_open AS bookingOpen, s.workshop_id AS workshopId, s.starts_at AS startsAt,
    s.ends_at AS endsAt, s.capacity, CASE WHEN s.status='scheduled' AND s.booking_open=0 THEN 'closed' ELSE s.status END AS status,
    s.capacity - COALESCE(SUM(CASE WHEN b.status='confirmed' THEN b.quantity ELSE 0 END),0) AS available
    FROM sessions s LEFT JOIN bookings b ON b.session_id=s.id GROUP BY s.id ORDER BY s.starts_at`).all();
});
export function createBookingService(db, {catalog = loadCatalog, now = () => new Date()} = {}) {
  const details = flow(function* details(id) {
    const row = yield db.prepare(`SELECT b.*, s.workshop_id, s.starts_at, s.ends_at FROM bookings b
      JOIN sessions s ON s.id=b.session_id WHERE b.id=?`).get(id);
    const program = (yield catalog()).workshops.find(w => w.id === row.workshop_id);
    return {
      reference: row.reference,
      status: row.status,
      quantity: row.quantity,
      unitPriceRub: row.unit_price_kopecks / 100,
      totalRub: row.total_kopecks / 100,
      name: row.customer_name,
      phone: row.phone,
      email: row.email,
      comment: row.comment,
      pickup: program?.pickup || '',
      createdAt: row.created_at,
      cancelledAt: row.cancelled_at,
      dataErasedAt: row.data_erased_at,
      session: {
        id: row.session_id,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        program: {
          title: program?.title || 'Занятие мастерской',
          slug: program?.slug,
          priceRub: row.unit_price_kopecks / 100
        }
      }
    };
  });
  const findToken = flow(function* findToken(token) {
    if (!tokenSchema.safeParse(token).success) throw new BookingError(404, 'NOT_FOUND', 'Запись не найдена или персональная ссылка недействительна.');
    const row = yield db.prepare('SELECT id FROM bookings WHERE management_token_hash=?').get(hash(token));
    if (!row) throw new BookingError(404, 'NOT_FOUND', 'Запись не найдена или персональная ссылка недействительна.');
    return row.id;
  });
  const create = db.transaction(flow(function* (raw, key) {
    if (typeof key !== 'string' || !(/^[a-zA-Z0-9-]{32,100}$/).test(key)) throw new BookingError(400, 'INVALID_KEY', 'Не удалось подготовить запрос. Обновите страницу.');
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) {
      const fields = Object.fromEntries(parsed.error.issues.map(issue => [issue.path[0] || 'form', issue.message]));
      throw new BookingError(422, 'VALIDATION', 'Проверьте заполнение формы.', fields);
    }
    const input = parsed.data;
    const fingerprint = hash(JSON.stringify(input));
    const previous = yield db.prepare('SELECT * FROM idempotency_keys WHERE key=?').get(key);
    if (previous) {
      if (previous.request_hash !== fingerprint) throw new BookingError(409, 'REQUEST_CHANGED', 'Этот запрос уже использован с другими данными. Проверьте сохранённую запись по персональной ссылке.');
      return {
        booking: yield details(previous.booking_id),
        replayed: true
      };
    }
    const session = (yield publicSessions(db)).find(s => s.id === input.sessionId);
    if (!session) throw new BookingError(404, 'SESSION_NOT_FOUND', 'Такой сеанс не найден. Выберите дату в расписании.');
    if (session.status !== 'scheduled' || new Date(session.startsAt) <= now()) throw new BookingError(409, 'UNAVAILABLE', 'Запись на этот сеанс закрыта. Выберите другую дату.');
    const program = (yield catalog()).workshops.find(w => w.id === session.workshopId);
    if (!program || program.archived) throw new BookingError(409, 'UNAVAILABLE', 'Программа больше недоступна для записи.');
    if (input.expectedUnitPriceRub !== program.priceRub) throw new BookingError(409, 'PRICE_CHANGED', 'Цена изменилась. Вернитесь к выбору сеанса и проверьте новую стоимость.');
    if (input.quantity > session.available) throw new BookingError(409, 'NO_SEATS', `На сеансе осталось мест: ${session.available}. ${session.available ? 'Вернитесь к выбору участников.' : 'Выберите другую дату.'}`);
    const id = randomUUID();
    const reference = `LD-${randomBytes(6).toString('hex').toUpperCase()}`;
    const timestamp = now().toISOString();
    yield db.prepare(`INSERT INTO bookings (id,reference,session_id,quantity,unit_price_kopecks,total_kopecks,
      customer_name,phone,email,comment,management_token_hash,consent_version,consent_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, reference, session.id, input.quantity, program.priceRub * 100, program.priceRub * 100 * input.quantity, input.name, input.phone, input.email, input.comment, hash(input.managementToken), CONSENT_VERSION, timestamp, timestamp);
    yield db.prepare('INSERT INTO idempotency_keys (key,request_hash,booking_id,created_at) VALUES (?,?,?,?)').run(key, fingerprint, id, timestamp);
    return {
      booking: yield details(id),
      replayed: false
    };
  }));
  const cancel = db.transaction(flow(function* (token) {
    const id = yield findToken(token);
    const booking = yield details(id);
    if (booking.status === 'cancelled') return {
      booking,
      alreadyCancelled: true
    };
    if (new Date(booking.session.startsAt) <= now()) throw new BookingError(409, 'TOO_LATE', 'Занятие уже началось. Онлайн-отмена закрыта.');
    yield db.prepare("UPDATE bookings SET status='cancelled',cancelled_at=? WHERE id=? AND status='confirmed'").run(now().toISOString(), id);
    return {
      booking: yield details(id),
      alreadyCancelled: false
    };
  }));
  const withdraw = db.transaction(flow(function* (token) {
    const id = yield findToken(token);
    const booking = yield details(id);
    const timestamp = now().toISOString();
    if (booking.dataErasedAt) return {
      booking,
      alreadyErased: true
    };
    if (booking.status === 'confirmed' && new Date(booking.session.startsAt) > now()) yield db.prepare("UPDATE bookings SET status='cancelled',cancelled_at=? WHERE id=?").run(timestamp, id);
    yield eraseBookingContacts(db, id, timestamp);
    return {
      booking: yield details(id),
      alreadyErased: false
    };
  }));
  return {
    create: flow(function* (input, key) {
      return yield create.immediate(input, key);
    }),
    get: flow(function* (token) {
      return yield details(yield findToken(token));
    }),
    cancel: flow(function* (token) {
      return yield cancel.immediate(token);
    }),
    withdraw: flow(function* (token) {
      return yield withdraw.immediate(token);
    })
  };
}
