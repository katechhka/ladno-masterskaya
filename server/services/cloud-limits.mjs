import { createHash } from 'node:crypto';

export function cloudRateStore(db, namespace) {
  let windowMs;
  const keyFor = key => `${namespace}:${createHash('sha256').update(key).digest('hex')}`;
  return {
    localKeys: false,
    init(options) { windowMs = options.windowMs; },
    async increment(key) {
      const now = Date.now();
      const row = await db.prepare(`INSERT INTO request_limits (key,hits,reset_at) VALUES (?,1,?)
        ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN reset_at<=? THEN 1 ELSE hits+1 END,
        reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING hits,reset_at`)
        .get(keyFor(key), now + windowMs, now, now);
      return { totalHits: row.hits, resetTime: new Date(row.reset_at) };
    },
    async decrement(key) { await db.prepare('UPDATE request_limits SET hits=max(0,hits-1) WHERE key=?').run(keyFor(key)); },
    async resetKey(key) { await db.prepare('DELETE FROM request_limits WHERE key=?').run(keyFor(key)); }
  };
}
