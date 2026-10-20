import $ from 'jquery';

export function initGalleries() {
  $('[data-gallery]').each((_, element) => {
    const $gallery = $(element);
    const slides = $gallery.find('[data-gallery-slide]').toArray();
    const dialog = $gallery.find('[data-gallery-dialog]')[0];
    const viewport = $gallery.find('[data-gallery-viewport]')[0];
    let index = 0;
    let startPoint;
    let returnFocus;
    function show(next) {
      index = (next + slides.length) % slides.length;
      slides.forEach((slide, number) => { slide.hidden = number !== index; });
      $gallery.find('[data-gallery-index]').each((_, button) => $(button).attr('aria-pressed', String(Number(button.dataset.galleryIndex) === index)).toggleClass('gallery__thumb--active', Number(button.dataset.galleryIndex) === index));
      $gallery.find('[data-gallery-counter]').text(`${index + 1} / ${slides.length}`);
      const image = slides[index].querySelector('img');
      if (dialog.open) {
        $gallery.find('[data-gallery-dialog-image]').attr({ src: image.src, alt: image.alt });
        $gallery.find('[data-gallery-dialog-caption]').text(image.alt);
      }
    }
    $gallery.on('click', '[data-gallery-prev]', () => show(index - 1));
    $gallery.on('click', '[data-gallery-next]', () => show(index + 1));
    $gallery.on('click', '[data-gallery-index]', function () { show(Number(this.dataset.galleryIndex)); });
    $(viewport).add(dialog).on('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); show(index + (event.key === 'ArrowRight' ? 1 : -1)); }
    });
    $(viewport).on('pointerdown', (event) => { startPoint = { x: event.originalEvent.clientX, y: event.originalEvent.clientY }; });
    $(viewport).on('pointerup', (event) => {
      if (!startPoint) return;
      const dx = event.originalEvent.clientX - startPoint.x;
      const dy = event.originalEvent.clientY - startPoint.y;
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) show(index + (dx < 0 ? 1 : -1));
      startPoint = undefined;
    });
    $(viewport).on('pointercancel', () => { startPoint = undefined; });
    $gallery.on('click', '[data-gallery-open]', () => {
      returnFocus = document.activeElement;
      dialog.showModal();
      document.body.classList.add('has-dialog');
      show(index);
    });
    $gallery.on('click', '[data-gallery-close]', () => dialog.close());
    $(dialog).on('click', (event) => { if (event.target === dialog) dialog.close(); });
    $(dialog).on('close', () => { document.body.classList.remove('has-dialog'); returnFocus?.focus(); });
  });
}
