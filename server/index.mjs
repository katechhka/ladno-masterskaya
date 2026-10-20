import { createApp } from './app.mjs';
import { purgeExpiredContacts } from './services/privacy.mjs';
const { app, db } = createApp({ staticFiles: true });
const server = app.listen(Number(process.env.PORT || 3000), process.env.HOST || '127.0.0.1', () => {
  console.log(`Ладно: http://${process.env.HOST || '127.0.0.1'}:${server.address().port}`);
});
const privacyCleanup = setInterval(() => {try{purgeExpiredContacts(db);}catch{console.error('Плановая очистка контактов не выполнена. Проверьте доступность базы.');}},24*3600000);privacyCleanup.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {clearInterval(privacyCleanup);server.close(() => { db.close(); process.exit(0); });});
