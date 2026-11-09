import $ from 'jquery';
import { getScheduleData } from '../services/schedule-data.js';
import { sessionSummary, failure, noSessions } from '../components/session-ui.js';
import { money, sessionState } from '../services/dates.js';
import { initPhoneMask } from '../components/phone-mask.js';
import { normalizePhone, isValidPhone } from '../../../shared/phone.js';

async function api(url, { body, token, key } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { method: body ? 'POST' : 'GET', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    let result;
    try { result = await response.json(); } catch { throw new Error('Недоступен сервис записи.'); }
    if (!response.ok) throw Object.assign(new Error(result.error?.message || 'Не удалось выполнить запрос.'), { code: result.error?.code, fields: result.error?.fields, status: response.status });
    return result;
  } catch (error) {
    if (!error.status) error.message = 'Не удалось получить ответ сервера. Повторите запрос: повтор не создаст вторую бронь.';
    throw error;
  } finally { clearTimeout(timeout); }
}
const notice = (text, error = false) => $('<p>', { class: `notice${error ? ' notice--error' : ''}`, role: error ? 'alert' : 'status' }).text(text);
const tokenValue = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
function focusHeading($element) { $element.attr('tabindex', '-1').trigger('focus'); }
const pendingName = (id) => `ladno:pending:${id}`;
function pendingRead(id) {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingName(id)));
    return /^[a-f0-9]{64}$/.test(value?.token) && /^[a-zA-Z0-9-]{32,100}$/.test(value?.key) ? value : null;
  } catch { return null; }
}
function pendingWrite(id, value) {
  // Только ключ запроса и секрет восстановления; контакты здесь не сохраняются.
  try { if (value) sessionStorage.setItem(pendingName(id), JSON.stringify(value)); else sessionStorage.removeItem(pendingName(id)); } catch { /* Форма работает и при запрете storage. */ }
}

