import { readFileSync,mkdirSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createApp } from '../server/app.mjs';
import { openDatabase } from '../server/db/database.mjs';
import { projectRoot } from '../server/services/catalog.mjs';
const legal=JSON.parse(readFileSync(resolve(projectRoot,'data/legal.json'),'utf8'));
const pdfDirectory=resolve(projectRoot,'public/documents');const textDirectory=resolve(projectRoot,'docs/legal');mkdirSync(pdfDirectory,{recursive:true});mkdirSync(textDirectory,{recursive:true});
const db=openDatabase(':memory:');const {app}=createApp({db,staticFiles:true,production:false,limits:false});const server=app.listen(0,'127.0.0.1');await new Promise(done=>server.once('listening',done));
const browser=await chromium.launch({channel:'chrome',headless:true});
try{const page=await browser.newPage();for(const kind of ['privacy','consent','cookies']){
  const document=legal[kind];await page.goto(`http://127.0.0.1:${server.address().port}/${kind}/`,{waitUntil:'networkidle'});await page.evaluate(()=>document.fonts.ready);
  await page.emulateMedia({media:'print'});await page.pdf({path:resolve(pdfDirectory,`${kind}-${legal.version}.pdf`),format:'A4',margin:{top:'18mm',right:'18mm',bottom:'18mm',left:'18mm'},printBackground:false});
  writeFileSync(resolve(textDirectory,`${kind}.md`),`# ${document.title}\n\nРедакция: ${legal.version}\n\n${legal.notice}\n\n${document.intro}\n\n${document.sections.map(s=>`## ${s.title}\n\n${s.paragraphs.join('\n\n')}`).join('\n\n')}\n`);
  console.log(`Готов документ: ${kind}`);
}}finally{await browser.close();await new Promise(done=>server.close(done));db.close();}
