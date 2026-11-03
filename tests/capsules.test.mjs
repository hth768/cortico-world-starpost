import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStarpostServer } from '../server/server.mjs';
import { capsuleTime } from '../server/capsules.mjs';
import { scanOrphanMedia } from '../server/maintenance.mjs';
import { backupStarpost } from '../server/backup.mjs';
import { StarpostStorage } from '../server/storage.mjs';

const png = { mime:'image/png', base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNIOfHsPwAGuAMSOUNQWgAAAABJRU5ErkJggg==' };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-capsules-')), keys = {10001:'a'.repeat(32),10002:'b'.repeat(32)}, mails=[];
  let now=Date.parse('2026-11-03T10:00:00+08:00');
  const make=()=>createStarpostServer({ file:join(dir,'state.json'),keys,port:0,clock:()=>now,sendMail:async mail=>mails.push(mail) });
  let app=make();await app.listen();
  const post=async(path,body,headers={})=>{
    const base=`http://127.0.0.1:${app.server.address().port}`;
    const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin:base,...headers},body:JSON.stringify(body)});
    return {status:r.status,headers:r.headers,...await r.json()};
  };
  const rpc=(who,action,args={})=>post('/rpc',{action,args},{'x-starpost-id':who,authorization:`Bearer ${keys[who]}`});
  const ok=async pending=>{const r=await pending;assert.equal(r.ok,true,r.error);return r.result};
  const human=async(who,transport='mobile')=>{
    const login=await post(`/${transport}/login`,{botId:who,credential:keys[who]});const v=await ok(login);
    const headers=transport==='web'?{cookie:login.headers.get('set-cookie').split(';')[0]}:{authorization:`Bearer ${v.accessToken}`};
    return (action,args={})=>post(`/${transport}/rpc`,{action,args},headers);
  };
  const register=async()=>{
    const email='capsules@example.com',v=await ok(post('/mobile/auth',{action:'code',purpose:'register',email}));
    const account=await ok(post('/mobile/auth',{action:'register',email,nickname:'胶囊测试',password:'local-example-123',challengeId:v.challengeId,code:mails.at(-1).code}));
    return {account,call:(action,args={})=>post('/mobile/rpc',{action,args},{authorization:`Bearer ${account.accessToken}`})};
  };
  return {dir,rpc,post,ok,human,register,get app(){return app},get now(){return now},advance:ms=>now+=ms,
    restart:async()=>{await app.close();app=make();await app.listen()},close:async()=>{await app.close();rmSync(dir,{recursive:true,force:true})}};
}

test('时间胶囊：封存不返回正文/图片，到期边界、本人权限、标记已读和删除',async()=>{
  const f=await fixture();try{
    const c=await f.ok(f.rpc('10001','capsule.create',{text:'只给未来的自己',images:[png],afterValue:1,afterUnit:'minutes',author:'10002'}));
    assert.equal(c.ready,false);assert.equal(c.imageCount,1);assert.equal(c.text,undefined);assert.equal(c.images,undefined);
    const list=await f.ok(f.rpc('10001','capsule.list'));assert.equal(list.sealed,1);assert.equal(JSON.stringify(list).includes('只给未来'),false);assert.equal(JSON.stringify(list).includes(png.base64),false);
    for(const action of ['read','delete'])assert.equal((await f.rpc('10002',`capsule.${action}`,{capsuleId:c.id})).status,404);
    assert.equal((await f.ok(f.rpc('10002','capsule.list'))).total,0);
    assert.equal((await f.rpc('10001','capsule.read',{capsuleId:c.id})).status,409);f.advance(59999);
    assert.equal((await f.rpc('10001','capsule.read',{capsuleId:c.id})).status,409);f.advance(1);
    assert.equal((await f.ok(f.rpc('10001','capsule.status'))).unread,1);
    const read=await f.ok(f.rpc('10001','capsule.read',{capsuleId:c.id}));assert.equal(read.text,'只给未来的自己');assert.deepEqual(read.images,[png]);assert.ok(read.openedAt);
    assert.equal((await f.ok(f.rpc('10001','capsule.status'))).unread,0);
    assert.equal((await f.ok(f.rpc('10001','capsule.delete',{capsuleId:c.id}))).deleted,true);
    assert.equal((await f.rpc('10001','capsule.read',{capsuleId:c.id})).status,404);
  }finally{await f.close()}
});

test('时间胶囊：600个Unicode字符、三张1MiB图片、空内容/恶意图片及请求大小边界',async()=>{
  const f=await fixture();try{
    const create=(args)=>f.rpc('10001','capsule.create',{afterValue:1,afterUnit:'weeks',...args});
    for(const args of [{text:'x'.repeat(601)},{text:'🌟'.repeat(601)},{text:''},{images:[null]},{images:[png,png,png,png]},{images:'wrong'},{images:[{...png,base64:'a<script>'}]},{images:[{...png,base64:Buffer.alloc(1048577).toString('base64')}]}])assert.equal((await create(args)).status,400);
    const bytes=Buffer.alloc(1048576);Buffer.from(png.base64,'base64').copy(bytes);const image={mime:'image/png',base64:bytes.toString('base64')};
    const c=await f.ok(create({text:'🌟'.repeat(600),images:[image,image,image]}));assert.equal(c.imageCount,3);
    assert.equal((await f.post('/mobile/login',{padding:'x'.repeat(1600001)})).status,413);
    assert.equal((await create({text:'x'.repeat(4300001)})).status,413);
    f.advance(7*86400000);const read=await f.ok(f.rpc('10001','capsule.read',{capsuleId:c.id}));assert.equal([...read.text].length,600);assert.deepEqual(read.images,[image,image,image]);
  }finally{await f.close()}
});

