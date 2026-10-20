import $ from 'jquery';

export function initMaterialBoards() {
  $('[data-material-board]').each((_, element) => {
    const $board = $(element);
    $board.on('click', '[data-material-select]', function () {
      const material = this.dataset.materialSelect;
      if (!$board.find('[data-material-panel]').toArray().some((panel) => panel.dataset.materialPanel === material)) return;
      $board.find('[data-material-select]').each((_, button) => {
        const selected = button === this;
        $(button).attr('aria-pressed', String(selected)).toggleClass('material-board__selector--active', selected);
      });
      $board.find('[data-material-panel]').each((_, panel) => {
        panel.hidden = panel.dataset.materialPanel !== material;
      });
    });
  });
}
