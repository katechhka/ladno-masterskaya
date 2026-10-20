import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { projectRoot, loadCatalog } from '../server/services/catalog.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { openDatabase, migrate } from '../server/db/database.mjs';
import { initializeCatalog, storedCatalog } from '../server/services/catalog-store.mjs';
import { adminService } from '../server/services/admin.mjs';
import { adminAuth, passwordHash } from '../server/services/admin-auth.mjs';
import { createBookingService, publicSessions } from '../server/services/bookings.mjs';
import { createApp } from '../server/app.mjs';
import { dayKey, shiftDay } from '../src/scripts/services/dates.js';
function fixture(t) {
  const db=openDatabase(':memory:');migrate(db);initializeCatalog(db);t.after(()=>db.close());
  const admin=adminService(db); const catalog=()=>storedCatalog(db,{includeArchived:true});const w=catalog().workshops[0];
  const payload=(w)=>{const {archived,version,gallery,...program}=w;return{program,gallery,archived,version};};
  const body={workshopId:w.id,startsLocal:`${shiftDay(dayKey(),50)}T10:00`,capacity:8,bookingOpen:true,cancel:false,confirmed:false,version:0};
  const service=createBookingService(db,{catalog});
  const createBooking=(session)=>{const managementToken=randomBytes(32).toString('hex');const input={sessionId:session.id,quantity:2,expectedUnitPriceRub:w.priceRub,name:'Тестовый гость',phone:'+79000000000',email:'owner-test@example.test',comment:'',privacyConsent: true, policyConsent: true,rulesConsent:true,managementToken};return{...service.create(input,randomUUID()),managementToken,input};};
  return{db,admin,catalog,w,payload,body,service,createBooking};
}
test('Админка: импорт идемпотентен, цена меняется без изменения сохранённой брони; архив закрывает новую запись',t=>{
  const f=fixture(t);f.admin.sessionSave(f.body);const session=publicSessions(f.db)[0];const booking=f.createBooking(session);
  const changed=f.payload(f.w);changed.program.priceRub+=500;f.admin.programSave(changed,f.w.id);initializeCatalog(f.db);
  assert.equal(f.catalog().workshops[0].priceRub,f.w.priceRub+500);assert.equal(f.service.get(booking.managementToken).totalRub,f.w.priceRub*2);
  assert.throws(()=>f.service.create({...booking.input,managementToken:randomBytes(32).toString('hex')},randomUUID()),{code:'PRICE_CHANGED'});
  assert.throws(()=>f.admin.programSave(changed,f.w.id),{code:'VERSION'});
  const hidden=f.payload(f.catalog().workshops[0]);hidden.archived=true;f.admin.programSave(hidden,f.w.id);
  assert.ok(!storedCatalog(f.db).workshops.some(w=>w.id===f.w.id));assert.equal(f.service.get(booking.managementToken).status,'confirmed');
  assert.throws(()=>f.service.create({...booking.input,expectedUnitPriceRub:hidden.program.priceRub,managementToken:randomBytes(32).toString('hex')},randomUUID()),{code:'UNAVAILABLE'});
});
test('Админка: новая программа, валидация фотографий и постоянного адреса',t=>{
  const f=fixture(t);const p=f.payload(f.w);p.program={...p.program,id:'new-program',slug:'new-program',title:'Новое занятие',relatedIds:f.catalog().workshops.slice(0,2).map(w=>w.id)};p.version=0;
  f.admin.programSave(p,p.program.id);assert.equal(storedCatalog(f.db).workshops.length,15);
  assert.throws(()=>f.admin.programSave({...p,version:1,gallery:['missing','missing']},p.program.id),{code:'IMAGE'});
  assert.throws(()=>f.admin.programSave({...p,version:1,program:{...p.program,slug:'different'}},p.program.id),{code:'IMMUTABLE'});
});
test('Админка: повторения и пересечения сохраняются атомарно; закрытая запись недоступна',t=>{
  const f=fixture(t);const next=shiftDay(f.body.startsLocal.slice(0,10),7);f.admin.sessionSave({...f.body,dates:[next]});assert.equal(publicSessions(f.db).length,2);
  assert.throws(()=>f.admin.sessionSave({...f.body,startsLocal:`${shiftDay(f.body.startsLocal.slice(0,10),1)}T10:00`,dates:[next]}),{code:'DUPLICATE_SESSION'});assert.equal(publicSessions(f.db).length,2);
  assert.throws(()=>f.admin.sessionSave({...f.body,startsLocal:f.body.startsLocal.replace('10:00','10:30')}),{code:'OVERLAP'});
  const s=publicSessions(f.db)[0];f.admin.sessionSave({...f.body,bookingOpen:false,version:1},s.id);
  assert.equal(publicSessions(f.db)[0].status,'closed');assert.throws(()=>f.createBooking(s),{code:'UNAVAILABLE'});
  assert.throws(()=>f.admin.sessionSave({...f.body,version:1},s.id),{code:'VERSION'});
});
test('Админка: вместимость, перенос, подтверждение отмены и пометка об уведомлении',t=>{
  const f=fixture(t);f.admin.sessionSave(f.body);let s=publicSessions(f.db)[0];const b=f.createBooking(s);
  assert.equal(f.admin.bookings({q:'тестовый'}).bookings.length,1);
  assert.throws(()=>f.admin.sessionSave({...f.body,capacity:1,version:1},s.id),{code:'CAPACITY'});
  const moved={...f.body,startsLocal:`${shiftDay(f.body.startsLocal.slice(0,10),1)}T10:00`,version:1};
  assert.throws(()=>f.admin.sessionSave(moved,s.id),{code:'CONFIRM_REQUIRED'});
  f.admin.sessionSave({...moved,confirmed:true},s.id);assert.equal(f.admin.bookings().bookings[0].notificationRequired,1);
  assert.notEqual(f.service.get(b.managementToken).session.startsAt,s.startsAt);
  const id=f.admin.bookings().bookings[0].id;f.admin.bookingAction(id,{action:'notified',confirmed:true});assert.equal(f.admin.bookings().bookings[0].notificationRequired,0);
  f.admin.sessionSave({...moved,version:2,cancel:true,confirmed:true},s.id);
  assert.equal(f.service.get(b.managementToken).status,'cancelled');assert.equal(publicSessions(f.db)[0].available,8);assert.equal(f.admin.bookings().bookings[0].notificationRequired,1);
  assert.throws(()=>f.admin.sessionSave({...moved,version:3},s.id),{code:'CANCELLED'});
});
test('Админка: вход, Cookie, CSRF, чужой Origin, выход и истечение сессии',async t=>{
  const f=fixture(t);const password='test-owner-password-123';const encoded=await passwordHash(password);assert.ok(!encoded.includes(password));
  f.db.prepare('INSERT INTO admin_owner VALUES (1,?,?)').run('owner',encoded);
  const {app}=createApp({db:f.db,limits:false});const server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));t.after(()=>new Promise(done=>server.close(done)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const req=(path,method='GET',body,headers={})=>fetch(`${origin}/api/admin${path}`,{method,headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal((await req('/data')).status,401);assert.equal((await req('/login','POST',{username:'owner',password:'bad'})).status,401);
  const login=await req('/login','POST',{username:'owner',password});assert.equal(login.status,200);const {csrf}=await login.json();const cookie=login.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
  const headers={Cookie:cookie.split(';')[0]};assert.equal((await req('/data','GET',null,headers)).status,200);
  assert.equal((await req('/sessions','POST',f.body,headers)).status,403);
  assert.equal((await req('/sessions','POST',f.body,{...headers,'X-CSRF-Token':csrf,Origin:'https://evil.example.test'})).status,403);
  assert.equal((await req('/sessions','POST',f.body,{...headers,'X-CSRF-Token':csrf})).status,200);
  assert.equal((await req('/logout','POST',{}, {...headers,'X-CSRF-Token':csrf})).status,200);assert.equal((await req('/data','GET',null,headers)).status,401);
  const res={setHeader(){}};const auth=adminAuth(f.db,{production:true,now:()=>new Date('2030-01-01T00:00:00Z')});
  let secureCookie;await auth.login('owner',password,{setHeader(_key,value){secureCookie=value;}});assert.match(secureCookie,/__Host-ladno_admin/);assert.match(secureCookie,/; Secure/);
  const expired=adminAuth(f.db,{production:true,now:()=>new Date('2030-01-02T00:00:00Z')});assert.equal(expired.read({headers:{cookie:secureCookie.split(';')[0]}}),undefined);
});

test('Админка: миграция старой базы сохраняет бронь, а правки переживают повторный импорт и открытие файла',async t=>{
  const root=resolve(projectRoot,'.cache/tests');mkdirSync(root,{recursive:true});const dir=mkdtempSync(resolve(root,'admin-migration-'));const file=resolve(dir,'test.sqlite');
  t.after(()=>{const path=relative(root,dir);assert.ok(path&&!path.startsWith('..')&&!isAbsolute(path));rmSync(dir,{recursive:true,force:true});});
  let db=openDatabase(file);
  try{
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY,applied_at TEXT NOT NULL) STRICT');
    for(const name of ['001-initial.sql','002-telegram.sql']){db.exec(readFileSync(resolve(projectRoot,'server/db/migrations',name),'utf8'));db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(name,new Date().toISOString());}
    seedSchedule(db,loadCatalog().workshops);const s=db.prepare('SELECT * FROM sessions ORDER BY starts_at DESC LIMIT 1').get();const token=randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO bookings (id,reference,session_id,quantity,unit_price_kopecks,total_kopecks,customer_name,phone,email,management_token_hash,consent_version,consent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('legacy-booking','LD-LEGACY',s.id,2,200000,400000,'Тестовый гость','+79000000000','legacy@example.test',createHash('sha256').update(token).digest('hex'),'v1',new Date().toISOString(),new Date().toISOString());
    assert.ok(migrate(db)>0);initializeCatalog(db);const w=storedCatalog(db).workshops[0];const {archived,version,gallery,...program}=w;
    adminService(db).programSave({program:{...program,priceRub:9999},gallery,version,archived:true},w.id);db.close();db=openDatabase(file);migrate(db);initializeCatalog(db);
    const stored=storedCatalog(db,{includeArchived:true}).workshops.find(item=>item.id===w.id);assert.equal(stored.priceRub,9999);assert.equal(stored.archived,true);
    const booking=createBookingService(db,{catalog:()=>storedCatalog(db,{includeArchived:true})}).get(token);assert.equal(booking.reference,'LD-LEGACY');assert.equal(booking.totalRub,4000);assert.equal(booking.quantity,2);assert.equal(booking.status,'confirmed');
  }finally{db.close();}
});

test('Админка: частые попытки входа блокируются без открытия закрытых данных',async t=>{
  const f=fixture(t);const {app}=createApp({db:f.db,limits:true});const server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));t.after(()=>new Promise(done=>server.close(done)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const attempt=()=>fetch(`${base}/api/admin/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'unknown',password:'wrong-password'})});
  for(let i=0;i<5;i++)assert.equal((await attempt()).status,401);
  const limited=await attempt();assert.equal(limited.status,429);assert.ok(limited.headers.get('retry-after'));assert.equal((await limited.json()).error.code,'LOGIN_LIMIT');
  assert.equal((await fetch(`${base}/api/admin/data`)).status,401);
});
