export function normalizePhone(value) {
  const compact = String(value).replace(/[\s().-]/g, '');
  if (/^\d{10}$/.test(compact)) return `+7${compact}`;
  if (/^[78]\d{10}$/.test(compact)) return `+7${compact.slice(1)}`;
  return compact;
}
export function isValidPhone(value) {
  const phone = normalizePhone(value);
  return /^\+[1-9]\d{7,14}$/.test(phone) && (!phone.startsWith('+7') || /^\+7\d{10}$/.test(phone));
}
export function formatPhone(value) {
  const raw = String(value);
  if (raw.trim() === '+') return '+';
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (raw.trim().startsWith('+') && !raw.trim().startsWith('+7')) return `+${digits.slice(0, 15)}`;
  if (/^[78]/.test(digits)) digits = digits.slice(1);
  const local = digits.slice(0, 10);
  let result = '+7';
  if (local.length) result += ` (${local.slice(0, 3)}`;
  if (local.length >= 3) result += ')';
  if (local.length > 3) result += ` ${local.slice(3, 6)}`;
  if (local.length > 6) result += `-${local.slice(6, 8)}`;
  if (local.length > 8) result += `-${local.slice(8, 10)}`;
  return result;
}
