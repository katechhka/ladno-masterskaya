import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createApp } from '../server/app.mjs';
import { openDatabase, migrate } from '../server/db/database.mjs';
import { initializeCatalog, storedCatalog } from '../server/services/catalog-store.mjs';
import { passwordHash } from '../server/services/admin-auth.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { createBookingService, publicSessions } from '../server/services/bookings.mjs';
import { projectRoot } from '../server/services/catalog.mjs';
import { dayKey, shiftDay, formatTime } from '../src/scripts/services/dates.js';

const db=openDatabase(':memory:');migrate(db);initializeCatalog(db);const catalog=()=>storedCatalog(db,{includeArchived:true});seedSchedule(db,catalog().workshops);
const password=randomBytes(24).toString('base64url');db.prepare('INSERT INTO admin_owner VALUES (1,?,?)').run('owner',await passwordHash(password));
const session=publicSessions(db).find(s=>new Date(s.startsAt)>new Date());const w=catalog().workshops.find(w=>w.id===session.workshopId);
const token=randomBytes(32).toString('hex');const bookings=createBookingService(db,{catalog});
const existing=bookings.create({sessionId:session.id,quantity:2,expectedUnitPriceRub:w.priceRub,name:'Тестовый участник',phone:'+79000000000',email:'admin-check@example.test',comment:'<img src=x onerror=alert(1)>',privacyConsent: true, policyConsent: true,rulesConsent:true,managementToken:token},randomUUID()).booking;
const {app}=createApp({db,staticFiles:true,production:false,limits:false});const server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));const base=`http://127.0.0.1:${server.address().port}`;
const dir=resolve(projectRoot,'docs/screenshots/stage-9');mkdirSync(dir,{recursive:true});
const report={phase:9,isolatedDatabase:true,realMessagesSent:0,checks:[],screenshots:[],errors:[],passed:false};
const browser=await chromium.launch({channel:'chrome',headless:true});let step='start';
try{
  for(const [label,width,height]of [['desktop',1440,1000],['tablet',768,1024],['mobile',360,800]]){
    const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});const page=await context.newPage();
    page.on('pageerror',error=>report.errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    async function screen(name){await page.evaluate(async()=>{await document.fonts.ready;const images=[...document.images];images.forEach(image=>image.loading='eager');await Promise.all(images.map(image=>image.decode()));});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Переполнение ${label}/${name}`);const file=`${name}-${label}.jpg`;await page.screenshot({path:resolve(dir,file),type:'jpeg',quality:85,fullPage:true});report.screenshots.push(file);}
    async function go(view,edit){await page.goto(`${base}/admin/?view=${view}${edit?`&edit=${edit}`:''}`,{waitUntil:'networkidle'});}
    step=`${label}/login`;await page.goto(`${base}/admin/`,{waitUntil:'networkidle'});await expect(page.locator('[name=password]')).toBeVisible();await screen('login');
    await page.locator('[name=username]').fill('owner');await page.locator('[name=password]').fill(password);await page.getByRole('button',{name:'Войти в мастерскую'}).click();await expect(page.locator('[data-program-id]').first()).toBeVisible();await screen('programs');
    if(label==='desktop'){
      step='price';await go('programs',w.id);await page.locator('[name=priceRub]').fill(String(w.priceRub+500));await screen('program-editor');await page.getByRole('button',{name:'Сохранить программу'}).click();await expect(page.locator('[data-program-id]').first()).toBeVisible();
      const visitor=await context.newPage();await visitor.goto(`${base}/master-classes/${w.slug}/`,{waitUntil:'networkidle'});await expect(visitor.locator('.booking-panel__price')).toContainText(new Intl.NumberFormat('ru').format(w.priceRub+500));
      assert.equal(bookings.get(token).totalRub,w.priceRub*2);await visitor.close();report.checks.push('Цена на публичной странице обновляется без сборки; старая бронь сохраняет сумму');
      step='new-program';await go('programs','new');
      const values={title:'Акварельный вечер',slug:'akvarelnyy-vecher',summary:'Пробуем акварель и создаём небольшой пейзаж.',process:'Разберём цвет и воду.\nСделаем первые заливки.\nДобавим детали и подпишем работу.',result:'Акварельный пейзаж на бумаге.',materials:'Бумага\nАкварель\nКисти\nПалитра',preparation:'Одежда, которую не жалко испачкать.',pickup:'Работу можно забрать после высыхания в тот же день.'};
      for(const [key,value]of Object.entries(values))await page.locator(`[name=${key}]`).fill(value);
      await page.locator('[name=relatedIds]').selectOption(catalog().workshops.slice(0,2).map(w=>w.id));
      const gallery=page.locator('[name=gallery]');await gallery.nth(0).check();await gallery.nth(1).check();
      await page.getByRole('button',{name:'Сохранить программу'}).click();await expect(page.getByRole('heading',{name:'Акварельный вечер',exact:true})).toBeVisible();
      const added=catalog().workshops.find(w=>w.slug==='akvarelnyy-vecher');assert.ok(added);assert.equal((await fetch(`${base}/master-classes/akvarelnyy-vecher/`)).status,200);
      await go('programs',added.id);await page.locator('[name=archived]').check();await page.getByRole('button',{name:'Сохранить программу'}).click();await expect(page.locator('[data-program-id]').first()).toBeVisible();assert.equal((await fetch(`${base}/master-classes/akvarelnyy-vecher/`)).status,404);report.checks.push('Создание программы, выбор галереи и архивация через интерфейс');
      step='repeat';await go('sessions','new');const day=shiftDay(dayKey(),50);await page.locator('[name=workshopId]').selectOption(w.id);await page.locator('[name=startsLocal]').fill(`${day}T10:00`);await page.getByText('Повторить в другие дни',{exact:true}).click();await page.locator('[name=repeatUntil]').fill(shiftDay(day,7));for(let n=0;n<7;n++)await page.locator(`[name=weekday${n}]`).check();await expect(page.locator('[data-repeat-preview]')).toContainText('Будет создано 8:');await screen('repeat-preview');await page.getByRole('button',{name:'Сохранить расписание'}).click();await expect(page.getByRole('heading',{name:'Расписание',exact:true})).toBeVisible();assert.equal(publicSessions(db).filter(s=>dayKey(s.startsAt)>=day).length,8);report.checks.push('Предпросмотр и создание восьми повторяющихся сеансов');
      step='move';await go('sessions',session.id);const moved=`${dayKey(session.startsAt)}T08:00`;await page.locator('[name=startsLocal]').fill(moved);await page.getByRole('button',{name:'Сохранить расписание'}).click();await expect(page.getByRole('heading',{name:'Расписание',exact:true})).toBeVisible();assert.equal(formatTime(bookings.get(token).session.startsAt),'08:00');
      await go('bookings');await expect(page.locator('.admin__booking')).toBeVisible();await expect(page.locator('.admin__booking')).toContainText('Нужно сообщить');assert.equal(await page.locator('.admin__booking img').count(),0);await screen('bookings-notify');await page.getByRole('button',{name:'Участнику сообщили'}).click();await expect(page.locator('.admin__booking .notice')).toHaveCount(0);
      await go('sessions',session.id);await page.locator('[name=cancel]').check();await page.getByRole('button',{name:'Сохранить расписание'}).click();await expect(page.getByRole('heading',{name:'Расписание',exact:true})).toBeVisible();assert.equal(bookings.get(token).status,'cancelled');assert.equal(publicSessions(db).find(s=>s.id===session.id).available,session.capacity);report.checks.push('Перенос и отмена с подтверждением; список участников и отметка о личном уведомлении');
    }
    await go('programs',w.id);await screen('editor-responsive');await go('sessions');await screen('sessions');await go('bookings');await expect(page.locator('.admin__booking')).toBeVisible();await screen('bookings');
    step=`${label}/logout`;await page.getByRole('button',{name:'Выйти',exact:true}).click();await expect(page.locator('[name=password]')).toBeVisible();await page.goto(`${base}/admin/?view=bookings`,{waitUntil:'networkidle'});await expect(page.locator('[name=password]')).toBeVisible();assert.equal(await page.locator('.admin__booking').count(),0);
    report.checks.push(`${width}px: вход, формы, программы, расписание, контакты, выход и закрытый доступ`);await context.close();console.log(`OK: ${label} — админка и адаптивность`);
  }
  assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.failure={step,message:error.message.replace(/[a-f0-9]{64}/g,'[token]')};throw error;}
finally{await browser.close();await new Promise(done=>server.close(done));db.close();writeFileSync(resolve(projectRoot,'docs/admin-check.json'),`${JSON.stringify(report,null,2)}\n`);}
