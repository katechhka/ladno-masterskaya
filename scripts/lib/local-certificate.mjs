import { generateKeyPairSync,randomBytes,sign,X509Certificate } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Только для изолированного TLS-теста. Системное доверие не меняется;
// для публичного сервера этот сертификат не предназначен.
function der(tag,bytes){
  const body=Buffer.isBuffer(bytes)?bytes:Buffer.concat(bytes);let length;
  if(body.length<128)length=Buffer.from([body.length]);
  else{let hex=body.length.toString(16);if(hex.length%2)hex=`0${hex}`;const encoded=Buffer.from(hex,'hex');length=Buffer.concat([Buffer.from([0x80|encoded.length]),encoded]);}
  return Buffer.concat([Buffer.from([tag]),length,body]);
}
const sequence=(...parts)=>der(0x30,parts);
const pem=(name,bytes)=>`-----BEGIN ${name}-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${name}-----\n`;
const utc=date=>der(0x17,Buffer.from(`${date.toISOString().replace(/[-:]/g,'').replace('T','').slice(2,14)}Z`));
export async function localCertificate(directory){
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const algorithm=Buffer.from('300d06092a864886f70d01010b0500','hex'); // sha256WithRSAEncryption
  const name=sequence(der(0x31,[sequence(Buffer.from('0603550403','hex'),der(0x0c,Buffer.from('localhost')))]));
  const serial=randomBytes(16);serial[0]=(serial[0]&0x7f)||1;
  const alternatives=sequence(der(0x82,Buffer.from('localhost')),der(0x87,Buffer.from([127,0,0,1])));
  const extension=sequence(Buffer.from('0603551d11','hex'),der(0x04,alternatives));
  const body=sequence(der(0xa0,der(0x02,Buffer.from([2]))),der(0x02,serial),algorithm,name,
    sequence(utc(new Date(Date.now()-300000)),utc(new Date(Date.now()+2*86400000))),name,
    publicKey.export({type:'spki',format:'der'}),der(0xa3,sequence(extension)));
  const certificate=sequence(body,algorithm,der(0x03,Buffer.concat([Buffer.from([0]),sign('sha256',body,privateKey)])));
  const cert=pem('CERTIFICATE',certificate),key=privateKey.export({type:'pkcs8',format:'pem'});
  const parsed=new X509Certificate(cert);
  if(!parsed.verify(publicKey)||!parsed.checkIP('127.0.0.1'))throw new Error('Не удалось проверить локальный тестовый сертификат.');
  writeFileSync(resolve(directory,'localhost.pem'),cert);writeFileSync(resolve(directory,'localhost-key.pem'),key,{mode:0o600});
  return{cert,key};
}
