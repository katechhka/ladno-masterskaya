import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdirSync,mkdtempSync,rmSync,readdirSync,readFileSync } from 'node:fs';
import { resolve,relative,isAbsolute } from 'node:path';
import sharp from 'sharp';
import { openDatabase,migrate } from '../server/db/database.mjs';
import { initializeCatalog,storedCatalog,readMedia } from '../server/services/catalog-store.mjs';
import { savePhoto } from '../server/services/media.mjs';
import { projectRoot } from '../server/services/catalog.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { createBookingService,publicSessions } from '../server/services/bookings.mjs';
import { purgeExpiredContacts } from '../server/services/privacy.mjs';
import { createApp } from '../server/app.mjs';
import { passwordHash } from '../server/services/admin-auth.mjs';
import { CONSENT_VERSION } from '../shared/consents.js';
function fixture(t){const db=openDatabase(':memory:');migrate(db);initializeCatalog(db);seedSchedule(db,storedCatalog(db).workshops);t.after(()=>db.close());const catalog=()=>storedCatalog(db,{includeArchived:true});const session=publicSessions(db).find(s=>new Date(s.startsAt)>new Date());const program=catalog().workshops.find(w=>w.id===session.workshopId);const token=randomBytes(32).toString('hex');const input={sessionId:session.id,quantity:2,expectedUnitPriceRub:program.priceRub,name:'Тестовый участник',phone:'+79000000000',email:'privacy@example.test',comment:'Тестовые данные',privacyConsent:true,policyConsent:true,rulesConsent:true,managementToken:token};return{db,session,input,token,service:createBookingService(db,{catalog})};}
function temp(t){const root=resolve(projectRoot,'.cache/tests');mkdirSync(root,{recursive:true});const directory=mkdtempSync(resolve(root,'media-'));t.after(()=>{const path=relative(root,directory);assert.ok(path&&!path.startsWith('..')&&!isAbsolute(path));rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});});return directory;}
const source=resolve(projectRoot,'src/assets/images/originals/hero.png');
test('Фотографии: создаются WebP/AVIF, EXIF удаляется, данные остаются в медиатеке',async t=>{
  const f=fixture(t);const directory=temp(t);const jpeg=await sharp(source).withExif({IFD0:{Artist:'PRIVATE_METADATA'}}).jpeg().toBuffer();
  const image=await savePhoto(f.db,jpeg,'Руки создают глиняную чашу',{directory});assert.equal(readdirSync(directory).length,6);assert.ok(readMedia(f.db)[image.id]);
  for(const file of readdirSync(directory)){const metadata=await sharp(readFileSync(resolve(directory,file))).metadata();assert.equal(metadata.exif,undefined);assert.equal(metadata.icc,undefined);assert.ok(metadata.width<=1200);assert.ok(['webp','heif'].includes(metadata.format));}
  assert.ok(image.avifSrcset.includes('1200w'));assert.equal(image.alt,'Руки создают глиняную чашу');
});
test('Фотографии: подпись, поддельный формат, SVG, маленький файл и размер проверяются до записи',async t=>{
  const f=fixture(t);const directory=temp(t);const png=await sharp(source).resize(100).png().toBuffer();
  for(const [buffer,alt,code]of [[Buffer.from('<svg/>'),'Описание фотографии','IMAGE_INVALID'],[png,'Описание фотографии','IMAGE_INVALID'],[Buffer.alloc(10*1024*1024+1),'Описание фотографии','IMAGE_SIZE'],[png,'нет','IMAGE_ALT']])await assert.rejects(savePhoto(f.db,buffer,alt,{directory}),{code});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM media_uploads').get().n,0);assert.equal(readdirSync(directory).length,0);
});
test('Фотографии API: без входа и CSRF нельзя загрузить; результат выдаётся как безопасное изображение',async t=>{
  const f=fixture(t);const directory=temp(t);const previous=process.env.UPLOADS_DIR;process.env.UPLOADS_DIR=directory;t.after(()=>{if(previous===undefined)delete process.env.UPLOADS_DIR;else process.env.UPLOADS_DIR=previous;});
  const password='photo-test-password-123';f.db.prepare('INSERT INTO admin_owner VALUES (1,?,?)').run('owner',await passwordHash(password));
  const {app}=createApp({db:f.db,limits:false});const server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));t.after(()=>new Promise(done=>server.close(done)));const base=`http://127.0.0.1:${server.address().port}`;
  const png=await sharp(source).resize(800).png().toBuffer();const upload=(extra={})=>fetch(`${base}/api/admin/media`,{method:'POST',headers:{'Content-Type':'image/png','X-Image-Alt':encodeURIComponent('Руки формируют глиняную чашу'),...extra},body:png});
  assert.equal((await upload()).status,401);const login=await fetch(`${base}/api/admin/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'owner',password})});const {csrf}=await login.json();const cookie=login.headers.get('set-cookie').split(';')[0];assert.equal((await upload({Cookie:cookie})).status,403);
  const result=await upload({Cookie:cookie,'X-CSRF-Token':csrf});assert.equal(result.status,201);const {image}=await result.json();const response=await fetch(`${base}${image.src}`);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/image\/webp/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');await response.arrayBuffer();
});
test('Согласия: все три обязательны, ложные и отсутствующие значения отклоняются, версия фиксируется',t=>{
  const f=fixture(t);for(const key of ['privacyConsent','policyConsent','rulesConsent'])for(const value of [false,undefined,'true'])assert.throws(()=>f.service.create({...f.input,[key]:value},randomUUID()),{code:'VALIDATION'});
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM bookings').get().n,0);f.service.create(f.input,randomUUID());const row=f.db.prepare('SELECT consent_version,consent_at FROM bookings').get();assert.equal(row.consent_version,CONSENT_VERSION);assert.ok(row.consent_at);
});
test('Отзыв: удаляет контакты и Telegram, отменяет будущую бронь и освобождает места один раз',t=>{
  const f=fixture(t);f.service.create(f.input,randomUUID());assert.throws(()=>f.service.withdraw('0'.repeat(64)),{code:'NOT_FOUND'});
  const id=f.db.prepare('SELECT id FROM bookings').get().id;
  f.db.prepare("INSERT INTO telegram_confirmations (booking_id,token_hash,expires_at,status,updated_at) VALUES (?,?,?,'pending',?)").run(id,'a'.repeat(64),new Date(Date.now()+600000).toISOString(),new Date().toISOString());
  const result=f.service.withdraw(f.token);assert.equal(result.booking.status,'cancelled');assert.ok(result.booking.dataErasedAt);assert.equal(result.booking.comment,'');assert.notEqual(result.booking.phone,f.input.phone);assert.notEqual(result.booking.email,f.input.email);assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM telegram_confirmations').get().n,0);assert.equal(publicSessions(f.db).find(s=>s.id===f.session.id).available,f.session.capacity);assert.equal(f.service.withdraw(f.token).alreadyErased,true);
});
test('Срок хранения: 90 дней после занятия; текущая бронь не очищается раньше',t=>{
  const f=fixture(t);f.service.create(f.input,randomUUID());const end=new Date(f.session.endsAt);assert.equal(purgeExpiredContacts(f.db,new Date(end.getTime()+89*86400000)),0);assert.equal(purgeExpiredContacts(f.db,new Date(end.getTime()+90*86400000)),1);assert.ok(f.service.get(f.token).dataErasedAt);assert.equal(purgeExpiredContacts(f.db,new Date(end.getTime()+91*86400000)),0);
});
