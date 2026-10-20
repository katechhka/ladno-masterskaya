import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createProbe } from 'node:net';
import { createServer as createHTTPS } from 'node:https';
import { request as httpRequest } from 'node:http';
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { resolve,relative,isAbsolute } from 'node:path';
import { randomBytes,randomUUID } from 'node:crypto';
import { chromium,expect } from '@playwright/test';
import { localCertificate } from './lib/local-certificate.mjs';
import { projectRoot } from '../server/services/catalog.mjs';
import { openDatabase,migrate } from '../server/db/database.mjs';
import { initializeCatalog,storedCatalog } from '../server/services/catalog-store.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { createBookingService,publicSessions } from '../server/services/bookings.mjs';
import { passwordHash } from '../server/services/admin-auth.mjs';

const root=resolve(projectRoot,'.cache/tests');mkdirSync(root,{recursive:true});const directory=mkdtempSync(resolve(root,'acceptance-'));const filename=resolve(directory,'test.sqlite');
const screenshots=resolve(projectRoot,'docs/screenshots/stage-10');mkdirSync(screenshots,{recursive:true});
const report={phase:10,startedAt:new Date().toISOString(),isolatedDatabase:true,realMessagesSent:0,selfSignedLocalCertificate:true,systemTrustChanged:false,checks:[],footers:[],errors:[],consoleErrors:[],passed:false};
let browser,proxy,child,step='certificate',logs='';
const passed=text=>{report.checks.push(text);console.log(`OK: ${text}`);};
function inspect(callback){const db=openDatabase(filename);try{return callback(db);}finally{db.close();}}
async function stop(){if(!child||child.exitCode!==null||child.signalCode!==null)return;await new Promise((done,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Не удалось остановить тестовый сервер.'));},10000);child.once('close',()=>{clearTimeout(timer);done();});child.kill('SIGTERM');});}
try{
  const tls=await localCertificate(directory);const probe=createProbe();await new Promise(done=>probe.listen(0,'127.0.0.1',done));const backendPort=probe.address().port;await new Promise(done=>probe.close(done));
  proxy=createHTTPS(tls,(req,res)=>{
    const upstream=httpRequest({hostname:'127.0.0.1',port:backendPort,path:req.url,method:req.method,headers:{...req.headers,'x-forwarded-proto':'https','x-forwarded-for':req.socket.remoteAddress,'x-forwarded-host':req.headers.host,connection:'close'}},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
    upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
  });
  await new Promise(done=>proxy.listen(0,'127.0.0.1',done));const origin=`https://127.0.0.1:${proxy.address().port}`;
  const db=openDatabase(filename);migrate(db);initializeCatalog(db);const catalog=storedCatalog(db);seedSchedule(db,catalog.workshops);
  const session=publicSessions(db).find(s=>new Date(s.startsAt)>new Date());const program=catalog.workshops.find(w=>w.id===session.workshopId);
  const password=randomBytes(24).toString('base64url');db.prepare('INSERT INTO admin_owner VALUES (1,?,?)').run('owner',await passwordHash(password));
  const originalToken=randomBytes(32).toString('hex');const original=createBookingService(db,{catalog:()=>storedCatalog(db,{includeArchived:true})}).create({sessionId:session.id,quantity:1,expectedUnitPriceRub:program.priceRub,name:'Тестовая запись до изменения цены',phone:'+79000000000',email:'acceptance-old@example.test',comment:'',privacyConsent:true,policyConsent:true,rulesConsent:true,managementToken:originalToken},randomUUID()).booking;db.close();
  async function start(){
    child=spawn(process.execPath,['server/index.mjs'],{cwd:projectRoot,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(backendPort),PUBLIC_ORIGIN:origin,TRUST_PROXY:'1',DATABASE_PATH:filename,UPLOADS_DIR:resolve(directory,'uploads'),TELEGRAM_BOT_TOKEN:'',TELEGRAM_BOT_USERNAME:'',TELEGRAM_PROXY_URL:''}});
    await new Promise((done,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Production-сервер не запустился.')),20000);const failed=()=>{clearTimeout(timer);reject(new Error('Production-сервер завершился до готовности.'));};child.once('error',failed);child.once('exit',failed);child.stderr.on('data',chunk=>{logs+=chunk.toString();});child.stdout.on('data',chunk=>{output+=chunk.toString();logs+=chunk.toString();if(output.includes(`http://127.0.0.1:${backendPort}`)){clearTimeout(timer);child.removeListener('exit',failed);done();}});});
  }
  step='https';await start();browser=await chromium.launch({channel:'chrome',headless:true});
  const context=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000},reducedMotion:'reduce'});const page=await context.newPage();
  page.on('pageerror',error=>report.errors.push(error.message));page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
  const response=await page.goto(origin,{waitUntil:'networkidle'});assert.equal(response.status(),200);const security=await response.securityDetails();assert.ok(security.protocol.startsWith('TLS'));report.tlsProtocol=security.protocol;
  await page.locator('[data-cookie-dismiss]').click();passed('Настоящий production-процесс через локальный TLS-прокси; системное доверие не меняется');
  step='footer';
  for(const [label,width,height]of [['wide',1920,1080],['desktop',1440,1000],['tablet',768,1024],['mobile',360,800]]){
    await page.setViewportSize({width,height});await page.evaluate(()=>document.fonts.ready);await page.locator('.site-footer').scrollIntoViewIfNeeded();
    const metrics=await page.locator('.site-footer__link').evaluateAll(items=>items.map(item=>{const style=getComputedStyle(item);const box=item.getBoundingClientRect();return{top:Math.round(box.top),height:box.height,font:style.fontSize,lineHeight:style.lineHeight,padding:style.padding};}));
    assert.equal(metrics.length,5);assert.ok(metrics.every(item=>item.height>=44&&item.font===metrics[0].font&&item.lineHeight===metrics[0].lineHeight&&item.padding===metrics[0].padding));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('.site-footer').screenshot({path:resolve(screenshots,`footer-${label}.png`)});report.footers.push({width,metrics});
    await page.locator('[data-cookie-open]').click();await expect(page.locator('[data-cookie-notice]')).toBeVisible();await page.locator('[data-cookie-dismiss]').click();await expect(page.locator('[data-cookie-open]')).toBeFocused();
  }
  passed('Футер на 1920, 1440, 768 и 360 px: единое оформление, без дубля Cookie и переполнений; кнопка и фокус работают');
  await page.setViewportSize({width:1440,height:1000});
  step='admin-login';await page.goto(`${origin}/admin/`,{waitUntil:'networkidle'});await page.locator('[name=username]').fill('owner');await page.locator('[name=password]').fill(password);await page.getByRole('button',{name:'Войти в мастерскую'}).click();await expect(page.locator('[data-program-id]').first()).toBeVisible();
  const adminCookie=(await context.cookies()).find(cookie=>cookie.name==='__Host-ladno_admin');assert.ok(adminCookie?.secure&&adminCookie.httpOnly&&adminCookie.sameSite==='Strict');
  const state=await (await context.request.get(`${origin}/api/admin/session`)).json();const csrf=state.csrf;assert.ok(state.authenticated);
  assert.equal((await context.request.post(`${origin}/api/admin/bookings/search`,{data:{}})).status(),403);
  assert.equal((await context.request.post(`${origin}/api/admin/bookings/search`,{headers:{'X-CSRF-Token':csrf,Origin:'https://foreign.example.test'},data:{}})).status(),403);
  passed('Вход через HTTPS: __Host-cookie с Secure/HttpOnly/SameSite; отсутствие CSRF и чужой Origin отклоняются');
  step='admin-save';await page.goto(`${origin}/admin/?view=programs&edit=${program.id}`,{waitUntil:'networkidle'});await page.locator('[name=priceRub]').fill(String(program.priceRub+700));
  await page.locator('[name=photos]').setInputFiles(resolve(projectRoot,`src/assets/images/originals/${program.image}.png`));await page.locator('[data-photo-alt]').fill(program.imageAlt);await page.getByRole('button',{name:'Загрузить фотографии',exact:true}).click();await expect(page.locator('[data-upload-status]')).toContainText('Загружено: 1',{timeout:60000});
  await page.getByRole('button',{name:'Сохранить программу'}).click();await expect(page.locator('[data-program-id]').first()).toBeVisible();
  const media=inspect(db=>JSON.parse(db.prepare('SELECT data FROM media_uploads').get().data));
  await stop();await start();await page.reload({waitUntil:'networkidle'});await expect(page.locator('[data-program-id]').first()).toBeVisible();
  const changed=await (await context.request.get(`${origin}/api/catalog`)).json();assert.equal(changed.programs.find(w=>w.id===program.id).priceRub,program.priceRub+700);assert.equal((await context.request.get(`${origin}${media.src}`)).status(),200);
  const old=await (await context.request.get(`${origin}/api/bookings/me`,{headers:{Authorization:`Bearer ${originalToken}`}})).json();assert.equal(old.booking.totalRub,original.totalRub);
  passed('Цена и загруженное фото сохраняются после перезапуска; вход остаётся действующим, старая бронь сохраняет сумму');
  for(const kind of ['privacy','consent','cookies']){const document=await context.request.get(`${origin}/documents/${kind}-2026-10-20.pdf`);assert.equal(document.status(),200);assert.match(document.headers()['content-type'],/application\/pdf/);assert.equal((await document.body()).subarray(0,5).toString(),'%PDF-');}
  for(const path of ['/.env','/storage/admin-access.txt','/storage/ladno.sqlite','/.vite/manifest.json'])assert.equal((await context.request.get(`${origin}${path}`)).status(),404);
  await page.getByRole('button',{name:'Выйти',exact:true}).click();await expect(page.locator('[name=password]')).toBeVisible();assert.equal((await context.request.get(`${origin}/api/admin/data`)).status(),401);
  passed('PDF доступны через HTTPS; исходники, база, доступ владельца и manifest закрыты; выход отзывает сеанс');
  step='mobile-booking';const mobile=await browser.newContext({ignoreHTTPSErrors:true,viewport:{width:360,height:800},reducedMotion:'reduce'});const phone=await mobile.newPage();phone.on('pageerror',error=>report.errors.push(error.message));
  await phone.goto(`${origin}/booking/?session=${session.id}&quantity=2`,{waitUntil:'networkidle'});await phone.locator('[data-cookie-dismiss]').click();await phone.locator('[name=name]').fill('Тестовый участник HTTPS');await phone.locator('[name=phone]').fill('89000000000');await phone.locator('[name=email]').fill('acceptance-new@example.test');for(const name of ['policyConsent','privacyConsent','rulesConsent'])await phone.locator(`[name=${name}]`).check();
  await phone.getByRole('button',{name:'Проверить запись'}).click();await phone.locator('[data-confirm-booking]').click();await expect(phone.locator('[data-booking-status=confirmed]')).toBeVisible();
  const managementURL=phone.url();const newToken=new URLSearchParams(new URL(managementURL).hash.slice(1)).get('token');
  const booked=await (await mobile.request.get(`${origin}/api/bookings/me`,{headers:{Authorization:`Bearer ${newToken}`}})).json();assert.equal(booked.booking.totalRub,(program.priceRub+700)*2);
  await stop();await start();await phone.reload({waitUntil:'networkidle'});await expect(phone.locator('[data-booking-status=confirmed]')).toBeVisible();await phone.locator('[data-open-withdraw]').click();await phone.locator('[data-confirm-withdraw]').click();await expect(phone.locator('[data-booking-status=cancelled]')).toBeVisible();await expect(phone.locator('[data-booking-preview]')).not.toContainText('acceptance-new@example.test');
  const available=await (await mobile.request.get(`${origin}/api/sessions`)).json();assert.equal(available.sessions.find(s=>s.id===session.id).available,session.capacity-1);
  await phone.screenshot({path:resolve(screenshots,'https-withdraw-mobile.png'),fullPage:true});passed('360 px / HTTPS: запись двоих по новой цене, сохранение после перезапуска, отзыв и освобождение ровно двух мест');
  await mobile.close();await context.close();
  assert.ok(!logs.includes(password)&&!logs.includes(originalToken)&&!logs.includes('acceptance-new@example.test'));
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);passed('В проверенных браузерных сценариях нет ошибок JavaScript и консоли; секреты и контакты не попали в журнал');report.passed=true;
}catch(error){report.failure={step,message:error.message.replace(/[a-f0-9]{64}/g,'[token]')};throw error;}
finally{
  await browser?.close();await stop();if(proxy){proxy.closeAllConnections();await new Promise(done=>proxy.close(done));}
  report.finishedAt=new Date().toISOString();writeFileSync(resolve(projectRoot,'docs/acceptance-check.json'),`${JSON.stringify(report,null,2)}\n`);
  const inside=relative(root,directory);assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside));rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});
}