export async function initBookingPreview() {
  const $root = $('[data-booking-preview]');
  if (document.body.dataset.page === 'manage') return manage($root);
  const params = new URLSearchParams(location.search);
  const staticDemo = import.meta.env.VITE_STATIC_DEMO === 'true';
  let pending = staticDemo ? null : pendingRead(params.get('session'));
  let recoveryChecked = false;
  async function load() {
    try {
      if (pending && !recoveryChecked) {
        $root.empty().append(notice('Проверяем результат предыдущего запроса…'));
        try {
          await api('/api/bookings/me', { token: pending.token });
          location.replace(`/booking/manage/#token=${pending.token}`);
          return;
        } catch (error) { if (error.status !== 404) throw error; }
        recoveryChecked = true;
      }
      const data = await getScheduleData({ fresh: true });
      const session = data.sessions.find((s) => s.id === params.get('session'));
      const quantity = Number(params.get('quantity') || 1);
      if (!session || !sessionState(session).canSelect) return noSessions($root, 'Этот сеанс недоступен для записи.');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > session.available) return noSessions($root, `Выберите от 1 до ${session.available} участников в расписании.`);
      showForm(session, quantity);
    } catch {
      if (pending && !recoveryChecked) {
        $root.empty().append(notice('Не удалось проверить предыдущую запись. Повторите проверку, чтобы не создавать новую бронь при неизвестном результате.', true), $('<button>', { class: 'button', type: 'button' }).text('Проверить результат').on('click', load));
      } else failure($root, load);
    }
  }
  function showForm(session, initialQuantity) {
    let key = pending?.key || crypto.randomUUID();
    let token = pending?.token || tokenValue();
    const $summary = $('<div>').append(sessionSummary(session, initialQuantity));
    const $form = $(document.getElementById('booking-form-template').content.cloneNode(true)).find('form');
    initPhoneMask($form.find('[name=phone]'));
    $form.find('[name=quantity]').val(initialQuantity).attr('max', session.available);
    $form.on('input change', 'input, textarea', function () {
      $(this).removeAttr('aria-invalid');
      $form.find(`[data-error="${this.name}"]`).text('');
    });
    $root.empty().append($summary, $form);
    $form.find('[name=quantity]').on('input', function () { const n = Number(this.value); if (Number.isInteger(n) && n > 0 && n <= session.available) $summary.empty().append(sessionSummary(session, n)); });
    $form.on('submit', (event) => {
      event.preventDefault();
      const form = $form[0];
      const values = Object.fromEntries(new FormData(form));
      const errors = {};
      if (values.name.trim().length < 2) errors.name = 'Укажите имя: от 2 символов.';
      const phone = normalizePhone(values.phone);
      if (!isValidPhone(phone)) errors.phone = 'Укажите телефон полностью, например +7 (900) 000-00-00.';
      if (!form.elements.email.validity.valid || !values.email.trim()) errors.email = 'Укажите корректный email.';
      const quantity = Number(values.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > session.available) errors.quantity = session.available > 0 ? `Выберите от 1 до ${session.available} участников.` : 'Мест больше нет. Выберите другую дату в расписании.';
      if (!values.privacyConsent) errors.privacyConsent = 'Нужно согласие на обработку данных.';
      if (!values.policyConsent) errors.policyConsent = 'Ознакомьтесь с политикой обработки персональных данных.';
      if (!values.rulesConsent) errors.rulesConsent = 'Подтвердите правила и демонстрационный характер записи.';
      $form.find('[data-error]').text(''); $form.find('[aria-invalid]').removeAttr('aria-invalid');
      for (const [name, message] of Object.entries(errors)) {
        $form.find(`[data-error="${name}"]`).text(message); $form.find(`[name="${name}"]`).attr('aria-invalid', 'true');
      }
      if (Object.keys(errors).length) { $form.find('[aria-invalid=true]').first().trigger('focus'); return; }
      const payload = { sessionId: session.id, quantity, expectedUnitPriceRub: session.program.priceRub,
        name: values.name.trim(), phone, email: values.email.trim(), comment: values.comment,
        privacyConsent: true, policyConsent: true, rulesConsent: true, managementToken: token };
      const $review = $('<div>', { class: 'booking-form', 'data-booking-review': '' });
      const $heading = $('<h2>').text('Всё верно?');
      const $confirm = $('<button>', { class: 'button', type: 'button', 'data-confirm-booking': '' }).text('Подтвердить бронь');
      const $back = $('<button>', { class: 'text-link', type: 'button' }).text('Изменить данные');
      if (staticDemo) $confirm.text('Завершить демонстрацию');
      const $error = $('<div>');
      $review.append($heading, sessionSummary(session, quantity), $('<p>', { class: 'booking-form__payment' }).text('Оплата на месте после мастер-класса'),
        $('<p>').text(`${payload.name} · ${payload.phone} · ${payload.email}`), $('<p>').text('Демонстрационная запись. Письма и SMS не отправляются.'), $error,
        $('<div>', { class: 'booking-form__actions' }).append($confirm, $back));
      $form.prop('hidden', true); $summary.prop('hidden', true); $root.append($review); focusHeading($heading);
      let busy = false;
      $back.on('click', () => {
        $review.remove(); $form.prop('hidden', false); $summary.prop('hidden', false);
        if (!pending) { key = crypto.randomUUID(); token = tokenValue(); }
        $form.find('[name=name]').trigger('focus');
      });
      $confirm.on('click', async () => {
        if (staticDemo) {
          $root.empty().append($('<h2>', { tabindex: '-1' }).text('Демонстрация завершена'),
            notice('Бронь не создана. Контакты никуда не отправлены и не сохранены. Telegram в этой версии не подключён.'),
            $('<a>', { class: 'button', href: `${import.meta.env.BASE_URL}schedule/` }).text('Вернуться к расписанию'));
          $root.find('h2').trigger('focus');
          return;
        }
        if (busy) return;
        busy = true; $confirm.prop('disabled', true).text('Сохраняем…'); $back.prop('disabled', true); $error.empty();
        pending = { key, token }; pendingWrite(session.id, pending);
        try {
          await api('/api/bookings', { body: payload, key });
          location.assign(`/booking/manage/#token=${token}`);
        } catch (error) {
          $error.append(notice(error.message, true));
          if (error.fields) for (const message of Object.values(error.fields)) $error.append($('<p>').text(message));
          const rejected = ['VALIDATION', 'INVALID_KEY', 'NO_SEATS', 'PRICE_CHANGED', 'UNAVAILABLE', 'SESSION_NOT_FOUND'].includes(error.code);
          if (rejected) {
            pendingWrite(session.id, null); pending = null;
            if (['NO_SEATS', 'PRICE_CHANGED', 'UNAVAILABLE'].includes(error.code)) {
              try {
                const fresh = await getScheduleData({ fresh: true });
                const current = fresh.sessions.find((s) => s.id === session.id);
                if (current) Object.assign(session, current);
                $form.find('[name=quantity]').attr('max', session.available);
                $summary.empty().append(sessionSummary(session, Number($form.find('[name=quantity]').val())));
                const selectable = sessionState(session).canSelect;
                $form.find('[type=submit]').prop('disabled', !selectable);
                if (!selectable) {
                  const otherDates = () => $('<a>', { class: 'text-link', href: '/schedule/' }).text('Открыть расписание ↗');
                  $summary.append(notice('Сеанс больше недоступен для записи. Выберите другую дату.', true), otherDates());
                  $error.append(otherDates());
                }
              } catch { /* Повторная проверка при подтверждении остаётся серверной. */ }
            }
          }
          if (!rejected) $error.append($('<a>', { class: 'text-link', href: `/booking/manage/#token=${token}` }).text('Проверить результат по персональной ссылке ↗'));
          // Неизвестный исход: повторяем только исходный запрос с тем же ключом.
          $back.prop('disabled', !rejected);
          const needsReview = ['NO_SEATS', 'PRICE_CHANGED', 'UNAVAILABLE', 'SESSION_NOT_FOUND'].includes(error.code);
          $confirm.prop('disabled', needsReview).text(needsReview ? 'Проверьте новые условия' : 'Повторить подтверждение'); busy = false;
        }
      });
    });
  }
  await load();
}

