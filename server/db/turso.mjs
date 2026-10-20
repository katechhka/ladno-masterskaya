import { AsyncLocalStorage } from 'node:async_hooks';
import { createClient } from '@libsql/client';

export function openTurso({ url = process.env.TURSO_DATABASE_URL, authToken = process.env.TURSO_AUTH_TOKEN } = {}) {
  if (!url || !authToken) throw new Error('Настройки облачной базы отсутствуют.');
  const connection = createClient({ url, authToken, intMode:'number' });
  const scope = new AsyncLocalStorage();
  const current = () => scope.getStore() || connection;
  const db = {
    remote: true,
    prepare(sql) {
      return Object.fromEntries(['get', 'all', 'run'].map(method => [method, async (...args) => {
        const result=await current().execute({sql,args:args.length===1 && args[0] && typeof args[0]==='object' && !Array.isArray(args[0]) ? args[0] : args});
        if(method==='run')return {changes:result.rowsAffected,lastInsertRowid:Number(result.lastInsertRowid||0)};
        const rows=result.rows.map(row=>Object.fromEntries(result.columns.map(name=>[name,row[name]])));
        return method==='get'?rows[0]:rows;
      }]));
    },
    exec: sql => current().executeMultiple(sql),
    batch: statements => scope.getStore() ? current().batch(statements) : connection.batch(statements,'write'),
    pragma: async sql => (await current().execute(`PRAGMA ${sql}`)).rows,
    transaction(operation) {
      const invoke = async (...args) => {
        if (scope.getStore()) return operation(...args);
        const transaction = await connection.transaction('write');
        try {
          const result=await scope.run(transaction, () => operation(...args));
          await transaction.commit();
          return result;
        } catch(error) {await transaction.rollback().catch(()=>{});throw error;}
        finally {transaction.close();}
      };
      invoke.immediate = invoke;
      return invoke;
    },
    async snapshot(operation) {
      const transaction=await connection.transaction('read');
      try{const result=await scope.run(transaction,operation);await transaction.commit();return result;}
      catch(error){await transaction.rollback().catch(()=>{});throw error;}
      finally{transaction.close();}
    },
    close: () => connection.close()
  };
  return db;
}
