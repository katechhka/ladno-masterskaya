import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {flow} from '../server/db/flow.mjs';
import {openDatabase,migrate} from '../server/db/database.mjs';
import {initializeCatalog,storedCatalog} from '../server/services/catalog-store.mjs';
import {seedSchedule} from '../server/services/schedule-seed.mjs';
import {createBookingService,publicSessions} from '../server/services/bookings.mjs';
import {adminService} from '../server/services/admin.mjs';

async function fixture(t){
 const raw=openDatabase(':memory:');t.after(()=>raw.close());let tail=Promise.resolve();
 const db={prepare(sql){const statement=raw.prepare(sql);return Object.fromEntries(['get','all','run'].map(method=>[method,async(...args)=>{await Promise.resolve();return statement[method](...args);} ]));},
 exec:async sql=>{await Promise.resolve();raw.exec(sql);},
 transaction(operation){const invoke=(...args)=>{const task=tail.then(async()=>{raw.exec('BEGIN IMMEDIATE');try{const result=await operation(...args);raw.exec('COMMIT');return result;}catch(error){raw.exec('ROLLBACK');throw error;}});tail=task.catch(()=>{});return task;};invoke.immediate=invoke;return invoke;}};
 await migrate(db);await initializeCatalog(db);const catalog=()=>storedCatalog(db,{includeArchived:true});
 const program=(await catalog()).workshops[0];await seedSchedule(db,(await catalog()).workshops);
 const session=(await publicSessions(db)).find(s=>new Date(s.startsAt)>new Date());
 const w=(await catalog()).workshops.find(w=>w.id===session.workshopId);
 const input={sessionId:session.id,quantity:1,expectedUnitPriceRub:w.priceRub,name:'Асинхронный тест',phone:'+79000000000',email:'async@example.test',comment:'',privacyConsent:true,policyConsent:true,rulesConsent:true,managementToken:randomBytes(32).toString('hex')};
 return{db,raw,program,session,input,catalog,service:createBookingService(db,{catalog}),admin:adminService(db)};
}
test('Общий flow: обычные значения, длинная последовательность, обещания и отклонение',async()=>{
 const sum=flow(function*(){let n=0;for(let i=0;i<100000;i++)n+=yield 1;return n;});assert.equal(sum(),100000);
 const recovery=flow(function*(){try{yield Promise.reject(new Error('test'));}catch{return yield Promise.resolve('recovered');}});assert.equal(await recovery(),'recovered');
 await assert.rejects(flow(function*(){yield Promise.resolve();throw new Error('rollback');})(),/rollback/);
});
test('Асинхронная база: подтверждение, цена, повтор запроса, отмена и отзыв',async t=>{
 const f=await fixture(t), key=randomUUID();const first=await f.service.create({...f.input,quantity:2},key);
 assert.equal(first.booking.totalRub,f.input.expectedUnitPriceRub*2);assert.equal((await f.service.create({...f.input,quantity:2},key)).replayed,true);
 await assert.rejects(f.service.create({...f.input,expectedUnitPriceRub:1},randomUUID()),{code:'PRICE_CHANGED'});
 assert.equal((await f.service.get(f.input.managementToken)).status,'confirmed');
 await f.service.cancel(f.input.managementToken);assert.equal((await f.service.cancel(f.input.managementToken)).alreadyCancelled,true);
 assert.equal((await publicSessions(f.db)).find(s=>s.id===f.session.id).available,f.session.capacity);
 const withdrawn=await f.service.withdraw(f.input.managementToken);assert.ok(withdrawn.booking.dataErasedAt);
});
test('Асинхронные параллельные записи не превышают вместимость; ошибка откатывает транзакцию',async t=>{
 const f=await fixture(t);f.raw.prepare('UPDATE sessions SET capacity=3 WHERE id=?').run(f.session.id);
 const results=await Promise.allSettled(Array.from({length:12},()=>f.service.create({...f.input,managementToken:randomBytes(32).toString('hex')},randomUUID())));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,3);assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='NO_SEATS'));
 await assert.rejects(f.db.transaction(async()=>{await f.db.prepare("INSERT INTO app_metadata VALUES ('must_rollback','1')").run();throw new Error('abort');}).immediate(),/abort/);
 assert.equal(f.raw.prepare("SELECT value FROM app_metadata WHERE key='must_rollback'").get(),undefined);
});
test('Асинхронная админка возвращает готовые сеансы и сохраняет цену без пересборки',async t=>{
 const f=await fixture(t);const data=await f.admin.bootstrap();assert.ok(data.sessions.length);assert.equal(typeof data.sessions[0].version,'number');assert.equal(typeof data.sessions[0].then,'undefined');
 const w=data.workshops[0],{gallery,version,archived,...program}=w;
 await f.admin.programSave({program:{...program,priceRub:program.priceRub+500},gallery,version,archived},w.id);
 assert.equal((await f.catalog()).workshops[0].priceRub,program.priceRub+500);
 const updated=(await f.catalog()).workshops.find(w=>w.id===f.session.workshopId);
 await f.service.create({...f.input,expectedUnitPriceRub:updated.priceRub},randomUUID());assert.equal((await f.admin.bookings({q:'АСИНХРОННЫЙ'})).bookings.length,1);
});
