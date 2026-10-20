import $ from 'jquery';
import '../styles/main.styl';
import { initMaterialBoards } from './components/material-board.js';
import { initGalleries } from './components/gallery.js';
import { initCookieNotice } from './components/cookie-notice.js';

window.addEventListener('pageshow', (event) => { if (event.persisted) location.reload(); });

$(() => {
  initCookieNotice();
  $('[data-print-document]').on('click',()=>window.print());
  initMaterialBoards();
  initGalleries();
  const page = document.body.dataset.page;
  const initializers = {
    admin: () => import('./pages/admin.js').then((module) => module.initAdmin()),
    home: () => import('./pages/home.js').then((module) => module.initHome()),
    catalog: () => import('./pages/catalog.js').then((module) => module.initCatalog()),
    workshop: () => import('./pages/workshop.js').then((module) => module.initWorkshop()),
    schedule: () => import('./pages/schedule.js').then((module) => module.initSchedule()),
    booking: () => import('./pages/booking-preview.js').then((module) => module.initBookingPreview()),
    manage: () => import('./pages/booking-preview.js').then((module) => module.initBookingPreview())
  };
  initializers[page]?.().catch(() => {
    const notice = document.createElement('p');
    notice.className = 'notice notice--error container';
    notice.setAttribute('role', 'alert');
    notice.textContent = 'Не удалось подключить управление страницей. Обновите страницу и попробуйте ещё раз.';
    document.querySelector('main')?.prepend(notice);
  });
  document.documentElement.dataset.js = 'ready';
});
