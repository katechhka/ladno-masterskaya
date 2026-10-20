import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { resolve } from 'node:path';
import { openDatabase, migrate } from './db/database.mjs';
import { projectRoot } from './services/catalog.mjs';
import { BookingError, createBookingService, publicPrograms, publicSessions } from './services/bookings.mjs';
import { createTelegramService } from './services/telegram.mjs';
import { initializeCatalog, storedCatalog } from './services/catalog-store.mjs';
import { adminAuth } from './services/admin-auth.mjs';
import { adminService } from './services/admin.mjs';
import { pageRenderer } from './render.mjs';
import { savePhoto, uploadDirectory, uploadFilename } from './services/media.mjs';
import { purgeExpiredContacts } from './services/privacy.mjs';

export function createApp({ db = openDatabase(), staticFiles = false, production = process.env.NODE_ENV === 'production', limits = true, telegramConfig, initialized = false, rateStore } = {}) {
  if (!initialized) { migrate(db); initializeCatalog(db); purgeExpiredContacts(db); }
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));
  const service = createBookingService(db, { catalog: () => storedCatalog(db, { includeArchived: true }) });
  const telegram = createTelegramService(db, { config: telegramConfig });
  const api = express.Router();
  api.use(helmet({ contentSecurityPolicy: false, strictTransportSecurity: production ? undefined : false, referrerPolicy: { policy: 'no-referrer' } }));
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  if (limits) api.use(rateLimit({ windowMs: 60000, limit: 120, ...(rateStore ? {store:rateStore('api')} : {}), standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMIT', message: 'Слишком много запросов. Подождите минуту и попробуйте снова.' } } }));
  api.use((req, _res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      const expected = production && process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : `${req.protocol}://${req.get('host')}`;
      if (req.get('sec-fetch-site') === 'cross-site' || (req.get('origin') && req.get('origin') !== expected)) return next(new BookingError(403, 'ORIGIN', 'Запрос с другого сайта отклонён.'));
      const photoUpload = req.method === 'POST' && req.path === '/admin/media' && ['image/jpeg','image/png','image/webp'].some(type=>req.is(type));
      if (!req.is('application/json') && !photoUpload) return next(new BookingError(415, 'CONTENT_TYPE', 'Ожидается JSON или фотография JPEG, PNG, WebP в форме загрузки.'));
    }
    next();
  });
  api.use(express.json({ limit: '16kb' }));
  const token = (req) => req.get('authorization')?.replace(/^Bearer /, '');
  api.get('/catalog', async (_req, res) => res.json({ programs: publicPrograms(await storedCatalog(db)) }));
  api.get('/sessions', async (_req, res) => res.json({ generatedAt: new Date().toISOString(), timezone: 'Europe/Moscow', sessions: await publicSessions(db) }));
  const auth = adminAuth(db, { production }); const management = adminService(db); const admin = express.Router();
  admin.get('/session', async (req, res) => { const session = await auth.read(req); res.json({ authenticated: Boolean(session), configured: await auth.configured(), ...(session ? { csrf: session.csrf_token } : {}) }); });
  if (limits) admin.use('/login', rateLimit({ windowMs: 15 * 60000, limit: 5, ...(rateStore ? {store:rateStore('login')} : {}), standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'LOGIN_LIMIT', message: 'Слишком много попыток входа. Попробуйте через 15 минут.' } } }));
  admin.post('/login', async (req, res) => res.json(await auth.login(req.body?.username, req.body?.password, res)));
  admin.use(auth.require);
  if (limits) admin.use('/media', rateLimit({ windowMs:60000,limit:12,...(rateStore ? {store:rateStore('media')} : {}),standardHeaders:'draft-8',legacyHeaders:false,message:{error:{code:'UPLOAD_LIMIT',message:'Слишком много загрузок. Подождите минуту.'}} }));
  let uploading = 0;
  admin.post('/media', express.raw({type:['image/jpeg','image/png','image/webp'],limit:'10mb'}), async (req,res) => {
    if (uploading >= 2) throw new BookingError(429,'UPLOAD_BUSY','Другие фотографии ещё обрабатываются. Повторите чуть позже.');
    let alt;try{alt=decodeURIComponent(req.get('x-image-alt')||'');}catch{throw new BookingError(422,'IMAGE_ALT','Проверьте описание фотографии.');}
    uploading++;try{res.status(201).json({image:await savePhoto(db,req.body,alt)});}finally{uploading--;}
  });
  admin.post('/logout', async (req, res) => { await auth.logout(req, res); res.json({ loggedOut: true }); });
  admin.get('/data', async (_req, res) => res.json(await management.bootstrap()));
  admin.put('/programs/:id', async (req, res) => res.json(await management.programSave(req.body, req.params.id)));
  admin.post('/sessions', async (req, res) => res.json(await management.sessionSave(req.body)));
  admin.put('/sessions/:id', async (req, res) => res.json(await management.sessionSave(req.body, req.params.id)));
  admin.get('/bookings', async (req, res) => res.json(await management.bookings(req.query)));
  admin.post('/bookings/search', async (req, res) => res.json(await management.bookings(req.body || {})));
  admin.post('/bookings/:id', async (req, res) => res.json(await management.bookingAction(req.params.id, req.body)));
  api.use('/admin', admin);
  if (limits) api.use('/bookings', rateLimit({ windowMs: 60000, limit: 20, ...(rateStore ? {store:rateStore('bookings')} : {}), standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMIT', message: 'Слишком много действий с записью. Подождите минуту.' } } }));
  api.post('/bookings', async (req, res) => { const result = await service.create(req.body, req.get('idempotency-key')); res.status(result.replayed ? 200 : 201).json(result); });
  api.get('/bookings/me', async (req, res) => { const booking = await service.get(token(req)); res.json({ booking, telegram: await telegram.state(booking.reference) }); });
  api.get('/bookings/me/telegram', async (req, res) => res.json(await telegram.state((await service.get(token(req))).reference)));
  api.post('/bookings/me/telegram', async (req, res) => res.json(await telegram.issue((await service.get(token(req))).reference)));
  api.post('/bookings/me/cancel', async (req, res) => res.json(await service.cancel(token(req))));
  api.post('/bookings/me/withdraw', async (req, res) => res.json(await service.withdraw(token(req))));
  api.use((_req, _res, next) => next(new BookingError(404, 'NOT_FOUND', 'Такого API-адреса нет.')));
  api.use((error, _req, res, _next) => {
    if (error instanceof BookingError) return res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.fields ? { fields: error.fields } : {}) } });
    if (error.type === 'entity.too.large' && _req.path.includes('/media')) return res.status(413).json({error:{code:'IMAGE_SIZE',message:'Размер фотографии не должен превышать 10 МБ.'}});
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Не удалось прочитать форму. Проверьте данные.' } });
    // Не пишем тело запроса, контакты, токены или SQLite-параметры в журнал.
    res.status(503).json({ error: { code: 'SERVER_UNAVAILABLE', message: 'Сервис записи временно недоступен. Повторите запрос чуть позже.' } });
  });
  app.use('/api', api);
  app.get('/media/:file', async (req,res,next) => {
    if (!uploadFilename.test(req.params.file)) return next();
    res.set({'X-Content-Type-Options':'nosniff','Cache-Control':'public, max-age=31536000, immutable'});
    if (db.remote) {
      const id=req.params.file.replace(/-(480|800|1200)\.(webp|avif)$/,'');
      const row=await db.prepare('SELECT data FROM media_uploads WHERE id=?').get(id);
      const url=row && JSON.parse(row.data).objects?.[req.params.file];
      if(!url) return res.status(404).end();
      const remote=await fetch(url,{signal:AbortSignal.timeout(15000)});
      if(!remote.ok) return res.status(503).end();
      res.type(req.params.file.endsWith('.avif')?'image/avif':'image/webp');
      return res.send(Buffer.from(await remote.arrayBuffer()));
    }
    res.sendFile(resolve(uploadDirectory(),req.params.file),{dotfiles:'allow'},error=>{if(error&&!res.headersSent)res.status(404).end();});
  });
  if (staticFiles) {
    app.use(helmet({ referrerPolicy: { policy: 'no-referrer' }, contentSecurityPolicy: {
      directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], fontSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"], objectSrc: ["'none'"], upgradeInsecureRequests: production ? [] : null }
    }, strictTransportSecurity: production ? undefined : false }));
    app.use(['/booking','/admin'], (_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }); next(); });
    app.use(pageRenderer(db));
    app.use(express.static(resolve(projectRoot, 'dist'), { dotfiles: 'deny' }));
    app.use((_req, res) => res.status(404).sendFile(resolve(projectRoot, 'dist/404.html')));
  }
  return { app, db };
}
