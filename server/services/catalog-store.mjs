import { flow } from '../db/flow.mjs';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadCatalog, projectRoot} from './catalog.mjs';
export const readMedia = flow(function* readMedia(db) {
  const images = JSON.parse(readFileSync(resolve(projectRoot, 'data/images.json'), 'utf8')).images;
  if (db) for (const row of yield db.prepare('SELECT id,data FROM media_uploads ORDER BY created_at').all()) images[row.id] = JSON.parse(row.data);
  return images;
});
export const initializeCatalog = flow(function* initializeCatalog(db) {
  const catalog = loadCatalog();
  const galleries = JSON.parse(readFileSync(resolve(projectRoot, 'data/galleries.json'), 'utf8'));
  if(db.batch){
    if(yield db.prepare("SELECT value FROM app_metadata WHERE key='catalog_imported'").get())return;
    yield db.batch([...catalog.workshops.map(w=>({sql:'INSERT OR IGNORE INTO workshop_programs (id,slug,data,gallery,updated_at) VALUES (?,?,?,?,?)',args:[w.id,w.slug,JSON.stringify(w),JSON.stringify(galleries[w.id]),new Date().toISOString()]})),
      {sql:"INSERT OR IGNORE INTO app_metadata (key,value) VALUES ('catalog_imported','1')",args:[]}]);
    return;
  }
  yield db.transaction(flow(function* () {
    if (yield db.prepare("SELECT value FROM app_metadata WHERE key='catalog_imported'").get()) return;
    const insert = db.prepare('INSERT OR IGNORE INTO workshop_programs (id,slug,data,gallery,updated_at) VALUES (?,?,?,?,?)');
    for (const w of catalog.workshops) yield insert.run(w.id, w.slug, JSON.stringify(w), JSON.stringify(galleries[w.id]), new Date().toISOString());
    yield db.prepare("INSERT INTO app_metadata (key,value) VALUES ('catalog_imported','1')").run();
  })).immediate();
});
export const storedCatalog = flow(function* storedCatalog(db, {includeArchived = false} = {}) {
  const {site, teachers} = loadCatalog();
  const rows = yield db.prepare(`SELECT * FROM workshop_programs ${includeArchived ? '' : 'WHERE archived=0'} ORDER BY rowid`).all();
  return {
    site,
    teachers,
    workshops: rows.map(row => ({
      ...JSON.parse(row.data),
      archived: Boolean(row.archived),
      version: row.version,
      gallery: JSON.parse(row.gallery)
    }))
  };
});