async function manage($root) {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  let refreshTelegram;
  let refreshedAt = 0;
  const checkTelegram = () => {
    if (document.visibilityState === 'visible' && Date.now() - refreshedAt > 1000) {
      refreshedAt = Date.now(); refreshTelegram?.();
    }
  };
  window.addEventListener('focus', checkTelegram);
  document.addEventListener('visibilitychange', checkTelegram);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    $root.empty().append(notice('Откройте полную персональную ссылку, которую вы получили после записи. Номера брони недостаточно для доступа.', true), $('<a>', { href: '/schedule/', class: 'text-link' }).text('Выбрать занятие ↗'));
    return;
  }
  async function load() {
    $root.attr('aria-busy', 'true');
    try { const result = await api('/api/bookings/me', { token }); pendingWrite(result.booking.session.id, null); render(result.booking, result.telegram); }
    catch (error) {
      $root.empty().append(notice(error.message, true));
      if (error.status !== 404) $root.append($('<button>', { class: 'button', type: 'button' }).text('Повторить запрос').on('click', load));
    } finally { $root.attr('aria-busy', 'false'); }
  }
  function render(booking, telegram) {
    refreshTelegram = null;
    const cancelled = booking.status === 'cancelled';
    const $heading = $('<h2>', { 'data-booking-status': booking.status }).text(cancelled ? 'Запись отменена' : 'Место за вами!');
    $root.empty().append($heading, $('<p>', { class: 'eyebrow', 'data-booking-reference': '' }).text(`Бронь ${booking.reference}`),
      sessionSummary(booking.session, booking.quantity), $('<p>', { class: 'booking-form__payment' }).text(cancelled ? 'Места снова доступны в расписании. Оплаты не было.' : `Оплата на месте после мастер-класса · ${money(booking.totalRub)}`),
      $('<p>').text(booking.dataErasedAt ? 'Контактные данные удалены.' : `${booking.name} · ${booking.phone} · ${booking.email}`));
    if (booking.comment) $root.append($('<p>').text(`Комментарий: ${booking.comment}`));
    if (booking.pickup) $root.append($('<p>').text(`Получение работы: ${booking.pickup}`));
    if (!cancelled && !booking.dataErasedAt) {
      const $telegram = $('<section>', { class: 'booking-form', 'aria-label': 'Подтверждение в Telegram', 'data-telegram': '' });
      let link;
      function showTelegram(state = { enabled: false }) {
        $telegram.empty().append($('<h3>').text('Подтверждение в Telegram'));
        if (!state.enabled) { $telegram.append($('<p>').text('Бот пока не подключён. Ваша бронь сохранена, подтверждение доступно на этой странице.')); return; }
        if (state.status === 'sent') { $telegram.append(notice('Подтверждение отправлено в ваш личный чат с ботом.')); return; }
        if (state.status === 'sending') { $telegram.append(notice('Бот отправляет подтверждение. Вернитесь на эту страницу, чтобы проверить результат.')); return; }
        if (state.status === 'unknown') { $telegram.append(notice('Не удалось проверить отправку. Посмотрите личный чат с ботом. Автоматически повторять сообщение не будем, чтобы не создавать дубли.', true)); return; }
        if (state.status === 'failed') $telegram.append(notice('Telegram отклонил отправку. Проверьте, что бот не заблокирован, и попробуйте снова.', true));
        $telegram.append($('<p>').text('Откройте бота и нажмите «Старт». По вашему запросу передадим Telegram номер брони, занятие, дату, число участников и сумму. Телефон, email и комментарий не передаются.'));
        if (link && !state.expired) {
          $telegram.append($('<a>', { class: 'button', href: link, target: '_blank', rel: 'noopener noreferrer', 'data-open-telegram': '' }).text('Открыть Telegram ↗'), $('<p>').text('Ссылка действует 15 минут. В боте нажмите «Старт», чтобы получить подтверждение.'));
          const command = `/start ${new URL(link).searchParams.get('start')}`;
          const $copyCommand = $('<button>', { class: 'text-link', type: 'button', 'data-copy-telegram-command': '' }).text('Скопировать команду для бота');
          const $commandStatus = $('<p>', { role: 'status' });
          $copyCommand.on('click', async () => {
            try { await navigator.clipboard.writeText(command); $commandStatus.text('Команда скопирована. Отправьте её в личный чат с ботом, открыв его кнопкой выше.'); }
            catch {
              $commandStatus.empty().append($('<label>', { class: 'field' }).append($('<span>', { class: 'field__label' }).text('Скопируйте и отправьте эту команду боту'), $('<input>', { class: 'field__input', readonly: true, value: command })));
              $commandStatus.find('input').trigger('focus')[0].select();
            }
          });
          $telegram.append($copyCommand, $commandStatus);
        } else {
          const $connect = $('<button>', { type: 'button', class: 'button', 'data-connect-telegram': '' }).text('Получить в Telegram');
          $connect.on('click', async () => {
            $connect.prop('disabled', true).text('Готовим ссылку…');
            try { const result = await api('/api/bookings/me/telegram', { token, body: {} }); link = result.url; showTelegram(result); }
            catch (error) { $telegram.append(notice(error.message, true)); $connect.prop('disabled', false).text('Попробовать снова'); }
          });
          $telegram.append($connect);
        }
      }
      showTelegram(telegram);
      refreshTelegram = async () => {
        try { showTelegram(await api('/api/bookings/me/telegram', { token })); } catch { /* Сохранённая бронь и персональная ссылка остаются доступны. */ }
      };
      $root.append($telegram);
    }
    const $link = $('<input>', { class: 'field__input', type: 'text', readonly: true, value: location.href });
    const $copy = $('<button>', { class: 'text-link', type: 'button' }).text('Скопировать персональную ссылку');
    const $copyStatus = $('<p>', { role: 'status' });
    $copy.on('click', async () => { try { await navigator.clipboard.writeText(location.href); $copyStatus.text('Ссылка скопирована. Сохраните её для просмотра и отмены.'); } catch { $link[0].select(); $copyStatus.text('Скопируйте выделенную ссылку вручную.'); } });
    $root.append($('<div>', { class: 'booking-form' }).append($('<label>', { class: 'field' }).append($('<span>', { class: 'field__label' }).text('Сохраните ссылку — она открывает сведения о вашей записи'), $link), $copy, $copyStatus,
      $('<p>').text('Подтверждение доступно на этой странице. Письма и SMS не отправляются. Не передавайте ссылку посторонним.')));
    if (!cancelled && new Date(booking.session.startsAt) > new Date()) {
      const $cancel = $('<button>', { class: 'button button--secondary', type: 'button', 'data-open-cancel': '' }).text('Отменить запись');
      const $confirmation = $('<div>', { class: 'booking-form', hidden: true, 'data-cancel-confirmation': '' });
      const $title = $('<h3>').text('Отменить запись для всей группы?');
      const $yes = $('<button>', { class: 'button', type: 'button', 'data-confirm-cancel': '' }).text('Да, отменить запись');
      const $no = $('<button>', { class: 'text-link', type: 'button' }).text('Оставить запись');
      const $error = $('<div>');
      $confirmation.append($title, $('<p>').text(`Будет освобождено мест: ${booking.quantity}. При необходимости можно оформить новую запись.`), $error, $('<div>', { class: 'booking-form__actions' }).append($yes, $no));
      $cancel.on('click', () => { $cancel.prop('hidden', true); $confirmation.prop('hidden', false); focusHeading($title); });
      $no.on('click', () => { $confirmation.prop('hidden', true); $cancel.prop('hidden', false).trigger('focus'); });
      $yes.on('click', async () => {
        $yes.prop('disabled', true).text('Отменяем…'); $no.prop('disabled', true); $error.empty();
        try { const result = await api('/api/bookings/me/cancel', { body: {}, token }); render(result.booking); focusHeading($root.find('h2').first()); }
        catch (error) { $error.append(notice(error.message, true)); $yes.prop('disabled', false).text('Повторить отмену'); $no.prop('disabled', false); }
      });
      $root.append($cancel, $confirmation);
    } else if (!cancelled) $root.append(notice('Занятие уже началось. Онлайн-отмена закрыта.'));
    if(booking.dataErasedAt)$root.append(notice('Согласие отозвано или срок хранения истёк. Контактные данные и привязка Telegram удалены. Технические сведения о записи сохранены.'));
    else {
      const $withdraw=$('<button>',{class:'text-link',type:'button','data-open-withdraw':''}).text('Отозвать согласие и удалить контакты');
      const $box=$('<section>',{class:'booking-form',hidden:true,'data-withdraw-confirmation':''});
      const $title=$('<h3>').text('Удалить контактные данные?');const $error=$('<div>');
      const $yes=$('<button>',{class:'button',type:'button','data-confirm-withdraw':''}).text('Да, удалить контакты');
      const $no=$('<button>',{class:'text-link',type:'button'}).text('Оставить данные');
      $box.append($title,$('<p>').text('Имя, телефон, email, комментарий и привязка Telegram будут удалены. Будущая действующая бронь отменится, места освободятся. Уже полученные сообщения в Telegram останутся в вашем чате.'),$error,$yes,$no);
      $withdraw.on('click',()=>{$box.prop('hidden',false);$withdraw.prop('hidden',true);focusHeading($title);});
      $no.on('click',()=>{$box.prop('hidden',true);$withdraw.prop('hidden',false).trigger('focus');});
      $yes.on('click',async()=>{$yes.prop('disabled',true);$no.prop('disabled',true);$error.empty();try{const result=await api('/api/bookings/me/withdraw',{body:{},token});render(result.booking);focusHeading($root.find('h2').first());}catch(error){$error.append(notice(error.message,true));$yes.prop('disabled',false);$no.prop('disabled',false);}});
      $root.append($withdraw,$box);
    }
    $root.append($('<a>', { class: 'text-link', href: '/schedule/' }).text('Посмотреть расписание ↗'));
  }
  await load();
}
