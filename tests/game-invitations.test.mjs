import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStarpostServer } from '../server/server.mjs';

async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'starpost-member-invite-')),now=Date.parse('2026-11-02T18:00:00+08:00');
 const ids=Array.from({length:6},(_,i)=>String(10001+i)),keys=Object.fromEntries(ids.map(id=>[id,id.repeat(8)]));
 const app=createStarpostServer({file:join(dir,'db.json'),keys,port:0,clock:()=>now});await app.listen();
 const post=async(path,body,headers={})=>{const r=await fetch(`http://127.0.0.1:${app.server.address().port}${path}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return {status:r.status,...await r.json()}};
 const rpc=(who,action,args={})=>post('/rpc',{action,args},{'x-starpost-id':who,authorization:`Bearer ${keys[who]}`});
 const ok=async result=>{const r=await result;assert.equal(r.ok,true,r.error);return r.result};
 const phone=async bot=>{const login=await ok(post('/mobile/login',{botId:bot,credential:keys[bot]}));return (action,args={})=>post('/mobile/rpc',{action,args},{authorization:`Bearer ${login.accessToken}`})};
 const group=(owner,members)=>{const id=randomUUID();app.store.saveGroup({id,owner,members,name:'成员邀请测试群'});return id};
 return {app,now,ids,rpc,ok,phone,group,close:async()=>{await app.close();rmSync(dir,{recursive:true,force:true})}};
}
for(const family of ['game','mystery'])test(`${family} 私密预约成员可转邀好友及群成员，仍限制成员身份和邀请来源`,async()=>{
 const f=await fixture();try{
  f.app.store.befriend('10001','10002');f.app.store.befriend('10002','10003');
  const groupId=f.group('10002',['10001','10002','10003','10004']);const otherGroup=f.group('10005',['10005','10006']);
  const game=await f.ok(f.rpc('10001',`${family}.schedule`,{sourceKind:'private',sourceTarget:'10002',scheduledAt:new Date(f.now+600000).toISOString(),maxPlayers:6,presetId:'laidian'}));
  const invite=(who,args)=>f.rpc(who,`${family}.invite`,{gameId:game.gameId,...args});
  const friend={sourceKind:'private',sourceTarget:'10003'};
  assert.equal((await invite('10002',friend)).status,403,'尚未加入的受邀者不能转邀');
  await f.ok(f.rpc('10002',`${family}.join`,{gameId:game.gameId}));
  assert.equal((await f.ok(f.rpc('10002',`${family}.read`,{gameId:game.gameId}))).game.canInvite,true);
  assert.equal((await f.ok(invite('10002',friend))).invited,1);
  const invites=f.app.store.events('10003',0).filter(e=>e.type===`${family}.invited`);assert.equal(invites.length,1);assert.equal(invites[0].data.invitedBy,'10002');assert.equal(invites[0].data.gameId,game.gameId);
  const collection=family==='game'?'games':'mysteryGames';assert.equal(f.app.store.get(collection,game.gameId).joined.includes('10003'),false);
  await f.ok(f.rpc('10003',`${family}.join`,{gameId:game.gameId}));
  assert.equal((await f.ok(invite('10002',friend))).invited,0,'已加入者不重复邀请');
  assert.equal((await f.ok(invite('10002',{sourceKind:'group',sourceTarget:groupId}))).invited,1);
  assert.equal((await f.ok(invite('10002',{sourceKind:'group',sourceTarget:groupId}))).invited,0);
  assert.equal(f.app.store.events('10003',0).filter(e=>e.type===`${family}.invited`).length,1);
  assert.equal((await invite('10002',{sourceKind:'private',sourceTarget:'10006'})).status,403);
  assert.equal((await invite('10002',{sourceKind:'group',sourceTarget:otherGroup})).ok,false);
  assert.equal((await invite('10006',friend)).status,403);
  assert.equal((await f.rpc('10006',`${family}.read`,{gameId:game.gameId})).status,403);
  assert.equal(f.app.store.get(collection,game.gameId).public,false);
  await f.ok(f.rpc('10002',`${family}.leave`,{gameId:game.gameId}));assert.equal((await invite('10002',friend)).status,403);
  const ended=f.app.store.get(collection,game.gameId);ended.status='cancelled';ended.kind='cancelled';f.app.store.put(collection,ended.id,ended);
  assert.equal((await invite('10003',friend)).status,403,'结束预约不能再转邀');
 }finally{await f.close()}
});
test('手机/网页的人类成员可邀请好友、自己的 bot 和群成员，身份由登录会话决定',async()=>{
 const f=await fixture();try{
  const member=await f.phone('10002'),target=await f.phone('10003'),outsider=await f.phone('10004');
  f.app.store.befriend('10001','10002H');f.app.store.befriend('10002H','10003H');
  const groupId=f.group('10002H',['10002H','10003H','10006']);const otherGroup=f.group('10004H',['10004H','10005']);
  const game=await f.ok(f.rpc('10001','game.schedule',{sourceKind:'private',sourceTarget:'10002H',scheduledAt:new Date(f.now+600000).toISOString(),maxPlayers:6}));
  const args={gameId:game.gameId,sourceKind:'private',sourceTarget:'10003H',humanId:'10001H'};
  assert.equal((await member('human.invite',args)).status,403);
  await f.ok(member('human.join',{gameId:game.gameId}));
  assert.equal((await f.ok(member('human.room',{gameId:game.gameId}))).game.canInvite,true);
  assert.equal((await f.ok(member('human.invite',args))).invited,1);
  const invitations=(await f.ok(target('human.lobby'))).games;assert.equal(invitations.find(g=>g.gameId===game.gameId).canInvite,false);
  assert.equal(f.app.store.get('games',game.gameId).joined.includes('10003H'),false);
  await f.ok(target('human.join',{gameId:game.gameId}));
  assert.equal((await f.ok(member('human.invite',args))).invited,0);
  assert.equal((await f.ok(member('human.invite',{...args,sourceTarget:'10002'}))).invited,1,'可邀请自己绑定的 bot');
  assert.equal((await f.ok(member('human.invite',{...args,sourceKind:'group',sourceTarget:groupId}))).invited,1);
  assert.equal((await member('human.invite',{...args,sourceKind:'group',sourceTarget:otherGroup})).ok,false);
  assert.equal((await member('human.invite',{...args,sourceTarget:'10005'})).status,403);
  assert.equal((await outsider('human.invite',args)).status,403);
  assert.equal(f.app.store.events('10006',0).find(e=>e.type==='game.invited').data.invitedBy,'10002H');
  f.app.store.put('humanConduct','10002',{strikes:2,banned:true});
  assert.equal((await member('human.invite',args)).status,403);
  assert.equal((await f.ok(member('human.room',{gameId:game.gameId}))).game.canInvite,false);
  f.app.store.remove('humanConduct','10002');
  await f.ok(member('human.leave',{gameId:game.gameId}));assert.equal((await member('human.invite',args)).status,403);
  const current=f.app.store.get('games',game.gameId);current.kicked=['10003H'];f.app.store.put('games',game.gameId,current);
  assert.equal((await target('human.invite',{...args,sourceTarget:'10003'})).status,403);
  assert.equal(current.public,false);
 }finally{await f.close()}
});
test('合并旧 H 身份后，保留对局身份并使用当前账号的好友与群权限邀请',async()=>{
 const f=await fixture();try{
  const old=await f.phone('10002'),current=await f.phone('10004');
  f.app.store.befriend('10001','10002H');f.app.store.befriend('10004H','10003H');
  const groupId=f.group('10004H',['10004H','10003H','10006']);
  const game=await f.ok(f.rpc('10001','game.schedule',{sourceKind:'private',sourceTarget:'10002H',scheduledAt:new Date(f.now+600000).toISOString(),maxPlayers:6}));
  await f.ok(old('human.join',{gameId:game.gameId}));
  const person=f.app.store.get('people','10002H');f.app.store.put('people','10002H',{...person,aliasOf:'10004H',epoch:person.epoch+1});
  assert.equal((await f.ok(current('human.invite',{gameId:game.gameId,sourceKind:'private',sourceTarget:'10003H'}))).invited,1);
  assert.equal((await f.ok(current('human.invite',{gameId:game.gameId,sourceKind:'group',sourceTarget:groupId}))).invited,1);
  assert.equal(f.app.store.events('10006',0).find(e=>e.type==='game.invited').data.invitedBy,'10002H');
  assert.deepEqual(f.app.store.get('games',game.gameId).joined,['10001','10002H']);
 }finally{await f.close()}
});
