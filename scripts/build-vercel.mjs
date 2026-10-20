import { build } from 'vite';
import { openDatabase, migrate } from '../server/db/database.mjs';
import { initializeCatalog, storedCatalog } from '../server/services/catalog-store.mjs';
import { seedSchedule } from '../server/services/schedule-seed.mjs';
import {readdirSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
// Build-time data is disposable. Runtime data always comes from Turso.
process.env.DATABASE_PATH='.cache/vercel-build.sqlite';
process.env.PUBLIC_ORIGIN ||= process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
const db=openDatabase();
try{migrate(db);initializeCatalog(db);seedSchedule(db,storedCatalog(db).workshops);}finally{db.close();}
await build();
// HTML is rendered from the live database. Leave only the fallback 404 file;
// static index pages must not bypass runtime program/price edits.
const output=resolve('dist');
function removeStaticPages(directory){for(const entry of readdirSync(directory,{withFileTypes:true})){const path=resolve(directory,entry.name);if(entry.isDirectory())removeStaticPages(path);else if(entry.name.endsWith('.html')&&path!==resolve(output,'404.html'))unlinkSync(path);}}
removeStaticPages(output);
