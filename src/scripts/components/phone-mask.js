import { formatPhone } from '../../../shared/phone.js';

export function initPhoneMask($input) {
  function update() {
    const input = $input[0];
    const raw = input.value;
    const start = input.selectionStart ?? raw.length;
    let digitsBefore = raw.slice(0, start).replace(/\D/g, '').length;
    if (raw && !raw.trim().startsWith('+') && !/^[78]/.test(raw.replace(/\D/g, ''))) digitsBefore++;
    const formatted = formatPhone(raw);
    input.value = formatted;
    let position = 0; let count = 0;
    while (position < formatted.length && count < digitsBefore) { if (/\d/.test(formatted[position])) count++; position++; }
    while (position < formatted.length && /\D/.test(formatted[position])) position++;
    input.setSelectionRange(position, position);
  }
  $input.attr('maxlength', 18).on('input.phoneMask', update);
  $input.on('paste.phoneMask', (event) => {
    const text = event.originalEvent?.clipboardData?.getData('text');
    if (text === undefined) return;
    event.preventDefault(); const input = $input[0];
    input.setRangeText(text, input.selectionStart, input.selectionEnd, 'end');
    $input.trigger('input');
  });
  $input.on('beforeinput.phoneMask', (event) => {
    const input = $input[0]; const kind = event.originalEvent?.inputType;
    if (input.selectionStart !== input.selectionEnd || !['deleteContentBackward', 'deleteContentForward'].includes(kind)) return;
    const backwards = kind === 'deleteContentBackward'; const caret = input.selectionStart;
    let index = backwards ? caret - 1 : caret;
    if (index < 0 || index >= input.value.length || /\d/.test(input.value[index])) return;
    while (index >= 0 && index < input.value.length && /\D/.test(input.value[index])) index += backwards ? -1 : 1;
    if (index < 0 || index >= input.value.length) return;
    event.preventDefault(); input.setRangeText('', index, index + 1, 'start'); $input.trigger('input');
  });
}
