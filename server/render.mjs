import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderDocuments } from '../scripts/generate-pages.mjs';
import { storedCatalog, readMedia } from './services/catalog-store.mjs';
import { projectRoot } from './services/catalog.mjs';

export function pageRenderer(db, { development = false, transform = async (_path, html) => html } = {}) {
  let assets = {};
  if (!development) {
    const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'dist/.vite/manifest.json'), 'utf8'));
    const entryKey = Object.keys(manifest).find((key) => manifest[key].name === 'main' && manifest[key].file.endsWith('.js'));
    if (!entryKey) throw new Error('Нет основной точки входа в manifest. Выполните npm run build.');
    const entry = manifest[entryKey]; const styles = new Set(); const visited = new Set();
    function visit(key) { if (visited.has(key)) return; visited.add(key); const item = manifest[key]; for (const css of item.css || []) styles.add(`/${css}`); for (const dependency of item.imports || []) visit(dependency); }
    visit(entryKey); assets = { entryScript: `/${entry.file}`, styles: [...styles] };
  }
  return async (req, res, next) => {
    if (!['GET','HEAD'].includes(req.method) || ['/api','/@','/node_modules/','/src/','/__vite'].some((prefix) => req.path.startsWith(prefix)) || /\.[a-z0-9]+$/i.test(req.path) && !req.path.endsWith('.html')) return next();
    const sourcePath = req.path.endsWith('/index.html') ? req.path.slice(0,-10) : req.path;
    const path = sourcePath === '/404.html' || sourcePath.endsWith('/') ? sourcePath : `${sourcePath}/`;
    const catalog = await storedCatalog(db);
    const document = renderDocuments(catalog, { ...assets, media: await readMedia(db), path })[0];
    if (document && sourcePath !== path) return res.redirect(308, `${path}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
    res.set({ 'Cache-Control': 'no-store', ...(path.startsWith('/admin/') || path.startsWith('/booking/') ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}) });
    const html = document?.html || renderDocuments(catalog, { ...assets, path: '/404.html' })[0].html;
    res.status(document && path !== '/404.html' ? 200 : 404).type('html').send(await transform(path, html));
  };
}
