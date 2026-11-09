import { defineConfig, loadEnv } from 'vite';
import { resolve, relative } from 'node:path';
import { generatePages } from './scripts/generate-pages.mjs';
import { readFileSync } from 'node:fs';
import { createApp } from './server/app.mjs';
import { pageRenderer } from './server/render.mjs';

let knownPages = new Set();
function notFoundMiddleware() {
  return (request, response, next) => {
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;
    if (knownPages.has(pathname) && pathname !== '/' && !pathname.endsWith('/') && !pathname.endsWith('.html')) {
      response.statusCode = 308;
      response.setHeader('Location', `${pathname}/${url.search}`);
      response.end();
      return;
    }
    if (knownPages.has(pathname) || pathname.startsWith('/@') || pathname.startsWith('/api/') || pathname.startsWith('/node_modules/') || pathname.startsWith('/src/')) return next();
    const lastPart = pathname.split('/').at(-1);
    if (lastPart.includes('.') && !pathname.endsWith('.html')) return next();
    response.statusCode = 404;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(readFileSync(resolve('.generated/404.html'), 'utf8'));
  };
}

export default defineConfig({
  base: process.env.PAGES_BASE || '/',
  root: '.generated',
  appType: 'mpa',
  publicDir: '../public',
  plugins: [{
    name: 'pages-demo-paths',
    enforce: 'pre',
    transform(code, id) {
      if (!process.env.PAGES_BASE || !id.includes('/src/scripts/') || !id.endsWith('.js')) return;
      return code.replace(/(['"`])\/(?=(?:master-classes|schedule|booking|media|privacy|consent|rules|cookies)\/)/g, `$1${process.env.PAGES_BASE}`);
    }
  }, {
    name: 'ladno-pages',
    config(_config, { mode }) {
      const environment = loadEnv(mode, resolve('.'), '');
      for (const name of ['DATABASE_PATH', 'UPLOADS_DIR', 'PUBLIC_ORIGIN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME']) {
        if (!process.env[name] && environment[name]) process.env[name] = environment[name];
      }
      const pages = generatePages();
      knownPages = new Set(pages.flatMap((file) => {
        const path = `/${relative(resolve('.generated'), file).replaceAll('\\', '/')}`;
        return path.endsWith('/index.html') ? [path, path.slice(0, -10), path.slice(0, -11) || '/'] : [path];
      }));
      return { build: { rollupOptions: { input: pages } } };
    },
    configureServer(server) {
      const api = createApp();
      server.middlewares.use(api.app);
      server.middlewares.use(pageRenderer(api.db, { development: true, transform: (path, html) => server.transformIndexHtml(path, html) }));
      server.httpServer?.once('close', () => api.db.close());
      const sourceRoots = ['data', 'src/pages', 'src/partials'].map((directory) => `${resolve(directory).replaceAll('\\', '/').toLowerCase()}/`);
      server.watcher.add(sourceRoots);
      server.watcher.on('change', (path) => {
        const normalized = path.replaceAll('\\', '/').toLowerCase();
        // Публичные JSON — результат генерации. Их нельзя считать исходными данными.
        if (sourceRoots.some((directory) => normalized.startsWith(directory))) {
          generatePages();
          server.ws.send({ type: 'full-reload' });
        }
      });
      return () => server.middlewares.use(notFoundMiddleware());
    },
    configurePreviewServer(server) {
      const api = createApp();
      server.middlewares.use(api.app);
      server.middlewares.use(pageRenderer(api.db));
      server.httpServer?.once('close', () => api.db.close());
      return () => server.middlewares.use(notFoundMiddleware());
    }
  }],
  resolve: { alias: { '@': resolve('src') } },
  build: { outDir: '../dist', emptyOutDir: true, manifest: true },
  server: { fs: { allow: [resolve('.')] }, port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true }
});
