// Keep selected originals up to 10 MB, but send a prepared photograph below
// Vercel Functions' request limit. Server-side decoding and EXIF removal remain.
export async function preparePhoto(file) {
  if(file.size<=3*1024*1024)return file;
  let bitmap;
  try{bitmap=await createImageBitmap(file);}catch{throw new Error('Не удалось прочитать фотографию. Сохраните её в JPEG, PNG или WebP и повторите.');}
  try{
    if(bitmap.width*bitmap.height>40000000)throw new Error('Выберите фотографию до 40 мегапикселей.');
    const scale=Math.min(1,1600/bitmap.width,2000/bitmap.height);
    const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',0.86));
    if(!blob||blob.size>3*1024*1024)throw new Error('Не удалось подготовить фото. Уменьшите его размер и повторите.');
    return blob;
  }finally{bitmap.close();}
}
