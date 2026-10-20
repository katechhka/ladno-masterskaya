import { flow } from '../db/flow.mjs';
export const eraseBookingContacts = flow(function* eraseBookingContacts(db, id, timestamp = new Date().toISOString()) {
  yield db.prepare("UPDATE bookings SET customer_name='Контакты удалены',phone='+70000000000',email='deleted@example.invalid',comment='',notification_required=0,change_note='',data_erased_at=? WHERE id=? AND data_erased_at IS NULL").run(timestamp, id);
  yield db.prepare('DELETE FROM telegram_confirmations WHERE booking_id=?').run(id);
});
export const purgeExpiredContacts = flow(function* purgeExpiredContacts(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - 90 * 86400000).toISOString();
  return yield db.transaction(flow(function* () {
    const rows = yield db.prepare(`SELECT b.id FROM bookings b JOIN sessions s ON s.id=b.session_id
      WHERE b.data_erased_at IS NULL AND (CASE WHEN b.status='cancelled' THEN b.cancelled_at ELSE s.ends_at END) <= ?`).all(cutoff);
    for (const row of rows) yield eraseBookingContacts(db, row.id, now.toISOString());
    return rows.length;
  })).immediate();
});
