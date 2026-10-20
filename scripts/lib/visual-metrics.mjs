// Самодостаточная функция для page.evaluate: только текст и вычисленные стили.
export function visualMetrics() {
  const rgba = (value) => {
    const numbers = value.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0];
    return [numbers[0], numbers[1], numbers[2], numbers[3] ?? 1];
  };
  const blend = (front, back) => front.slice(0, 3).map((channel, i) => channel * front[3] + back[i] * (1 - front[3]));
  const luminance = (color) => color.map((channel) => { const n = channel / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
  const background = (element) => {
    const layers = [];
    for (let current = element; current; current = current.parentElement) {
      const color = rgba(getComputedStyle(current).backgroundColor); layers.push(color); if (color[3] === 1) break;
    }
    return layers.reverse().reduce((back, front) => blend(front, back), [255, 255, 255]);
  };
  const failures = new Map();
  const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode; const element = node.parentElement;
    if (!node.textContent.trim() || element.closest('script,style,[hidden],[aria-hidden=true],dialog:not([open]),button:disabled')) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== 'visible' || !element.getClientRects().length) continue;
    const back = background(element); const front = blend(rgba(style.color), back);
    const values = [luminance(front), luminance(back)].sort((a, b) => b - a);
    const ratio = (values[0] + .05) / (values[1] + .05);
    const required = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
    if (ratio + .01 < required) failures.set(`${style.color}/${back}/${style.fontSize}`, { sample: node.textContent.trim().slice(0, 45), className: element.className, ratio: Number(ratio.toFixed(2)), required });
  }
  const inputs = [...document.querySelectorAll('main input:not([type=checkbox]),main select,main textarea')].filter((el) => !el.closest('[hidden]') && el.getClientRects().length);
  const ticket = document.querySelector('.material-board__ticket')?.getBoundingClientRect();
  return { contrastFailures: [...failures.values()], minInputFont: inputs.length ? Math.min(...inputs.map((el) => parseFloat(getComputedStyle(el).fontSize))) : null,
    heroButtonBottom: ticket ? Math.ceil(ticket.bottom) : null, viewportHeight: innerHeight };
}
