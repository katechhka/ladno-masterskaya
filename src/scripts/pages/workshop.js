import $ from 'jquery';
import { getScheduleData } from '../services/schedule-data.js';
import { formatDate, formatTime, money, places, sessionState } from '../services/dates.js';
import { failure, noSessions } from '../components/session-ui.js';

export function initWorkshop() {
  const $target = $('[data-session-picker]');
  const workshopId = $target.attr('data-workshop');
  async function load(fresh = false) {
    $target.attr('aria-busy', 'true').empty().append($('<p>', { class: 'loading-state', role: 'status' }).text('Смотрим ближайшие даты…'));
    try {
      const { sessions } = await getScheduleData({ fresh });
      const available = sessions.filter((session) => session.workshopId === workshopId && sessionState(session).canSelect);
      if (!available.length) { noSessions($target); return; }
      const $form = $('<form>', { class: 'session-picker' });
      const $select = $('<select>', { class: 'field__input', name: 'session', 'aria-label': 'Дата и время' });
      available.forEach((session) => $select.append($('<option>', { value: session.id }).text(`${formatDate(session.startsAt)}, ${formatTime(session.startsAt)} · ${places(session.available)}`)));
      const $quantity = $('<input>', { class: 'field__input', type: 'number', min: 1, value: 1, step: 1, name: 'quantity', required: true, inputmode: 'numeric', 'aria-label': 'Количество участников' });
      const $total = $('<output>', { class: 'session-picker__total', 'aria-live': 'polite' });
      const selected = new URLSearchParams(location.search).get('session');
      if (available.some((session) => session.id === selected)) $select.val(selected);
      function update() {
        const session = available.find((item) => item.id === $select.val());
        const quantity = Math.min(Math.max(Math.trunc(Number($quantity.val())) || 1, 1), session.available);
        $quantity.attr('max', session.available).val(quantity);
        $total.text(`Итого: ${money(session.program.priceRub * quantity)}`);
      }
      $form.append($('<label>', { class: 'field' }).append($('<span>', { class: 'field__label' }).text('Дата и время / Тула'), $select), $('<label>', { class: 'field' }).append($('<span>', { class: 'field__label' }).text('Участники'), $quantity), $total, $('<button>', { class: 'button', type: 'submit' }).text('Продолжить запись ↗'));
      $select.on('change', update);
      $quantity.on('change', update).on('input', () => {
        const session = available.find((item) => item.id === $select.val());
        const quantity = Number($quantity.val());
        $total.text(Number.isInteger(quantity) && quantity > 0 && quantity <= session.available ? `Итого: ${money(session.program.priceRub * quantity)}` : `Выберите от 1 до ${session.available} участников`);
      });
      $form.on('submit', (event) => {
        event.preventDefault();
        if (!$form[0].reportValidity()) return;
        location.href = `/booking/?session=${encodeURIComponent($select.val())}&quantity=${Number($quantity.val())}`;
      });
      $target.empty().append($form);
      update();
    } catch { failure($target, () => load(true)); }
    finally { $target.attr('aria-busy', 'false'); }
  }
  load();
}
