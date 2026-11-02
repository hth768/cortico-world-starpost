import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
export function avatarImage(value) {
  const invalid = () => { const e = new Error('头像须为 PNG/JPEG，最大 128 KiB，宽高不超过 512 像素'); e.status=400; throw e; };
  if(!value || !['image/png','image/jpeg'].includes(value.mime) || typeof value.base64!=='string' || value.base64.length>174764 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64))invalid();
  const b=Buffer.from(value.base64,'base64');let width=0,height=0;
  if(b.length>131072)invalid();
  if(value.mime==='image/png') {
    if(b.length<33 || b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a' || b.readUInt32BE(8)!==13 || b.toString('ascii',12,16)!=='IHDR')invalid();
    width=b.readUInt32BE(16);height=b.readUInt32BE(20);
    let end=false, data=false;
    for(let i=8;i<b.length;){
      if(i+12>b.length)invalid();
      const size=b.readUInt32BE(i), type=b.toString('ascii',i+4,i+8);
      if(size>b.length-i-12 || crc32(b.subarray(i+4,i+8+size))!==b.readUInt32BE(i+8+size))invalid();
      if(type==='acTL'||type==='fcTL'||type==='fdAT')invalid(); // Avatars are static.
      if(type==='IDAT'&&size>0)data=true;
      i+=size+12;
      if(type==='IEND'){if(size!==0||i!==b.length)invalid();end=true;break;}
    }
    if(!end||!data)invalid();
  } else {
    if(b.length<4 || b[0]!==255 || b[1]!==216 || b[b.length-2]!==255 || b[b.length-1]!==217)invalid();
    for(let i=2;i+3<b.length;) {
      if(b[i++]!==255)invalid();while(b[i]===255)i++;
      const marker=b[i++];if(marker===218||marker===217)break;
      if(marker===1 || marker>=208&&marker<=215)continue;
      if(i+2>b.length)invalid();const n=b.readUInt16BE(i);if(n<2||i+n>b.length)invalid();
      if([192,193,194].includes(marker)){if(n<8)invalid();height=b.readUInt16BE(i+3);width=b.readUInt16BE(i+5);break;}i+=n;
    }
  }
  if(width<1||height<1||width>512||height>512)invalid();
  return {mime:value.mime,base64:b.toString('base64'),version:createHash('sha256').update(b).digest('hex')};
}
