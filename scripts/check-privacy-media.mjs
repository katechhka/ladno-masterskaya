import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { resolve,relative,isAbsolute } from 'node:path';
import { chromium,expect } from '@playwright/test';
import { createApp } from '../server/app.mjs';
import { openDatabase,migrate } from '../server/db/database.mjs';
import { initializeCatalog,storedCatalog,readMedia } from '../server/services/catalog-store.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { publicSessions } from '../server/services/bookings.mjs';
import { passwordHash } from '../server/services/admin-auth.mjs';
import { projectRoot } from '../server/services/catalog.mjs';

const root=resolve(projectRoot,'.cache/tests');mkdirSync(root,{recursive:true});const directory=mkdtempSync(resolve(root,'privacy-media-'));const filename=resolve(directory,'test.sqlite');
const previous=process.env.UPLOADS_DIR;process.env.UPLOADS_DIR=resolve(directory,'uploads');
const db=openDatabase(filename);migrate(db);initializeCatalog(db);const catalog=storedCatalog(db);seedSchedule(db,catalog.workshops);const session=publicSessions(db).find(s=>new Date(s.startsAt)>new Date());
const password=randomBytes(24).toString('base64url');db.prepare('INSERT INTO admin_owner VALUES (1,?,?)').run('owner',await passwordHash(password));
const {app}=createApp({db,staticFiles:true,production:false,limits:false});const server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));const base=`http://127.0.0.1:${server.address().port}`;
const screenshots=resolve(projectRoot,'docs/screenshots/privacy-media');mkdirSync(screenshots,{recursive:true});
const report={checks:[],errors:[],isolatedDatabase:true,realMessagesSent:0,passed:false};const browser=await chromium.launch({channel:'chrome',headless:true});let step='start';
const ok=(text)=>{report.checks.push(text);console.log(`OK: ${text}`);};
try{
  for(const [label,width,height]of [['desktop',1440,1000],['mobile',360,800]]){
    const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
    async function screen(name,locator){await page.evaluate(()=>document.fonts.ready);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const options={path:resolve(screenshots,`${name}-${label}.jpg`),type:'jpeg',quality:88};if(locator)await page.locator(locator).screenshot(options);else await page.screenshot(options);}
    step=`${label}/cookie`;await page.goto(base,{waitUntil:'networkidle'});await expect(page.locator('[data-cookie-notice]')).toBeVisible();await screen('cookie');
    await page.locator('[data-cookie-dismiss]').click();await expect(page.locator('[data-cookie-notice]')).toBeHidden();assert.ok((await context.cookies()).some(cookie=>cookie.name==='ladno_cookie_notice'&&cookie.expires>Date.now()/1000+170*86400));
    await page.reload({waitUntil:'networkidle'});await expect(page.locator('[data-cookie-notice]')).toBeHidden();await page.locator('[data-cookie-open]').click();await expect(page.locator('[data-cookie-notice]')).toBeVisible();await page.locator('[data-cookie-dismiss]').click();await expect(page.locator('[data-cookie-open]')).toBeFocused();ok(`${width}px: cookie появляется, закрывается, запоминается и повторно открывается`);
    for(const kind of ['privacy','consent','cookies']){await page.goto(`${base}/${kind}/`,{waitUntil:'networkidle'});await expect(page.locator('.info-document')).toBeVisible();assert.ok(await page.locator('h1').innerText());await screen(kind);}
    step=`${label}/consents`;let posts=0;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/bookings')posts++;});
    await page.goto(`${base}/booking/?session=${session.id}&quantity=1`,{waitUntil:'networkidle'});await expect(page.locator('[name=policyConsent]')).toBeVisible();
    await page.locator('[name=name]').fill('Тестовый гость');await page.locator('[name=phone]').fill('89000000000');await page.locator('[name=email]').fill('privacy-browser@example.test');
    const keys=['policyConsent','privacyConsent','rulesConsent'];for(const key of keys){assert.equal(await page.locator(`[name=${key}]`).isChecked(),false);await page.locator(`[name=${key}]`).check();}
    for(const key of keys){await page.locator(`[name=${key}]`).uncheck();await page.getByRole('button',{name:'Проверить запись'}).click();await expect(page.locator(`[data-error=${key}]`)).not.toBeEmpty();assert.equal(await page.locator('[data-booking-review]').count(),0);assert.equal(posts,0);await page.locator(`[name=${key}]`).check();}
    await expect(page.locator('[name=policyConsent]').locator('..').getByRole('link')).toHaveAttribute('href','/privacy/');await expect(page.locator('[name=privacyConsent]').locator('..').getByRole('link')).toHaveAttribute('href','/consent/');
    await screen('consents');await page.getByRole('button',{name:'Проверить запись'}).click();await page.locator('[data-confirm-booking]').click();await expect(page.locator('[data-booking-status=confirmed]')).toBeVisible();assert.equal(posts,1);
    await page.locator('[data-open-withdraw]').click();await expect(page.locator('[data-withdraw-confirmation]')).toBeVisible();await page.locator('[data-confirm-withdraw]').click();await expect(page.locator('[data-booking-status=cancelled]')).toBeVisible();await expect(page.locator('[data-booking-preview]')).not.toContainText('privacy-browser@example.test');await page.reload({waitUntil:'networkidle'});await expect(page.locator('[data-open-withdraw]')).toHaveCount(0);assert.equal(publicSessions(db).find(s=>s.id===session.id).available,session.capacity);ok(`${width}px: без каждой галочки нет запроса; с тремя есть бронь; отзыв удаляет контакты и освобождает место`);
    if(label==='desktop'){
      step='upload';await page.goto(`${base}/admin/?view=programs&edit=new`,{waitUntil:'networkidle'});await page.locator('[name=username]').fill('owner');await page.locator('[name=password]').fill(password);await page.getByRole('button',{name:'Войти в мастерскую'}).click();await expect(page.locator('[data-program-form]')).toBeVisible();
      const w=catalog.workshops.find(w=>w.category==='ceramics');const values={title:'Чаша с собственным характером',slug:'uploaded-clay-bowl',category:w.category,teacherId:w.teacherId,summary:w.summary,process:w.process.join('\n'),result:w.result,materials:w.materials.join('\n'),preparation:w.preparation,pickup:w.pickup};
      for(const [key,value]of Object.entries(values)){const field=page.locator(`[name=${key}]`);if(['category','teacherId'].includes(key))await field.selectOption(value);else await field.fill(value);}
      await page.locator('[name=relatedIds]').selectOption(catalog.workshops.slice(0,2).map(w=>w.id));
      await page.locator('[name=photos]').setInputFiles([resolve(projectRoot,'src/assets/images/originals/hero.png'),resolve(projectRoot,'src/assets/images/originals/process-together.png')]);
      await page.locator('[data-photo-alt]').nth(0).fill('Руки создают глиняную чашу за столом');await page.locator('[data-photo-alt]').nth(1).fill('Участники работают за общим столом мастерской');
      await screen('upload-preview','.admin-upload');await page.getByRole('button',{name:'Загрузить фотографии',exact:true}).click();await expect(page.locator('[data-upload-status]')).toContainText('Загружено: 2',{timeout:60000});
      await page.getByRole('button',{name:'Сохранить программу'}).click();await expect(page.getByRole('heading',{name:'Чаша с собственным характером',exact:true})).toBeVisible();
      await page.goto(`${base}/master-classes/uploaded-clay-bowl/`,{waitUntil:'networkidle'});await expect(page.locator('.gallery__picture img').first()).toBeVisible();await page.locator('.gallery__picture img').first().evaluate(img=>img.decode());assert.ok((await page.locator('.gallery__picture img').first().getAttribute('src')).includes('/media/upload-'));assert.equal(await page.locator('[data-gallery-slide]').count(),2);await screen('uploaded-gallery','.gallery');
      assert.equal(Object.values(readMedia(db)).filter(image=>image.uploaded).length,2);ok('Новая программа: свои две фотографии загружены, выбраны обложкой/галереей и доступны посетителю без сборки');
    }
    await context.close();
  }
  assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.failure={step,message:error.message.replace(/[a-f0-9]{64}/g,'[token]')};throw error;}
finally{
  await browser.close();await new Promise(done=>server.close(done));db.close();
  if(report.passed){const connection=openDatabase(filename);try{assert.equal(connection.prepare('SELECT COUNT(*) AS n FROM media_uploads').get().n,2);}finally{connection.close();}}
  writeFileSync(resolve(projectRoot,'docs/privacy-media-check.json'),`${JSON.stringify(report,null,2)}\n`);if(previous===undefined)delete process.env.UPLOADS_DIR;else process.env.UPLOADS_DIR=previous;
  const inside=relative(root,directory);assert.ok(inside&&!inside.startsWith('..')&&!isAbsolute(inside));rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:50});
}
