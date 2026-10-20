import { flow } from '../db/flow.mjs';
import {createHash} from 'node:crypto';
const DAY_MS = 86400000;
const MOSCOW_OFFSET_MS = 3 * 3600000;
const hash = value => createHash('sha256').update(value).digest('hex');
export function moscowDay(now) {
  const shifted = new Date(now.getTime() + MOSCOW_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}
export function createDemoSessions(workshops, {anchorDay, createdAt}) {
  const start = new Date(`${anchorDay}T00:00:00+03:00`);
  if (Number.isNaN(start.getTime())) throw new Error('Некорректная дата наполнения');
  const sessions = [];
  let programIndex = 0;
  for (let offset = -1; offset < 42; offset += 1) {
    const day = new Date(start.getTime() + offset * DAY_MS);
    const weekday = new Date(day.getTime() + MOSCOW_OFFSET_MS).getUTCDay();
    if (weekday === 1 || weekday === 2) continue;
    const times = weekday === 0 || weekday === 6 ? ['11:00', '15:00'] : ['18:30'];
    for (const time of times) {
      const workshop = workshops[programIndex % workshops.length];
      const startsAt = new Date(`${moscowDay(day)}T${time}:00+03:00`);
      sessions.push({
        id: `session-${hash(`${workshop.id}:${startsAt.toISOString()}`).slice(0, 24)}`,
        workshopId: workshop.id,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + workshop.durationMinutes * 60000).toISOString(),
        capacity: workshop.capacity,
        createdAt
      });
      programIndex += 1;
    }
  }
  return sessions;
}
export const seedSchedule = flow(function* seedSchedule(db, workshops, {now = new Date()} = {}) {
  const createdAt = now.toISOString();
  if(db.batch){
    yield db.prepare('INSERT OR IGNORE INTO app_metadata (key,value) VALUES (?,?)').run('seed_anchor_day',moscowDay(now));
    const anchorDay=(yield db.prepare("SELECT value FROM app_metadata WHERE key='seed_anchor_day'").get()).value;
    const sessions=createDemoSessions(workshops,{anchorDay,createdAt});
    const results=yield db.batch(sessions.map(s=>({sql:'INSERT OR IGNORE INTO sessions (id,workshop_id,starts_at,ends_at,capacity,created_at) VALUES (?,?,?,?,?,?)',args:[s.id,s.workshopId,s.startsAt,s.endsAt,s.capacity,s.createdAt]})));
    return {anchorDay,inserted:results.reduce((n,r)=>n+r.rowsAffected,0),total:(yield db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).count};
  }
  return yield db.transaction(flow(function* () {
    const existing = yield db.prepare("SELECT value FROM app_metadata WHERE key = 'seed_anchor_day'").get();
    const anchorDay = existing?.value || moscowDay(now);
    yield db.prepare('INSERT OR IGNORE INTO app_metadata (key, value) VALUES (?, ?)').run('seed_anchor_day', anchorDay);
    const sessions = createDemoSessions(workshops, {
      anchorDay,
      createdAt
    });
    const insert = db.prepare('INSERT OR IGNORE INTO sessions (id, workshop_id, starts_at, ends_at, capacity, created_at) VALUES (@id, @workshopId, @startsAt, @endsAt, @capacity, @createdAt)');
    let inserted = 0;
    for (const session of sessions) inserted += (yield insert.run(session)).changes;
    return {
      anchorDay,
      inserted,
      total: (yield db.prepare('SELECT COUNT(*) AS count FROM sessions').get()).count
    };
  })).immediate();
});
