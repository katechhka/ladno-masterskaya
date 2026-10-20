import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {randomBytes,randomUUID,randomInt} from 'node:crypto';
import {chromium,expect as baseExpect} from '@playwright/test';
import {Agent,ProxyAgent,setGlobalDispatcher} from 'undici';
import {dayKey,shiftDay} from '../src/scripts/services/dates.js';

const base=process.env.CLOUD_URL||'https://ladno-masterskaya.vercel.app';
const expect=baseExpect.configure({timeout:45000});
const dispatcher=process.env.TELEGRAM_PROXY_URL?new ProxyAgent(process.env.TELEGRAM_PROXY_URL):new Agent({connect:{timeout:30000}});
setGlobalDispatcher(dispatcher);
const access=readFileSync('storage/cloud-admin-access.txt','utf8');
const password=access.match(/Пароль: (.+)/)?.[1];
assert.ok(password,'Нет закрытого файла облачного доступа');
const report={startedAt:new Date().toISOString(),url:base,checks:[],errors:[],passed:false,realMessagesSent:0};
const log=message=>{report.checks.push(message);console.log('OK:',message);};
let cookie='',csrf='',original,session,uiSession,browser;const created=[];
async function request(path,{method='GET',body,token,key,headers={}}={}){
 for(let attempt=0;attempt<4;attempt++){
  let response;try{response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Origin:base,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-CSRF-Token':csrf}:{}),...(token?{Authorization:`Bearer ${token}`} :{}),...(key?{'Idempotency-Key':key}:{}),...headers},...(body!==undefined?{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(65000)});}catch(error){if(attempt<3&&(method==='GET'||key))continue;throw error;}
  if(response.status===429&&attempt<3){await new Promise(resolve=>setTimeout(resolve,Math.min(60000,Math.max(1000,Number(response.headers.get('retry-after')||5)*1000))));continue;}
  const data=response.headers.get('content-type')?.includes('json')?await response.json():await response.text();
  return{status:response.status,data,response};
 }
}
async function good(path,options){const result=await request(path,options);assert.ok(result.status>=200&&result.status<300,`${path}: ${result.status} ${result.data.error?.code||''}`);return result;}
const payload=(row,changes={})=>{const{gallery,version,archived,...program}=row;return{program:{...program,...changes},gallery,version,archived};};
const bookingInput=(quantity=1)=>({sessionId:session.id,quantity,expectedUnitPriceRub:original.priceRub+100,name:'Проверка публикации',phone:'+79000000000',email:'cloud-check@example.test',comment:'Автоматическая проверка демоверсии',privacyConsent:true,policyConsent:true,rulesConsent:true,managementToken:randomBytes(32).toString('hex')});
async function available(id){return(await good('/api/sessions')).data.sessions.find(s=>s.id===id).available;}
try{
 const login=await good('/api/admin/login',{method:'POST',body:{username:'owner',password}});cookie=login.response.headers.get('set-cookie').split(';')[0];csrf=login.data.csrf;
 assert.match(login.response.headers.get('set-cookie'),/; Secure/);log('Облачный вход хозяйки, Secure/HttpOnly cookie и закрытый API');
 const data=(await good('/api/admin/data')).data;assert.equal(data.workshops.length,14);assert.ok(data.workshops.every(w=>w.gallery.length>=2));original=data.workshops[0];
 const day=shiftDay(dayKey(),randomInt(65,365));const form={workshopId:original.id,startsLocal:`${day}T10:00`,capacity:3,bookingOpen:true,cancel:false,version:0,confirmed:false,dates:[]};
 await good('/api/admin/sessions',{method:'POST',body:form});
 session=(await good('/api/sessions')).data.sessions.find(s=>s.workshopId===original.id&&dayKey(s.startsAt)===day);
 assert.ok(session);log('Создание сеанса в постоянной облачной базе');
 const oldInput={...bookingInput(),expectedUnitPriceRub:original.priceRub},oldKey=randomUUID();
 const old=(await good('/api/bookings',{method:'POST',body:oldInput,key:oldKey})).data;created.push(oldInput.managementToken);
 await good(`/api/admin/programs/${original.id}`,{method:'PUT',body:payload(original,{priceRub:original.priceRub+100})});
 assert.equal((await good('/api/bookings/me',{token:oldInput.managementToken})).data.booking.unitPriceRub,original.priceRub);
 assert.equal((await good('/api/bookings',{method:'POST',body:oldInput,key:oldKey})).data.replayed,true);log('Новая цена без пересборки, старая сумма и защита повторного запроса');
 const inputs=Array.from({length:6},()=>({input:bookingInput(),key:randomUUID()}));
 const results=await Promise.all(inputs.map(async item=>({...item,result:await request('/api/bookings',{method:'POST',body:item.input,key:item.key})})));
 const winners=results.filter(item=>[200,201].includes(item.result.status));assert.equal(winners.length,2);assert.equal(await available(session.id),0);
 for(const item of winners)created.push(item.input.managementToken);
 assert.ok(results.filter(item=>![200,201].includes(item.result.status)).every(item=>[409,503].includes(item.result.status)));log('Шесть одновременных запросов на два последних места: переполнения нет');
 for(const item of winners){await good('/api/bookings/me/cancel',{method:'POST',body:{},token:item.input.managementToken});await good('/api/bookings/me/cancel',{method:'POST',body:{},token:item.input.managementToken});}
 assert.equal(await available(session.id),2);
 const groupInput=bookingInput(2),group=(await good('/api/bookings',{method:'POST',body:groupInput,key:randomUUID()})).data;created.push(groupInput.managementToken);assert.equal(group.booking.totalRub,(original.priceRub+100)*2);
 assert.equal((await request('/api/bookings',{method:'POST',body:bookingInput(),key:randomUUID()})).data.error.code,'NO_SEATS');
 const withdrawn=(await good('/api/bookings/me/withdraw',{method:'POST',body:{},token:oldInput.managementToken})).data;
 assert.ok(withdrawn.booking.dataErasedAt);assert.equal(await available(session.id),1);
 await good('/api/bookings/me/cancel',{method:'POST',body:{},token:groupInput.managementToken});assert.equal(await available(session.id),3);log('Группа, заполненный сеанс, повтор отмены и отзыв с точным освобождением мест');
 assert.equal((await request('/api/bookings/me',{token:'0'.repeat(64)})).status,404);log('Чужой токен не раскрывает персональные данные');
 const uploaded=(await good('/api/admin/media',{method:'POST',body:readFileSync('src/assets/images/originals/hero.png'),headers:{'Content-Type':'image/png','X-Image-Alt':encodeURIComponent('Рабочий стол и материалы для проверки публикации')}})).data.image;
 const current=(await good('/api/admin/data')).data.workshops.find(w=>w.id===original.id);
 await good(`/api/admin/programs/${original.id}`,{method:'PUT',body:{...payload(current,{image:uploaded.id,imageAlt:uploaded.alt}),gallery:[uploaded.id,...original.gallery].slice(0,6)}});
 const photo=await fetch(base+uploaded.src);assert.equal(photo.status,200);assert.match(photo.headers.get('content-type'),/image\/webp/);assert.ok((await photo.arrayBuffer()).byteLength>1000);
 const html=await(await fetch(`${base}/master-classes/${original.slug}/`)).text();assert.ok(html.includes(uploaded.id));log('Собственное фото сохранено в Blob и опубликовано в галерее без сборки');
 const uiDay=shiftDay(day,1);await good('/api/admin/sessions',{method:'POST',body:{...form,startsLocal:`${uiDay}T10:00`,capacity:4}});
 uiSession=(await good('/api/sessions')).data.sessions.find(s=>s.workshopId===original.id&&dayKey(s.startsAt)===uiDay);
 console.log('Браузерный сценарий начинается после обновления минутного лимита записи.');
 await new Promise(resolve=>setTimeout(resolve,60000));
 browser=await chromium.launch({channel:'chrome',headless:true});const context=await browser.newContext({viewport:{width:360,height:800}});const page=await context.newPage();page.setDefaultTimeout(45000);
 page.on('pageerror',e=>report.errors.push(e.message));
 mkdirSync('docs/screenshots/vercel',{recursive:true});
 await page.goto(base,{waitUntil:'networkidle',timeout:65000});await expect(page.getByRole('heading',{level:1})).toBeVisible();await page.evaluate(()=>Promise.all([...document.images].map(image=>{image.loading='eager';return image.decode().catch(()=>{});})));await page.screenshot({path:'docs/screenshots/vercel/home-mobile.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.goto(`${base}/booking/?session=${uiSession.id}&quantity=2`,{waitUntil:'networkidle',timeout:65000});
 const notice=page.getByRole('button',{name:'Понятно',exact:true});if(await notice.isVisible())await notice.click();
 await expect(page.locator('[data-contact-form]')).toBeVisible();
 await page.locator('[name=name]').fill('Тест облачной формы');await page.locator('[name=phone]').fill('+7 900 000-00-00');await page.locator('[name=email]').fill('browser-cloud@example.test');
 for(const name of ['privacyConsent','policyConsent','rulesConsent'])await page.locator(`[name=${name}]`).check();
 await page.getByRole('button',{name:'Проверить запись'}).click();await expect(page.locator('[data-booking-review]')).toBeVisible();
 await page.locator('[data-confirm-booking]').click();await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible();
 const uiToken=new URL(page.url()).hash.replace('#token=','');created.push(uiToken);
 await page.reload({waitUntil:'networkidle'});await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible();
 await page.screenshot({path:'docs/screenshots/vercel/booking-mobile.png',fullPage:true});
 await page.locator('[data-open-cancel]').click();await page.locator('[data-confirm-cancel]').click();await expect(page.locator('[data-booking-status=cancelled]')).toBeVisible();
 log('Настоящий Chrome 360 px: форма, обязательные согласия, запись двоих, обновление и отмена');
 await page.setViewportSize({width:1440,height:1000});await page.goto(base,{waitUntil:'networkidle'});await page.evaluate(()=>Promise.all([...document.images].map(image=>{image.loading='eager';return image.decode().catch(()=>{});})));await page.screenshot({path:'docs/screenshots/vercel/home-desktop.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(report.errors,[]);
 writeFileSync('.cache/cloud-check-state.json',JSON.stringify({token:groupInput.managementToken,reference:group.booking.reference,sessionId:session.id,uploadedId:uploaded.id,uploadedSrc:uploaded.src}),{mode:0o600});
 log('Компьютерная версия без переполнения и ошибок JavaScript');report.passed=true;
}finally{
 if(browser)await browser.close();
 if(original){const current=(await good('/api/admin/data')).data.workshops.find(w=>w.id===original.id);await good(`/api/admin/programs/${original.id}`,{method:'PUT',body:{...payload(current),program:payload(original).program,gallery:original.gallery}});}
 for(const s of [session,uiSession].filter(Boolean)){
  const current=(await good('/api/admin/data')).data.sessions.find(item=>item.id===s.id);
  if(current?.status!=='cancelled')await good(`/api/admin/sessions/${s.id}`,{method:'PUT',body:{workshopId:s.workshopId,startsLocal:`${dayKey(s.startsAt)}T10:00`,capacity:s.capacity,bookingOpen:false,cancel:true,version:current.version,confirmed:true,dates:[]}});
 }
 report.finishedAt=new Date().toISOString();writeFileSync('docs/cloud-check.json',JSON.stringify(report,null,2)+'\n');
 await dispatcher.close();
}