test('时间胶囊：日历月末与闰年、自定义短时长和多年日期，不接受过去或无时区日期',()=>{
  assert.equal(capsuleTime({afterValue:1,afterUnit:'months'},Date.parse('2028-01-31T09:00:00+08:00')),'2028-02-29T01:00:00.000Z');
  assert.equal(capsuleTime({afterValue:1,afterUnit:'years'},Date.parse('2028-02-29T09:00:00+08:00')),'2029-02-28T01:00:00.000Z');
  const now=Date.parse('2026-11-03T10:00:00+08:00');
  assert.equal(capsuleTime({afterValue:50,afterUnit:'years'},now),'2076-11-03T02:00:00.000Z');
  assert.equal(capsuleTime({afterValue:1,afterUnit:'minutes'},now),'2026-11-03T02:01:00.000Z');
  assert.equal(capsuleTime({opensAt:'9999-01-01T00:00:00+08:00'},now),'9998-12-31T16:00:00.000Z');
  for(const args of [{opensAt:'2026-11-03T02:00:00Z'},{opensAt:'2030-02-30T10:00:00Z'},{opensAt:'2030-12-03T10:00:00'},{afterValue:0,afterUnit:'years'},{afterValue:1.5,afterUnit:'days'},{afterValue:10000,afterUnit:'years'},{afterValue:1,afterUnit:'__proto__'},{afterValue:1,afterUnit:'weeks',opensAt:'2030-01-01T00:00Z'}])assert.throws(()=>capsuleTime(args,now));
});

test('时间胶囊：重启后到期提示仅元数据且只产生一次，主动读后不再产生旧提醒',async()=>{
  const f=await fixture();try{
    const c=await f.ok(f.rpc('10001','capsule.create',{text:'秘密信件',images:[png],afterValue:1,afterUnit:'minutes'}));
    await f.restart();f.advance(60000);
    let events=await f.ok(f.rpc('10001','events',{since:0}));const ready=events.filter(e=>e.type==='capsule.ready');assert.equal(ready.length,1);assert.deepEqual(ready[0].data.capsuleIds,[c.id]);assert.equal(JSON.stringify(ready).includes('秘密信件'),false);assert.equal(JSON.stringify(ready).includes('base64'),false);
    await f.restart();events=await f.ok(f.rpc('10001','events',{since:ready[0].seq}));assert.equal(events.filter(e=>e.type==='capsule.ready').length,0);
    const read=await f.ok(f.rpc('10001','capsule.read',{capsuleId:c.id}));assert.deepEqual(read.images,[png]);
    const c2=await f.ok(f.rpc('10001','capsule.create',{text:'先读再轮询',afterValue:1,afterUnit:'minutes'}));f.advance(60000);await f.ok(f.rpc('10001','capsule.read',{capsuleId:c2.id}));
    events=await f.ok(f.rpc('10001','events',{since:ready[0].seq}));assert.equal(events.filter(e=>e.type==='capsule.ready').length,0);
  }finally{await f.close()}
});

test('时间胶囊：长轮询在开启时间醒来，暂停活动期间不投递，恢复后补提醒',async()=>{
  const f=await fixture();let timer;try{
    const c=await f.ok(f.rpc('10001','capsule.create',{text:'到期提醒',opensAt:new Date(f.now+300).toISOString()}));
    timer=setTimeout(()=>f.advance(300),100);
    const events=await f.ok(f.rpc('10001','events',{since:0,waitMs:2000}));
    const ready=events.find(e=>e.type==='capsule.ready');assert.ok(ready);assert.deepEqual(ready.data.capsuleIds,[c.id]);
    const c2=await f.ok(f.rpc('10001','capsule.create',{text:'恢复后查收',afterValue:1,afterUnit:'minutes'}));
    f.app.store.put('conduct','10001',{hits:[],until:f.now+120000});f.advance(60000);
    assert.equal((await f.ok(f.rpc('10001','events',{since:ready.seq}))).some(e=>e.type==='capsule.ready'),false);
    assert.equal((await f.rpc('10001','capsule.read',{capsuleId:c2.id})).status,403);
    assert.equal(f.app.store.get('capsules',c2.id).notifiedAt,null);
    f.advance(60000);const recovered=await f.ok(f.rpc('10001','events',{since:ready.seq}));assert.deepEqual(recovered.find(e=>e.type==='capsule.ready').data.capsuleIds,[c2.id]);
  }finally{clearTimeout(timer);await f.close()}
});

