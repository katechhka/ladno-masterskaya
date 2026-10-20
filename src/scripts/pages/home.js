import $ from 'jquery';
import { getScheduleData } from '../services/schedule-data.js';
import { formatDate, sessionState } from '../services/dates.js';
import { sessionRow, failure, noSessions } from '../components/session-ui.js';

export function initHome() {
  const $target = $('[data-upcoming-sessions]');
  async function load(fresh = false) {
    $target.attr('aria-busy', 'true').empty().append($('<p>', { class: 'loading-state', role: 'status' }).text('Смотрим ближайшие занятия…'));
    try {
      const { sessions } = await getScheduleData({ fresh });
      const upcoming = sessions.filter((session) => sessionState(session).canSelect).slice(0, 3);
      $target.empty();
      if (!upcoming.length) noSessions($target, 'Ближайшие группы пока не назначены.');
      for (const session of upcoming) $target.append($('<div>', { class: 'upcoming-session' }).append($('<p>', { class: 'upcoming-session__date' }).text(formatDate(session.startsAt, { weekday: 'long' })), sessionRow(session)));
    } catch { failure($target, () => load(true)); }
    finally { $target.attr('aria-busy', 'false'); }
  }
  load();
}
