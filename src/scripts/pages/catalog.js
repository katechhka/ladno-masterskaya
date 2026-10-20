import $ from 'jquery';

const normalize = (value) => value.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').trim();
export function initCatalog() {
  const $root = $('[data-catalog]');
  if (!$root.length) return;
  const form = $root.find('[data-catalog-form]')[0];
  const $grid = $root.find('[data-catalog-grid]');
  const cards = $grid.find('[data-catalog-card]').toArray();
  const allowedSorts = ['default', 'price-asc', 'price-desc', 'duration-asc', 'duration-desc'];
  const allowedAges = ['', ...Array.from({ length: 13 }, (_, index) => String(index + 6))];
  const categories = [...form.elements.category.options].map((option) => option.value);
  let timer;
  const readURL = () => {
    const params = new URLSearchParams(location.search);
    form.elements.q.value = (params.get('q') || '').slice(0, 100);
    form.elements.category.value = categories.includes(params.get('category')) ? params.get('category') : '';
    form.elements.age.value = allowedAges.includes(params.get('age')) ? params.get('age') : '';
    form.elements.sort.value = allowedSorts.includes(params.get('sort')) ? params.get('sort') : 'default';
  };
  function apply({ historyMode } = {}) {
    const query = normalize(form.elements.q.value).split(/\s+/).filter(Boolean);
    const category = form.elements.category.value;
    const age = Number(form.elements.age.value);
    const sort = form.elements.sort.value;
    const sorted = [...cards];
    if (sort !== 'default') {
      const [field, direction] = sort.split('-');
      sorted.sort((a, b) => (Number(a.dataset[field]) - Number(b.dataset[field])) * (direction === 'asc' ? 1 : -1));
    }
    let count = 0;
    for (const card of sorted) {
      const match = (!category || card.dataset.category === category) && (!age || Number(card.dataset.age) <= age) && query.every((word) => normalize(card.dataset.search).includes(word));
      card.hidden = !match;
      if (match) count += 1;
      $grid.append(card);
    }
    const plural = new Intl.PluralRules('ru').select(count);
    $root.find('[data-catalog-count]').text(`${count} ${plural === 'one' ? 'занятие' : plural === 'few' ? 'занятия' : 'занятий'}`);
    $root.find('[data-catalog-empty]').prop('hidden', count !== 0);
    if (historyMode) {
      const url = new URL(location.href);
      url.search = '';
      if (form.elements.q.value.trim()) url.searchParams.set('q', form.elements.q.value.trim());
      if (category) url.searchParams.set('category', category);
      if (age) url.searchParams.set('age', String(age));
      if (sort !== 'default') url.searchParams.set('sort', sort);
      if (url.href !== location.href) history[`${historyMode}State`]({}, '', url);
    }
  }
  function reset() {
    clearTimeout(timer);
    form.reset();
    apply({ historyMode: 'push' });
  }
  $(form).on('submit', (event) => { event.preventDefault(); clearTimeout(timer); apply({ historyMode: 'replace' }); });
  $(form.elements.q).on('input', () => { clearTimeout(timer); timer = setTimeout(() => apply({ historyMode: 'replace' }), 200); });
  $(form).on('change', 'select', () => { clearTimeout(timer); apply({ historyMode: 'push' }); });
  $(form).on('reset', () => { clearTimeout(timer); setTimeout(() => apply({ historyMode: 'push' }), 0); });
  $root.find('[data-catalog-reset]').on('click', reset);
  $(window).on('popstate', () => { clearTimeout(timer); readURL(); apply(); });
  readURL();
  apply();
}
