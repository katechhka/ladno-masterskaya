import $ from 'jquery';
import { duration, formatDate, formatTime, money, sessionState } from '../services/dates.js';

export function sessionRow(session) {
  const program = session.program;
  const state = sessionState(session);
  const $row = $('<article>', { class: `session-row${state.canSelect ? '' : ' session-row--unavailable'}`, 'data-session-id': session.id });
  const $time = $('<div>', { class: 'session-row__time' }).append($('<time>', { datetime: session.startsAt }).text(formatTime(session.startsAt)), $('<span>').text(`до ${formatTime(session.endsAt)}`));
  const $program = $('<div>', { class: 'session-row__program' }).append($('<p>', { class: 'session-row__category' }).text(program.categoryName), $('<h3>').append($('<a>', { href: `/master-classes/${program.slug}/` }).text(program.title)), $('<p>', { class: 'session-row__details' }).text(`${duration(program.durationMinutes)} / ${program.minAge}+ / Без опыта`));
  const $price = $('<div>', { class: 'session-row__price' }).append($('<strong>').text(money(program.priceRub)), $('<small>').text('за участника'));
  const $availability = $('<span>', { class: `availability${state.canSelect ? '' : ' availability--full'}` }).text(state.label);
  const $action = state.canSelect ? $('<a>', { class: 'button button--secondary session-row__action', href: `/booking/?session=${encodeURIComponent(session.id)}&quantity=1` }).text(state.action) : $('<button>', { class: 'button session-row__action', type: 'button', disabled: true }).text(state.action);
  return $row.append($time, $program, $price, $('<div>', { class: 'session-row__booking' }).append($availability, $action));
}

export function failure($container, retry) {
  $container.empty().attr('aria-busy', 'false').append($('<div>', { class: 'empty-state empty-state--error', role: 'alert' }).append($('<h2>').text('Не удалось достать расписание.'), $('<p>').text('Проверьте соединение и попробуйте ещё раз. Выбор занятия не потерян.'), $('<button>', { class: 'button', type: 'button', 'data-retry': '' }).text('Попробовать ещё раз').on('click', retry)));
}

export function noSessions($container, message = 'Для этого занятия пока нет доступных дат.') {
  $container.empty().append($('<div>', { class: 'empty-state empty-state--compact', role: 'status' }).append($('<h3>').text(message), $('<p>').text('Можно посмотреть другие программы или вернуться к расписанию позже.'), $('<a>', { class: 'text-link', href: '/master-classes/' }).text('Выбрать другое занятие ↗')));
}

export function sessionSummary(session, quantity) {
  return $('<dl>', { class: 'booking-summary' }).append(
    ...[['Занятие', session.program.title], ['Дата и время', `${formatDate(session.startsAt, { year: 'numeric' })}, ${formatTime(session.startsAt)} (Тула)`], ['Участники', String(quantity)], ['За одного', money(session.program.priceRub)], ['Итого', money(session.program.priceRub * quantity)]].map(([label, value]) => $('<div>').append($('<dt>').text(label), $('<dd>').text(value)))
  );
}
