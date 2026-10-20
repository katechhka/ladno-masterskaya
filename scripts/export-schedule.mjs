import { exportPublicData } from '../server/services/public-data.mjs';
const result = exportPublicData();
console.log(`Публичный снимок: ${result.programs} программ, ${result.sessions} сеанса. Контактные данные не включены.`);
