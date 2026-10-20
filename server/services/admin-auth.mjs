import { flow } from '../db/flow.mjs';
import {randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {BookingError} from './bookings.mjs';
const scrypt = promisify(scryptCallback);
const hash = text => createHash('sha256').update(text).digest('hex');
export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) throw new Error('Пароль должен содержать от 12 до 200 символов.');
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${Buffer.from(await scrypt(password, salt, 64)).toString('hex')}`;
}
async function matches(password, encoded) {
  const [, salt, expected] = encoded.split(':');
  const actual = Buffer.from(await scrypt(password, salt, 64));
  const target = Buffer.from(expected, 'hex');
  return actual.length === target.length && timingSafeEqual(actual, target);
}
export function adminAuth(db, {production = false, now = () => new Date()} = {}) {
  const cookieName = production ? '__Host-ladno_admin' : 'ladno_admin';
  const cookie = (token, maxAge) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${production ? '; Secure' : ''}`;
  const read = flow(function* (req) {
    const token = req.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!(/^[a-f0-9]{64}$/).test(token || '')) return null;
    return yield db.prepare('SELECT * FROM admin_sessions WHERE token_hash=? AND expires_at>?').get(hash(token), now().toISOString());
  });
  return {
    configured: flow(function* () {
      return Boolean(yield db.prepare('SELECT id FROM admin_owner WHERE id=1').get());
    }),
    read,
    require: flow(function* (req, _res, next) {
      const session = yield read(req);
      if (!session) return next(new BookingError(401, 'ADMIN_AUTH', 'Войдите в управление мастерской.'));
      if (!['GET', 'HEAD'].includes(req.method) && (yield req.get('x-csrf-token')) !== session.csrf_token) return next(new BookingError(403, 'CSRF', 'Сессия формы устарела. Обновите страницу.'));
      req.adminSession = session;
      next();
    }),
    async login(username, password, res) {
      if (typeof username !== 'string' || typeof password !== 'string' || username.length > 100 || password.length > 200) throw new BookingError(401, 'LOGIN', 'Проверьте логин и пароль.');
      const owner = await db.prepare('SELECT * FROM admin_owner WHERE id=1').get();
      const ok = await matches(password, owner?.password_hash || `scrypt:${('0').repeat(32)}:${('0').repeat(128)}`);
      if (!owner || username !== owner.username || !ok) throw new BookingError(401, 'LOGIN', 'Проверьте логин и пароль.');
      const token = randomBytes(32).toString('hex');
      const csrf = randomBytes(32).toString('hex');
      await db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').run(now().toISOString());
      await db.prepare('INSERT INTO admin_sessions VALUES (?,?,?)').run(hash(token), csrf, new Date(now().getTime() + 8 * 3600000).toISOString());
      res.setHeader('Set-Cookie', cookie(token, 8 * 3600));
      return {
        username: owner.username,
        csrf
      };
    },
    logout: flow(function* (req, res) {
      yield db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(req.adminSession.token_hash);
      res.setHeader('Set-Cookie', cookie('', 0));
    })
  };
}
