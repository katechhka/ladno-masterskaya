export const TIMEZONE = 'Europe/Moscow';
export const dayKey = (value = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
export const dayDate = (key) => new Date(`${key}T12:00:00+03:00`);
export const shiftDay = (key, amount) => dayKey(new Date(dayDate(key).getTime() + amount * 86400000));
export const mondayKey = (value = new Date()) => {
  const key = typeof value === 'string' && value.length === 10 ? value : dayKey(value);
  const weekday = new Date(`${key}T00:00:00Z`).getUTCDay();
  return shiftDay(key, -(weekday === 0 ? 6 : weekday - 1));
};
export const validDay = (key) => /^\d{4}-\d{2}-\d{2}$/.test(key || '') && !Number.isNaN(dayDate(key).getTime()) && dayKey(dayDate(key)) === key;
export const formatDate = (value, options = {}) => new Intl.DateTimeFormat('ru-RU', { timeZone: TIMEZONE, day: 'numeric', month: 'long', ...options }).format(typeof value === 'string' && value.length === 10 ? dayDate(value) : new Date(value));
export const formatTime = (value) => new Intl.DateTimeFormat('ru-RU', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(value));
export const money = (value) => `${new Intl.NumberFormat('ru-RU').format(value)} ₽`;
export const duration = (minutes) => [Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} ч` : '', minutes % 60 ? `${minutes % 60} мин` : ''].filter(Boolean).join(' ');
export const places = (amount) => `${amount} ${new Intl.PluralRules('ru').select(amount) === 'one' ? 'место' : new Intl.PluralRules('ru').select(amount) === 'few' ? 'места' : 'мест'}`;

export function sessionState(session, now = Date.now()) {
  if (session.status === 'cancelled') return { canSelect: false, label: 'Занятие отменено', action: 'Отменено' };
  if (session.status === 'closed') return { canSelect: false, label: 'Запись закрыта', action: 'Закрыто' };
  if (new Date(session.startsAt).getTime() <= now) return { canSelect: false, label: 'Занятие уже прошло', action: 'Уже прошло' };
  if (session.available <= 0) return { canSelect: false, label: 'Все места заняты', action: 'Мест нет' };
  return { canSelect: true, label: `${places(session.available)} из ${session.capacity}`, action: 'Записаться ↗' };
}
