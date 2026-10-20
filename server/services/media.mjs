import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from './catalog.mjs';
import { BookingError } from './bookings.mjs';
import { flow } from '../db/flow.mjs';

export const uploadDirectory = () => resolve(projectRoot, process.env.UPLOADS_DIR || 'storage/uploads');
export const uploadFilename = /^upload-[a-f0-9-]{36}-(480|800|1200)\.(webp|avif)$/;
export async function savePhoto(db, buffer, alt, { directory = uploadDirectory() } = {}) {
  const {put,del}=db.remote ? await import('@vercel/blob') : {};
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 10 * 1024 * 1024) throw new BookingError(422,'IMAGE_SIZE','Выберите фотографию размером до 10 МБ.');
  if (typeof alt !== 'string' || alt.trim().length < 8 || alt.trim().length > 250) throw new BookingError(422,'IMAGE_ALT','Опишите фотографию: от 8 до 250 символов.');
  const magic = buffer.subarray(0,12);
  const supported = magic.subarray(0,3).equals(Buffer.from([255,216,255])) || magic.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || magic.subarray(0,4).toString()==='RIFF' && magic.subarray(8,12).toString()==='WEBP';
  if(!supported)throw new BookingError(422,'IMAGE_INVALID','Файл не является фотографией JPEG, PNG или WebP.');
  if ((await db.prepare('SELECT COUNT(*) AS n FROM media_uploads').get()).n >= 500) throw new BookingError(409,'MEDIA_LIMIT','В медиатеке уже 500 загруженных фотографий. Обратитесь к разработчику для расширения хранилища.');
  let source;
  try {
    const image = sharp(buffer,{limitInputPixels:40000000,failOn:'warning'});const metadata=await image.metadata();
    if (!['jpeg','png','webp'].includes(metadata.format) || (metadata.pages || 1)>1) throw new Error('FORMAT');
    source=await image.rotate().resize({width:1600,height:2000,fit:'inside',withoutEnlargement:true}).webp({quality:86}).toBuffer();
    const clean=await sharp(source).metadata();if(clean.width<480||clean.height<320)throw new Error('SMALL');
  } catch { throw new BookingError(422,'IMAGE_INVALID','Не удалось прочитать фото. Нужен обычный JPEG, PNG или WebP, минимум 480 × 320 пикселей, до 40 мегапикселей. Анимация и SVG не поддерживаются.'); }
  const id=`upload-${randomUUID()}`;const written=[];const variants=[];
  const objects={};
  if(!db.remote) await mkdir(directory,{recursive:true});
  try {
    for (const width of [480,800,1200]) {
      const resized=sharp(source).resize({width,withoutEnlargement:true});
      const webp=await resized.clone().webp({quality:82}).toBuffer({resolveWithObject:true});
      const avif=await resized.clone().avif({quality:48,effort:3}).toBuffer();
      const webpName=`${id}-${width}.webp`,avifName=`${id}-${width}.avif`;
      for (const [name,bytes] of [[webpName,webp.data],[avifName,avif]]) {
        if(db.remote){const blob=await put(`photos/${name}`,bytes,{access:'public',addRandomSuffix:false,allowOverwrite:false,contentType:name.endsWith('.avif')?'image/avif':'image/webp'});objects[name]=blob.url;written.push(blob.url);}
        else{const path=resolve(directory,name);await writeFile(path,bytes,{flag:'wx'});written.push(path);}
      }
      variants.push({width:webp.info.width,height:webp.info.height,webp:`/media/${webpName}`,avif:`/media/${avifName}`});
    }
    const largest=variants.at(-1);const distinct=[...new Map(variants.map(v=>[v.width,v])).values()];
    const data={id,alt:alt.trim(),width:largest.width,height:largest.height,focalPoint:'50% 50%',src:largest.webp,
      webpSrcset:distinct.map(v=>`${v.webp} ${v.width}w`).join(', '),avifSrcset:distinct.map(v=>`${v.avif} ${v.width}w`).join(', '),variants,uploaded:true,...(db.remote?{objects}: {})};
    await db.transaction(flow(function*(){
      if((yield db.prepare('SELECT COUNT(*) AS n FROM media_uploads').get()).n>=500)throw new BookingError(409,'MEDIA_LIMIT','Достигнут предел медиатеки: 500 фотографий.');
      yield db.prepare('INSERT INTO media_uploads (id,data,created_at) VALUES (?,?,?)').run(id,JSON.stringify(data),new Date().toISOString());
    })).immediate();
    return data;
  } catch (error) {await Promise.all(written.map(path=>db.remote?del(path).catch(()=>{}):unlink(path).catch(()=>{})));throw error;}
}
