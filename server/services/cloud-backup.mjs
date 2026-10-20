export async function cloudSnapshot(db){
  return db.snapshot(async()=>{
    const schema=await db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables=[];
    for(const item of schema.filter(item=>item.type==='table')){
      if(!/^[a-z_]+$/.test(item.name))throw new Error('Некорректное имя таблицы');
      tables.push({name:item.name,rows:['admin_sessions','request_limits'].includes(item.name)?[]:await db.prepare(`SELECT * FROM "${item.name}"`).all()});
    }
    return {format:'ladno-cloud-snapshot-v1',createdAt:new Date().toISOString(),schema,tables};
  });
}
