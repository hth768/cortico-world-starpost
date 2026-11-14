import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';

async function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'starpost-search-')),keys={10001:'a'.repeat(32),10002:'b'.repeat(32),10003:'c'.repeat(32)},mails=[];
  const app=createStarpostServer({file:join(directory,'data.json'),keys,port:0,sendMail:async m=>mails.push(m)});
  await app.listen();t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  async function post(path,body,token='') {
    const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body)});
    return {status:r.status,...await r.json()};
  }
  async function claim(id){
    const old=await post('/mobile/login',{botId:id,credential:keys[id]});assert(old.ok,old.error);
    const email=`search-${id}@example.com`,v=await post('/mobile/auth',{action:'code',email,purpose:'claim'},old.result.accessToken);
    assert(v.ok,v.error);
    const r=await post('/mobile/auth',{action:'claim',email,nickname:`用户${id}`,password:'test-search-pass',challengeId:v.result.challengeId,code:mails.at(-1).code},old.result.accessToken);
    assert(r.ok,r.error);return r.result;
  }
  const a=await claim('10001'),b=await claim('10002'),c=await claim('10003');
  app.store.befriend(a.humanId,b.humanId);app.store.befriend('10001','10002');
  const rpc=(who,action,args={})=>post('/mobile/rpc',{action,args},who.accessToken);
  const ok=async promise=>{const r=await promise;assert.equal(r.status,200,r.error);return r.result;};
  const put=(id,values)=>app.store.put(values.kind==='owner'?'ownerMessages':'messages',id,{id,at:'2026-11-14T12:00:00.000Z',sender:a.humanId,target:b.humanId,kind:'private',text:'默认消息',...values});
  return {app,a,b,c,rpc,ok,put,base};
}

test('历史搜索覆盖私聊/群聊/专属频道/只读 bot 会话，分页、上下文和跨端权限一致',async t=>{
  const {app,a,b,c,rpc,ok,put,base}=await fixture(t);
  for(let i=0;i<45;i++)put(`p${i}`,{text:`下午散步 ${i}`,sender:i%2?a.humanId:b.humanId,target:i%2?b.humanId:a.humanId});
  const args={kind:'private',target:b.humanId,query:'散步'},search=x=>ok(rpc(a,'social.history.search',{...args,...x}));
  const first=await search({});assert.equal(first.messages.length,20);assert.equal(first.messages[0].id,'p44');
  const second=await search({before:first.nextBefore}),third=await search({before:second.nextBefore});
  assert.equal(third.nextBefore,null);assert.equal(new Set([...first.messages,...second.messages,...third.messages].map(m=>m.id)).size,45);
  const context=await ok(rpc(a,'social.history.context',{...args,messageId:'p20'}));
  assert.equal(context.anchorId,'p20');assert.deepEqual(context.messages.map(m=>m.id),Array.from({length:17},(_,i)=>`p${i+12}`));assert(context.hasOlder&&context.hasNewer);
  put('foreign',{sender:c.humanId,target:b.humanId,text:'陌生人的秘密'});
  assert.equal((await rpc(c,'social.history.search',args)).status,403);
  assert.equal((await rpc(a,'social.history.context',{...args,messageId:'foreign'})).status,404);
  assert.equal((await rpc(a,'social.history.search',{...args,kind:'owner',target:'10003'})).status,400);
  app.store.saveGroup({id:'g',name:'群',owner:a.humanId,members:[a.humanId,b.humanId]});
  put('g1',{kind:'group',target:'g',text:'群内散步'});
  assert.equal((await ok(rpc(b,'social.history.search',{kind:'group',target:'g',query:'散步'}))).messages[0].id,'g1');
  assert.equal((await rpc(c,'social.history.search',{kind:'group',target:'g',query:'散步'})).status,404);
  app.store.saveGroup({...app.store.get('groups','g'),members:[a.humanId]});
  assert.equal((await rpc(b,'social.history.context',{kind:'group',target:'g',messageId:'g1'})).status,404);
  put('own',{kind:'owner',botId:'10001',direction:'bot',sender:'10001',text:'专属散步'});
  const owner=await ok(rpc(a,'owner.search',{query:'散步',target:'10001',viewerBotId:'10001'}));assert.equal(owner.messages[0].id,'own');
  assert.equal((await ok(rpc(b,'owner.search',{query:'散步'}))).messages.length,0);
  assert.equal((await rpc(b,'owner.search',{query:'散步',target:'10001'})).status,403);
  assert.equal((await rpc(b,'owner.context',{messageId:'own'})).status,404);
  assert.equal((await rpc(a,'owner.search',{query:'散步',viewerBotId:'10002'})).status,409);
  put('bot',{sender:'10001',target:'10002',text:'bot 散步'});
  assert.equal((await ok(rpc(a,'history.search',{kind:'private',target:'10002',query:'散步',viewerBotId:'10001'}))).messages[0].id,'bot');
  assert.equal((await rpc(c,'history.search',{kind:'private',target:'10002',query:'散步'})).status,403);
  const web=await fetch(base+'/web/rpc',{method:'POST',headers:{'content-type':'application/json',origin:base,cookie:`starpost_session=${a.accessToken}`},body:JSON.stringify({action:'owner.context',args:{messageId:'own'}})});
  assert.equal(web.status,200);assert.equal((await web.json()).result.anchorId,'own');
  await ok(rpc(a,'safety.block',{botId:b.humanId}));
  assert.equal((await search({})).messages[0].id,'p44','拉黑前保留记录仍可搜索');
  app.store.put('botOwners','10001',{...app.store.get('botOwners','10001'),humanId:b.humanId});
  assert.equal((await rpc(a,'owner.search',{query:'散步'})).status,403,'失去 bot 归属后立即撤销搜索权限');
  assert.equal((await rpc(a,'owner.context',{messageId:'own'})).status,403);
});

