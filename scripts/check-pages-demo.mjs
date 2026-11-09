import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import express from 'express';
import { chromium } from '@playwright/test';

const base = '/ladno-masterskaya/';
const output = resolve('dist');
let pages = 0;
function inspect(dir) {
  for (const item of readdirSync(dir, {withFileTypes:true})) {
    const file=join(dir,item.name);
    if(item.isDirectory()) {inspect(file);continue;}
    if(!file.endsWith('.html'))continue;
    pages++;
    const html=readFileSync(file,'utf8');
    assert.ok(html.includes('Демо для портфолио'));
    for(const match of html.matchAll(/(?:href|src)="(\/[^"?#]*)/g)) {
      assert.ok(match[1].startsWith(base), `Outside base: ${match[1]}`);
      const local=join(output,match[1].slice(base.length));
      assert.ok(existsSync(local),`Missing link: ${match[1]}`);
    }
  }
}
inspect(output);
assert.ok(!existsSync(join(output,'admin/index.html')));
assert.ok(!existsSync(join(output,'booking/manage/index.html')));
const app=express();app.use(base,express.static(output));
app.use((_req,res)=>res.status(404).sendFile(join(output,'404.html')));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'chrome',headless:true});
  const page=await browser.newPage();const errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.method()!=='GET'||r.url().includes('/api/')||!r.url().startsWith(origin))requests.push(r.url());});
  const sessions=JSON.parse(readFileSync(join(output,'data/schedule.json'),'utf8')).sessions;
  const session=sessions.find(s=>s.status==='scheduled'&&s.available>=2&&new Date(s.startsAt)>new Date());
  assert.ok(session,'No future demo session');
  mkdirSync('.cache/pages-screenshots',{recursive:true});
  for(const width of [1440,768,360]) {
    await page.setViewportSize({width,height:900});
    for(const route of ['', 'master-classes/', 'schedule/', `booking/?session=${session.id}&quantity=2`]) {
      const response=await page.goto(origin+base+route);assert.equal(response.status(),200);
      await page.waitForFunction(()=>document.documentElement.dataset.js==='ready');
      if(route==='')await page.locator('.upcoming-session').first().waitFor();
      if(route.startsWith('booking/'))await page.locator('[name=phone]').waitFor();
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${route} overflow`);
      assert.equal(await page.locator('img').evaluateAll(imgs=>imgs.filter(i=>i.complete&&i.naturalWidth===0).length),0);
    }
    await page.screenshot({path:`.cache/pages-screenshots/booking-${width}.png`,fullPage:true});
  }
  await page.locator('[type=submit]').click();
  assert.ok(await page.locator('[aria-invalid=true]').count()>0);
  await page.locator('[name=name]').fill('Тестовый участник');
  await page.locator('[name=phone]').fill('+79000000000');
  await page.locator('[name=email]').fill('demo@example.test');
  for(const name of ['policyConsent','privacyConsent','rulesConsent'])await page.locator(`[name=${name}]`).check();
  await page.locator('[type=submit]').click();
  await page.locator('[data-confirm-booking]').click();
  await page.getByRole('heading',{name:'Демонстрация завершена'}).waitFor();
  assert.ok((await page.locator('main').innerText()).includes('Бронь не создана'));
  assert.deepEqual(requests,[],'Unexpected network or API requests');assert.deepEqual(errors,[]);
  await page.goto(origin+base+'master-classes/?category=ceramics');
  await page.waitForFunction(()=>document.documentElement.dataset.js==='ready');
  assert.equal(await page.locator('[data-catalog-card]:visible').count(),3);
  await page.locator('[name=q]').fill('zzzzzzzz');
  await page.locator('[data-catalog-empty]').waitFor({state:'visible'});
  await page.goto(origin+base+'master-classes/pervyy-krug/');
  await page.locator('[data-session-picker], [data-workshop-sessions]').count();
  assert.equal((await page.goto(origin+base+'missing/')).status(),404);
  console.log(JSON.stringify({passed:true,htmlPages:pages,widths:[1440,768,360],apiRequests:requests.length,errors}));
} finally {await browser?.close();await new Promise(r=>server.close(r));}
