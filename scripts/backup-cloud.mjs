import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import Database from 'better-sqlite3';
import {createBackup} from './lib/backups.mjs';
import {uploadFilename} from '../server/services/media.mjs';
import {Agent,ProxyAgent,setGlobalDispatcher} from 'undici';
const dispatcher=process.env.TELEGRAM_PROXY_URL?new ProxyAgent(process.env.TELEGRAM_PROXY_URL):new Agent({connect:{timeout:30000}});setGlobalDispatcher(dispatcher);
let db;
try{
  if(!process.env.CRON_SECRET)throw new Error('Нет секрета резервного копирования.');
  const base=process.env.CLOUD_URL||'https://ladno-masterskaya.vercel.app';
  const response=await fetch(`${base}/api/backup`,{headers:{Authorization:`Bearer ${process.env.CRON_SECRET}`},signal:AbortSignal.timeout(65000)});
  if(!response.ok)throw new Error('Экспорт базы недоступен.');
  const data=await response.json();if(data.format!=='ladno-cloud-snapshot-v1')throw new Error('Формат копии не распознан.');
  const root=resolve('.cache/backups');mkdirSync(root,{recursive:true,mode:0o700});const temp=mkdtempSync(resolve(root,'cloud-'));
  const path=resolve(temp,'snapshot.sqlite'),uploads=resolve(temp,'uploads');mkdirSync(uploads,{mode:0o700});db=new Database(path);
  db.pragma('foreign_keys = OFF');
  db.transaction(()=>{
    for(const item of data.schema.filter(item=>item.type==='table'))db.exec(item.sql);
    for(const table of data.tables){
      if(!/^[a-z_]+$/.test(table.name))throw new Error('Небезопасная таблица.');
      for(const row of table.rows){const columns=Object.keys(row);if(columns.some(name=>!/^[a-z_]+$/.test(name)))throw new Error('Некорректное поле.');
        db.prepare(`INSERT INTO "${table.name}" (${columns.map(name=>`"${name}"`).join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(name=>row[name]));}
    }
    for(const item of data.schema.filter(item=>item.type!=='table'))db.exec(item.sql);
  }).immediate();
  for(const row of db.prepare('SELECT data FROM media_uploads').all()){
    const image=JSON.parse(row.data);
    for(const [name,url]of Object.entries(image.objects||{})){
      if(!uploadFilename.test(name)||!/^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\//.test(url))throw new Error('Небезопасный адрес фото.');
      const photo=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!photo.ok)throw new Error('Фотография недоступна.');
      writeFileSync(resolve(uploads,name),Buffer.from(await photo.arrayBuffer()),{flag:'wx',mode:0o600});
    }
  }
  db.close();db=undefined;
  const result=await createBackup({databasePath:path,uploadsDirectory:uploads,outputDirectory:resolve(process.env.BACKUP_DIR||'storage/backups')});
  console.log(`Облачная копия готова: ${result.directory}. Файлов фото: ${result.images}. Контакты в вывод не включены.`);
  console.log('Промежуточный закрытый снимок находится в .cache/backups; удалите его после проверки по правилам хранения.');
}catch{console.error('Облачная копия не завершена. Проверьте секрет, соединение, место и лимит экспорта 3 МБ. Неполный каталог не используйте.');process.exitCode=1;}
finally{if(db)db.close();await dispatcher.close();}