test('关键词按字面匹配、北京日期边界、撤回与图片摘要，以及空窗口继续扫描',async t=>{
  const {app,a,b,rpc,ok,put}=await fixture(t),args={kind:'private',target:b.humanId};
  const search=x=>ok(rpc(a,'social.history.search',{...args,...x}));
  put('literal',{text:"hello %_ ' 雨天"});put('other',{text:'hello anything 雨天'});
  assert.deepEqual((await search({query:"%_ '"})).messages.map(m=>m.id),['literal']);
  assert.equal((await search({query:'HELLO'})).messages.length,2);
  assert.equal((await search({query:"' OR 1=1 --"})).messages.length,0);
  put('before',{text:'边界',at:'2026-11-13T15:59:59.999Z'});put('start',{text:'边界',at:'2026-11-13T16:00:00.000Z'});
  put('end',{text:'边界',at:'2026-11-14T15:59:59.999Z'});put('after',{text:'边界',at:'2026-11-14T16:00:00.000Z'});
  assert.deepEqual((await search({query:'边界',startDate:'2026-11-14',endDate:'2026-11-14'})).messages.map(m=>m.id),['end','start']);
  assert((await search({startDate:'2026-11-14',endDate:'2026-11-14'})).messages.length>0);
  for(const bad of [{},{query:{}},{query:'x'.repeat(101)},{query:'a',before:-1},{query:'a',startDate:'2026-02-30'},{query:'a',startDate:'2026-11-15',endDate:'2026-11-14'}])assert.equal((await rpc(a,'social.history.search',{...args,...bad})).status,400);
  put('recalled',{text:'不应搜到的旧内容',recalled:true,image:{mime:'image/png',base64:'invalid'}});
  assert.equal((await search({query:'不应搜到'})).messages.length,0);
  const recalled=await ok(rpc(a,'social.history.context',{...args,messageId:'recalled'}));
  assert.equal(recalled.messages.at(-1).text,'该消息已撤回');assert.equal(recalled.messages.at(-1).image,null);
  const image={mime:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII='};
  put('picture',{text:'海边照片',image});
  const result=(await search({query:'照片'})).messages[0];assert.equal(result.hasImage,true);assert.equal(result.image,undefined);
  assert.equal((await ok(rpc(a,'social.history.context',{...args,messageId:'picture'}))).messages.at(-1).image.base64,image.base64);
  app.store.transaction(()=>{for(let i=0;i<2001;i++)put(`scan${i}`,{text:'近期不匹配的内容'});});
  const empty=await search({query:'照片'});assert.equal(empty.messages.length,0);assert(empty.nextBefore);
  assert.equal((await search({query:'照片',before:empty.nextBefore})).messages[0].id,'picture');
});
