import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { openTurso } from '../server/db/turso.mjs';
import { createApp } from '../server/app.mjs';
import { purgeExpiredContacts } from '../server/services/privacy.mjs';
import { cloudRateStore } from '../server/services/cloud-limits.mjs';
import { createTelegramService, telegramClient, telegramConfig } from '../server/services/telegram.mjs';
import { migrate } from '../server/db/database.mjs';
import { initializeCatalog, storedCatalog } from '../server/services/catalog-store.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import { cloudSnapshot } from '../server/services/cloud-backup.mjs';

let ready;
async function initialize() {
  const db=openTurso();
  await db.prepare('SELECT name FROM schema_migrations WHERE name=?').get('006-cloud.sql');
  const {app}=createApp({db,staticFiles:true,production:true,initialized:true,rateStore:namespace=>cloudRateStore(db,namespace)});
  const wrapper=express();
  wrapper.disable('x-powered-by');
  const sameSecret=value=>{
    const expected=Buffer.from(process.env.TELEGRAM_WEBHOOK_SECRET||'');
    const actual=Buffer.from(value||'');
    return expected.length>=32 && actual.length===expected.length && timingSafeEqual(actual,expected);
  };
  wrapper.post('/api/setup',express.json({limit:'1kb'}),async(req,res)=>{
    if(!process.env.CRON_SECRET || req.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`)return res.status(403).end();
    await migrate(db);await initializeCatalog(db);
    const catalog=await storedCatalog(db,{includeArchived:true});
    await seedSchedule(db,catalog.workshops);
    if(!await db.prepare('SELECT id FROM admin_owner WHERE id=1').get()){
      if(!process.env.ADMIN_INITIAL_HASH)return res.status(503).end();
      await db.prepare('INSERT OR IGNORE INTO admin_owner (id,username,password_hash) VALUES (1,?,?)').run('owner',process.env.ADMIN_INITIAL_HASH);
    }
    res.set('Cache-Control','no-store').json({ok:true,programs:catalog.workshops.length});
  });
  wrapper.post('/api/telegram/webhook',express.json({limit:'16kb'}),async(req,res)=>{
    if(!sameSecret(req.get('x-telegram-bot-api-secret-token')))return res.status(403).end();
    const config=telegramConfig();
    if(!config.enabled)return res.status(503).end();
    const update=req.body;
    if(!Number.isSafeInteger(update?.update_id))return res.status(400).end();
    const service=createTelegramService(db,{config});
    const client=telegramClient(config.token,{proxyUrl:''});
    try{await service.handleUpdate(update,body=>client('sendMessage',body));return res.json({ok:true});}
    finally{await client.close();}
  });
  wrapper.get('/api/maintenance',async(req,res)=>{
    if(!process.env.CRON_SECRET || req.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`)return res.status(403).end();
    await purgeExpiredContacts(db);
    await db.prepare('DELETE FROM request_limits WHERE reset_at<?').run(Date.now());
    // A killed function must never claim that an interrupted send was delivered.
    await db.prepare("UPDATE telegram_confirmations SET status='unknown',error_code='INTERRUPTED' WHERE status='sending' AND updated_at<?")
      .run(new Date(Date.now()-10*60000).toISOString());
    res.set('Cache-Control','no-store').json({ok:true});
  });
  wrapper.get('/api/backup',async(req,res)=>{
    if(!process.env.CRON_SECRET || req.get('authorization')!==`Bearer ${process.env.CRON_SECRET}`)return res.status(403).end();
    const snapshot=JSON.stringify(await cloudSnapshot(db));
    if(Buffer.byteLength(snapshot)>3*1024*1024)return res.status(413).json({error:{code:'BACKUP_SIZE',message:'Используйте экспорт базы через Turso Dashboard.'}});
    res.set({'Cache-Control':'no-store','Content-Type':'application/json','X-Content-Type-Options':'nosniff'}).send(snapshot);
  });
  wrapper.use(app);
  wrapper.use((_error,_req,res,_next)=>{if(!res.headersSent)res.status(503).json({error:{code:'SERVER_UNAVAILABLE',message:'Сервис временно недоступен. Повторите запрос.'}});});
  return wrapper;
}
export default async function handler(req,res) {
  try{ready||=initialize().catch(error=>{ready=undefined;throw error;});return (await ready)(req,res);}
  catch{if(!res.headersSent)res.status(503).json({error:{code:'SERVER_UNAVAILABLE',message:'Сервис временно недоступен. Повторите запрос.'}});}
}
