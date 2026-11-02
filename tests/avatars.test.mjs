import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avatarImage } from '../server/avatars.mjs';
import { StarpostStorage } from '../server/storage.mjs';
import { scanOrphanMedia } from '../server/maintenance.mjs';
import { createStarpostServer } from '../server/server.mjs';
import { StarpostWorld } from '../src/world.ts';
import { STARPOST_DEFAULTS } from '../src/config.ts';
import { familyTool } from './tool-invoke.ts';

function png(width=1,height=1) {
  const chunk=(type,data)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4);data.copy(out,8);out.writeUInt32BE(crc32(out.subarray(4,-4)),out.length-4);return out;};
  const head=Buffer.alloc(13);head.writeUInt32BE(width);head.writeUInt32BE(height,4);head[8]=8;head[9]=6;
  return {mime:'image/png',base64:Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',head),chunk('IDAT',deflateSync(Buffer.from([0,50,100,200,255]))),chunk('IEND',Buffer.alloc(0))]).toString('base64')};
}
test('头像拒绝 SVG、伪造格式、坏 CRC、截断文件、过大文件及尺寸',()=>{
  assert.match(avatarImage(png()).version,/^[a-f0-9]{64}$/);
  for(const bad of [null,{mime:'image/svg+xml',base64:Buffer.from('<svg onload="alert(1)"/>').toString('base64')},{...png(),mime:'image/jpeg'},png(513),png(1,513),png(0),{...png(),base64:'!'},{...png(),base64:Buffer.alloc(131073).toString('base64')}])assert.throws(()=>avatarImage(bad),/头像须为/);
  const bytes=Buffer.from(png().base64,'base64');bytes[20]^=1;
  assert.throws(()=>avatarImage({...png(),base64:bytes.toString('base64')}),/头像须为/);
  assert.throws(()=>avatarImage({...png(),base64:bytes.subarray(0,33).toString('base64')}),/头像须为/);
});
test('头像随存储重启保留，有引用时不清理，移除后进入现有垃圾回收',()=>{
  const dir=mkdtempSync(join(tmpdir(),'starpost-avatar-')),dbFile=join(dir,'data.sqlite'),mediaDir=join(dir,'media'),stateDir=join(dir,'state');mkdirSync(stateDir);
  let store=new StarpostStorage({dbFile,mediaDir});
  try {
    store.put('avatars','10001',avatarImage(png()));const stored=store.get('avatars','10001');assert.ok(stored.mediaId);const file=store.mediaPath(stored);
    store.close();store=new StarpostStorage({dbFile,mediaDir});assert.equal(store.hydrate(store.get('avatars','10001')).base64,png().base64);
    const now=Date.now();utimesSync(file,new Date(now-10*86400000),new Date(now-10*86400000));
    assert.equal(scanOrphanMedia({dbFile,mediaDir,stateDir,now}).candidates,0);
    store.remove('avatars','10001');assert.equal(scanOrphanMedia({dbFile,mediaDir,stateDir,now}).candidates,1);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('bot 使用折叠资料工具设置本地头像，不能越目录，图片正文不进入回执',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'starpost-avatar-tool-'));const app=createStarpostServer({file:join(dir,'data.json'),keys:{10001:'a'.repeat(32)},port:0});await app.listen();
  const emoji=join(dir,'emoji');mkdirSync(emoji);writeFileSync(join(emoji,'avatar.png'),Buffer.from(png().base64,'base64'));
  const config={...structuredClone(STARPOST_DEFAULTS),enabled:true,emojiDir:emoji,serverUrl:`http://127.0.0.1:${app.server.address().port}`};
  const world=new StarpostWorld(config,dir,dir,dir,'Asia/Shanghai',()=> '');
  try{
    const panel=world.webUi().invoke;await panel('viewer','register',[]);
    const tool=familyTool(world,'profile');const result=String(await tool.handler({action:'update',avatarFile:'avatar.png'},{}));
    assert.match(result,/avatarVersion/);assert.ok(!result.includes(png().base64));
    const read=await panel('viewer','profileRead',['10002','avatar']);assert.equal(read.image.base64,png().base64);assert.match(read.avatarVersion,/^[a-f0-9]{64}$/);
    const denied=String(await tool.handler({action:'update',avatarFile:'../outside.png'},{}));assert.ok(!denied.includes('avatarVersion'));
    const invalid=String(await tool.handler({action:'read',section:'avatar'},{}));assert.ok(!invalid.includes(png().base64));
    await tool.handler({action:'update',clearAvatar:true},{});assert.equal((await panel('viewer','profileRead',['10002','avatar'])).image,null);
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});
