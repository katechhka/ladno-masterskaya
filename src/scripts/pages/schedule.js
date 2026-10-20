import $ from 'jquery';
import { getScheduleData } from '../services/schedule-data.js';
import { dayKey, formatDate, mondayKey, shiftDay, validDay } from '../services/dates.js';
import { sessionRow, failure } from '../components/session-ui.js';

export function initSchedule() {
  const $root = $('[data-schedule]');
  const $results = $root.find('[data-schedule-results]');
  const $category = $root.find('[data-schedule-category]');
  let sessions = [];
  let week = mondayKey();
  let selectedDay = '';
  let category = '';
  let minWeek;
  let maxWeek;
  let ready = false;
  function readURL() {
    const params = new URLSearchParams(location.search);
    const desired = params.get('week');
    week = validDay(desired) ? mondayKey(desired) : mondayKey();
    week = week < minWeek ? minWeek : week > maxWeek ? maxWeek : week;
    selectedDay = validDay(params.get('day')) && mondayKey(params.get('day')) === week ? params.get('day') : '';
    category = [...$category[0].options].some((option) => option.value === params.get('category')) ? params.get('category') : '';
    $category.val(category);
  }
  function render(push = false) {
    if (!ready) return;
    const end = shiftDay(week, 6);
    $root.find('[data-week-label]').text(`${formatDate(week, { month: 'short' })} — ${formatDate(end, { month: 'short', year: 'numeric' })}`);
    $root.find('[data-week-prev]').prop('disabled', week <= minWeek);
    $root.find('[data-week-next]').prop('disabled', week >= maxWeek);
    const filtered = sessions.filter((session) => (!category || session.program.category === category) && dayKey(session.startsAt) >= week && dayKey(session.startsAt) <= end);
    const $days = $root.find('[data-week-days]').empty();
    $('<button>', { class: `week-day week-day--all${!selectedDay ? ' week-day--active' : ''}`, type: 'button', 'aria-pressed': String(!selectedDay), 'data-select-day': '' }).text('Вся неделя').appendTo($days);
    for (let i = 0; i < 7; i += 1) {
      const key = shiftDay(week, i);
      const count = filtered.filter((session) => dayKey(session.startsAt) === key).length;
      $('<button>', { class: `week-day${key === selectedDay ? ' week-day--active' : ''}`, type: 'button', 'aria-pressed': String(key === selectedDay), 'data-select-day': key, 'aria-label': formatDate(key, { weekday: 'long' }) }).append($('<span>').text(formatDate(key, { weekday: 'short', day: undefined, month: undefined })), $('<strong>').text(formatDate(key, { day: 'numeric', month: undefined })), $('<small>').text(count ? `${count} ${count === 1 ? 'занятие' : 'занятия'}` : 'Без занятий')).appendTo($days);
    }
    $results.empty().attr('aria-busy', 'false');
    const visible = selectedDay ? filtered.filter((session) => dayKey(session.startsAt) === selectedDay) : filtered;
    if (!visible.length) {
      const $empty = $('<div>', { class: 'empty-state', role: 'status' }).append($('<h2>').text(selectedDay ? 'В этот день пока без занятий.' : 'На этой неделе ничего не нашлось.'), $('<p>').text(category ? 'Попробуйте другое направление или соседнюю неделю.' : 'Выберите другой день или соседнюю неделю.'));
      if (category) $empty.append($('<button>', { class: 'button button--secondary', type: 'button', 'data-clear-schedule': '' }).text('Все направления'));
      $results.append($empty);
    } else {
      for (let i = 0; i < 7; i += 1) {
        const key = shiftDay(week, i);
        if (selectedDay && key !== selectedDay) continue;
        const items = visible.filter((session) => dayKey(session.startsAt) === key);
        const $day = $('<section>', { class: 'schedule-day' }).append($('<h3>', { class: 'schedule-day__heading' }).text(formatDate(key, { weekday: 'long' })));
        if (items.length) items.forEach((session) => $day.append(sessionRow(session)));
        else $day.append($('<p>', { class: 'schedule-day__empty' }).text('В этот день мастерская отдыхает. Посмотрите соседние даты.'));
        $results.append($day);
      }
    }
    if (push) {
      const url = new URL(location.href);
      url.search = '';
      url.searchParams.set('week', week);
      if (selectedDay) url.searchParams.set('day', selectedDay);
      if (category) url.searchParams.set('category', category);
      if (url.href !== location.href) history.pushState({}, '', url);
    }
  }
  async function load(fresh = false) {
    ready = false;
    $results.attr('aria-busy', 'true').empty().append($('<p>', { class: 'loading-state', role: 'status' }).text('Достаём расписание…'));
    try {
      const data = await getScheduleData({ fresh });
      sessions = data.sessions;
      minWeek = sessions.length ? mondayKey(sessions[0].startsAt) : mondayKey();
      maxWeek = sessions.length ? mondayKey(sessions.at(-1).startsAt) : mondayKey();
      ready = true;
      readURL();
      render();
    } catch { failure($results, () => load(true)); }
  }
  $root.on('click', '[data-week-prev]', () => { week = shiftDay(week, -7); selectedDay = ''; render(true); });
  $root.on('click', '[data-week-next]', () => { week = shiftDay(week, 7); selectedDay = ''; render(true); });
  $root.on('click', '[data-week-today]', () => { week = mondayKey(); week = week < minWeek ? minWeek : week > maxWeek ? maxWeek : week; selectedDay = ''; render(true); });
  $root.on('click', '[data-select-day]', function () { selectedDay = this.dataset.selectDay; render(true); });
  $category.on('change', () => { category = $category.val(); selectedDay = ''; render(true); });
  $root.on('click', '[data-clear-schedule]', () => { category = ''; $category.val(''); render(true); });
  $(window).on('popstate', () => { if (ready) { readURL(); render(); } });
  load();
}
