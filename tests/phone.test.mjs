import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPhone, normalizePhone, isValidPhone } from '../shared/phone.js';

test('Маска ограничивает номер +7 десятью цифрами и форматирует вставку с 8', () => {
  assert.equal(formatPhone('890000000001234567890'), '+7 (900) 000-00-00');
  assert.equal(formatPhone('+7 (900) 123-45-6789012345'), '+7 (900) 123-45-67');
  assert.equal(formatPhone('9000000000'), '+7 (900) 000-00-00');
  assert.equal(formatPhone('abc'), ''); assert.equal(formatPhone('+'), '+');
});
test('Нормализация едина для клиента и сервера; сервер не обрезает лишние цифры', () => {
  for (const value of ['+7 (900) 000-00-00', '8 900 0000000', '79000000000', '9000000000']) {
    assert.equal(normalizePhone(value), '+79000000000'); assert.equal(isValidPhone(value), true);
  }
  for (const value of ['', '+7', '+7900000000', '+790000000001', '+79000000000000000', '+7aaa9000000000']) assert.equal(isValidPhone(value), false);
});
test('Международный номер ограничен 15 цифрами; короткие и длинные номера отклоняются', () => {
  assert.equal(formatPhone('+12025550123123456789'), '+120255501231234');
  assert.equal(isValidPhone('+12025550123'), true);
  assert.equal(isValidPhone('+1202555012312345'), false); assert.equal(isValidPhone('+123'), false);
});