test('时间胶囊：手机/网页共用本人胶囊，不能冒充绑定bot，无绑定邮箱账号也能使用',async()=>{
  const f=await fixture();try{
    const mobile=await f.human('10001'),web=await f.human('10001','web'),other=await f.human('10002');
    const c=await f.ok(mobile('capsule.create',{text:'人类信件',afterValue:1,afterUnit:'minutes',author:'10001',botId:'10001'}));
    assert.equal(f.app.store.get('capsules',c.id).author,'10001H');assert.equal((await f.ok(web('capsule.list'))).items[0].id,c.id);
    assert.equal((await f.rpc('10001','capsule.read',{capsuleId:c.id})).status,404);assert.equal((await other('capsule.delete',{capsuleId:c.id})).status,404);
    const b=await f.ok(f.rpc('10001','capsule.create',{text:'bot私信',afterValue:1,afterUnit:'minutes'}));
    f.advance(60000);assert.equal((await web('capsule.read',{capsuleId:b.id})).status,404);assert.equal((await f.ok(web('capsule.read',{capsuleId:c.id}))).text,'人类信件');
    const modern=await f.register();const modernCapsule=await f.ok(modern.call('capsule.create',{text:'独立人类',afterValue:1,afterUnit:'years'}));assert.equal(f.app.store.get('capsules',modernCapsule.id).author,modern.account.humanId);
    await f.ok(modern.call('account.bind',{botId:'10001',credential:'a'.repeat(32)}));assert.ok((await f.ok(modern.call('capsule.list'))).items.some(v=>v.id===c.id),'合并旧H号后保留个人胶囊');
    assert.equal((await f.ok(f.rpc('10001','capsule.list'))).items[0].id,b.id,'bot胶囊仍独立');
  }finally{await f.close()}
});

test('时间胶囊：重试幂等、创建防刷、分页不重复、不计普通消息额度',async()=>{
  const f=await fixture();try{
    const quota=(await f.ok(f.rpc('10001','snapshot',{omitMessages:true}))).messageQuota;
    const requestId=randomUUID(),args={text:'一次封存',afterValue:1,afterUnit:'weeks',requestId};
    const c=await f.ok(f.rpc('10001','capsule.create',args));await f.ok(f.rpc('10001','capsule.create',args));assert.equal((await f.ok(f.rpc('10001','capsule.status'))).total,1);
    for(let i=0;i<2;i++)await f.ok(f.rpc('10001','capsule.create',{...args,requestId:randomUUID()}));
    assert.equal((await f.rpc('10001','capsule.create',{...args,requestId:randomUUID()})).status,429);
    for(let i=0;i<22;i++){f.advance(60001);await f.ok(f.rpc('10001','capsule.create',{...args,requestId:randomUUID()}))}
    const a=await f.ok(f.rpc('10001','capsule.list'));assert.equal(a.items.length,20);assert.equal(a.total,25);const b=await f.ok(f.rpc('10001','capsule.list',{before:a.nextBefore}));assert.equal(b.items.length,5);assert.equal(b.nextBefore,null);assert.equal(new Set([...a.items,...b.items].map(x=>x.id)).size,25);assert.ok(b.items.some(x=>x.id===c.id));
    const after=(await f.ok(f.rpc('10001','snapshot',{omitMessages:true}))).messageQuota;assert.equal(quota.used,0);assert.equal(after.used,quota.used);assert.equal(after.period.used,quota.period.used);
  }finally{await f.close()}
});

test('时间胶囊：多年封存的图片不进入孤儿清理，备份恢复保留全文和三张图片引用',async()=>{
  const f=await fixture();try{
    const c=await f.ok(f.rpc('10001','capsule.create',{text:'三年后见',images:[png,png,png],afterValue:3,afterUnit:'years'}));
    const store=f.app.store;const imagePath=join(store.mediaDir,readdirSync(store.mediaDir)[0]);const old=new Date(f.now-30*86400000);utimesSync(imagePath,old,old);
    store.pruneEvents(f.now+90*86400000);const stateDir=join(f.dir,'gc');mkdirSync(stateDir);
    assert.equal(scanOrphanMedia({dbFile:store.dbFile,mediaDir:store.mediaDir,stateDir,now:f.now+90*86400000}).candidates,0);
    const destination=join(f.dir,'backup');await backupStarpost(store.dbFile,store.mediaDir,destination);
    const restored=new StarpostStorage({dbFile:join(destination,'data.sqlite'),mediaDir:join(destination,'media')});
    try{const data=restored.hydrate(restored.get('capsules',c.id));assert.equal(data.text,'三年后见');assert.deepEqual(data.images,[png,png,png]);assert.equal(data.opensAt,'2029-11-03T02:00:00.000Z')}finally{restored.close()}
    await f.ok(f.rpc('10001','capsule.delete',{capsuleId:c.id}));assert.equal(scanOrphanMedia({dbFile:store.dbFile,mediaDir:store.mediaDir,stateDir,now:f.now+90*86400000}).candidates,1);
  }finally{await f.close()}
});
