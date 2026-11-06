import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStarpostServer} from '../server/server.mjs';
import {AccountTitles} from '../server/account-titles.mjs';

async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'starpost-anonymous-'));let now=Date.parse('2026-11-07T18:00:00+08:00');
 const ids=Array.from({length:12},(_,i)=>String(10001+i)),keys=Object.fromEntries(ids.map(id=>[id,id.repeat(8)]));
 let app=createStarpostServer({file:join(dir,'data.json'),keys,port:0,clock:()=>now});await app.listen();
 const post=async(path,body,headers={})=>{const base=`http://127.0.0.1:${app.server.address().port}`;const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',origin:base,...headers},body:JSON.stringify(body)});return {cookie:r.headers.get('set-cookie')?.split(';')[0],...await r.json()};};
 const rpc=(id,action,args={})=>post('/rpc',{action,args},{'x-starpost-id':id,authorization:'Bearer '+keys[id]});
 const ok=async p=>{const r=await p;assert.equal(r.ok,true,r.error);return r.result;};
 for(const id of ids){await ok(rpc(id,'profile.update',{nickname:`秘密玩家${id}`,bio:'不应出现在牌桌'}));new AccountTitles(app.store,{known:id=>id in keys}).grant(id,'秘密头衔');}
 const human=async(id,kind)=>{const login=await post(`/${kind}/login`,{botId:id,credential:keys[id]});const data=await ok(login);return (action,args={})=>post(`/${kind}/rpc`,{action,args},kind==='web'?{cookie:login.cookie}:{authorization:'Bearer '+data.accessToken});};
 const full=(id='10001',family='game',anonymous=true)=>ok(rpc(id,`${family}.schedule`,{anonymous,startMode:'full',public:true,sourceKind:'square',maxPlayers:6,presetId:'laidian'}));
 return {get app(){return app},ids,keys,rpc,ok,human,full,advance:ms=>{now+=ms;app.tickGames()},restart:async()=>{await app.close();app=createStarpostServer({file:join(dir,'data.json'),keys,port:0,clock:()=>now});await app.listen();},close:async()=>{await app.close();rmSync(dir,{recursive:true,force:true})}};
}
const assertHidden=value=>{const s=JSON.stringify(value);assert.doesNotMatch(s,/1000[1-6]H?|秘密玩家|秘密头衔|creatorTitle|senderAvatarVersion/);};

test('旧预约允许新成员按个人匿名加入，不回溯改变原成员的身份',async()=>{
 const f=await fixture();try{
  for(const [family,collection,creator,entrant] of [['game','games','10001','10002'],['mystery','mysteryGames','10003','10004']]){
   const room=await f.full(creator,family,false),legacy=f.app.store.get(collection,room.gameId);
   delete legacy.privacyVersion;delete legacy.seatNumbers;delete legacy.anonymousPlayers;f.app.store.put(collection,legacy.id,legacy);
   await f.ok(f.rpc(creator,'game.privacy',{anonymous:true}));await f.ok(f.rpc(entrant,'game.privacy',{anonymous:true}));
   await f.ok(f.rpc(entrant,`${family}.join`,{gameId:legacy.id}));
   const page=await f.ok(f.rpc(entrant,`${family}.read`,{gameId:legacy.id}));
   assert.equal(page.game.creator,creator);assert.equal(page.game.seats[0].id,creator);assert.equal(page.game.seats[1].id,'seat:2');
  }
 }finally{await f.close()}
});

test('匿名匹配独立分池，个人设置冻结于加入时，重启和离场后座位稳定',async()=>{
 const f=await fixture();try{
  const a=await f.ok(f.rpc('10001','game.match',{operation:'join',maxPlayers:6,anonymous:true}));
  const b=await f.ok(f.rpc('10002','game.match',{operation:'join',maxPlayers:6,anonymous:false}));assert.notEqual(a.game.gameId,b.game.gameId);
  assert.equal((await f.rpc('10001','game.match',{operation:'join',maxPlayers:6,anonymous:false})).ok,false);
  await f.ok(f.rpc('10003','game.privacy',{anonymous:true}));
  await f.ok(f.rpc('10003','game.join',{gameId:b.game.gameId}));
  await f.ok(f.rpc('10003','mystery.privacy',{anonymous:false}));
  let page=await f.ok(f.rpc('10002','game.read',{gameId:b.game.gameId}));
  assert.equal(page.game.seats.find(s=>s.number===2).id,'seat:2');assert.equal(page.game.seats[0].id,'10002');
  await f.ok(f.rpc('10002','game.leave',{gameId:b.game.gameId}));
  await f.restart();page=await f.ok(f.rpc('10003','game.read',{gameId:b.game.gameId}));assert.equal(page.game.seats[0].number,2);
  assert.equal((await f.rpc('10004','game.privacy',{anonymous:'true'})).ok,false);
 }finally{await f.close()}
});

test('整局匿名覆盖房主和身份元数据，广场、事件、回放一致，座位引用可以投票',async()=>{
 const f=await fixture();try{
  const room=await f.full();assert.equal(room.creator,undefined);assert.equal(room.canCancel,true);
  for(const id of f.ids.slice(1,6))await f.ok(f.rpc(id,'game.join',{gameId:room.gameId}));
  let g=f.app.store.get('games',room.gameId);g.status='vote';g.votes={};f.app.store.put('games',g.id,g);
  const page=await f.ok(f.rpc('10001','game.read',{gameId:g.id}));assertHidden(page);assert.equal(page.game.self,'seat:1');assert.equal(page.game.seats[0].nickname,'1号');
  await f.ok(f.rpc('10001','game.vote',{gameId:g.id,target:'seat:2'}));assert.equal(f.app.store.get('games',g.id).votes['10001'],'10002');
  assert.equal((await f.rpc('10003','game.vote',{gameId:g.id,target:'seat:999'})).ok,false);
  const events=await f.ok(f.rpc('10001','events',{since:0}));for(const e of events.filter(e=>e.data?.gameId===g.id))assertHidden(e.data);
  const square=await f.ok(f.rpc('10007','square.list'));assert(square.some(s=>s.gameId===g.id));assertHidden(square.filter(s=>s.gameId===g.id));
  assertHidden(await f.ok(f.rpc('10007','game.read',{gameId:g.id})));
  assert.equal((await f.rpc('10007','profile.read',{gameId:g.id,botId:'seat:1'})).ok,false,'座位不是查询账号资料的入口');
 }finally{await f.close()}
});

for(const kind of ['mobile','web'])test(`${kind} 人类匿名房间、设置与行动目标使用座位，保留取消权限`,async()=>{
 const f=await fixture();try{
  const human=await f.human('10008',kind);
  await f.ok(human('human.privacy',{anonymous:true}));assert.equal((await f.ok(human('human.lobby'))).privacy.anonymous,true);
  const room=await f.ok(human('human.schedule',{anonymous:true,startMode:'full',public:true,maxPlayers:6}));
  let page=await f.ok(human('human.room',{gameId:room.gameId}));assert.equal(page.humanId,'seat:1');assert.equal(page.game.creator,undefined);assert.equal(page.game.canCancel,true);
  for(const id of f.ids.slice(0,5))await f.ok(f.rpc(id,'game.join',{gameId:room.gameId}));
  const game=f.app.store.get('games',room.gameId);game.status='vote';game.votes={};f.app.store.put('games',game.id,game);
  page=await f.ok(human('human.room',{gameId:game.id}));assert.doesNotMatch(JSON.stringify(page),/10008H|秘密玩家|秘密头衔/);
  const target=page.options[0].targets.find(t=>t.id==='seat:2');assert(target);
  await f.ok(human('human.move',{gameId:game.id,move:'vote',target:target.id}));assert.equal(f.app.store.get('games',game.id).votes['10008H'],'10001');
 }finally{await f.close()}
});

test('匿名剧本杀保留主持操作而不泄露账号；私密线索、举报和结局回放可用',async()=>{
 const f=await fixture();try{
  const g=await f.full('10001','mystery');
  for(const id of f.ids.slice(1,6))await f.ok(f.rpc(id,'mystery.join',{gameId:g.gameId}));
  let page=await f.ok(f.rpc('10001','mystery.read',{gameId:g.gameId}));assertHidden(page);assert.equal(page.game.host,true);assert.equal(page.game.hostReference,'seat:1');assert.equal(page.game.seats.find(s=>s.id==='seat:1').hostRole,true);
  const sent=await f.ok(f.rpc('10001','mystery.message',{gameId:g.gameId,channel:'private',toBotId:'seat:2',text:'这是一份私密线索'}));
  page=await f.ok(f.rpc('10002','mystery.read',{gameId:g.gameId}));assertHidden(page);assert(page.messages.some(m=>m.id===sent.messageId));
  assert(!(await f.ok(f.rpc('10003','mystery.read',{gameId:g.gameId}))).messages.some(m=>m.id===sent.messageId));
  await f.ok(f.rpc('10002','safety.report',{botId:'seat:1',reason:'测试举报',evidence:{type:'mystery',id:sent.messageId,gameId:g.gameId}}));
  const reports=await f.ok(f.rpc('10002','safety.reports'));assertHidden(reports);
  await f.ok(f.rpc('10001','mystery.phase',{gameId:g.gameId,phase:'closed'}));
  assertHidden(await f.ok(f.rpc('10007','mystery.read',{gameId:g.gameId})));
 }finally{await f.close()}
});

test('匿名 bot 法官通过座位分配身份，狼人和神职以座位行动且私密权限不变',async()=>{
 const f=await fixture();try{
  const room=await f.ok(f.rpc('10001','game.schedule',{anonymous:true,startMode:'full',public:true,sourceKind:'square',maxPlayers:6,judgeMode:'bot',assignmentMode:'judge'}));
  for(const id of f.ids.slice(1,7))await f.ok(f.rpc(id,'game.join',{gameId:room.gameId}));
  const page=await f.ok(f.rpc('10001','game.read',{gameId:room.gameId}));
  assert.equal(page.game.status,'assigning');assert.deepEqual(page.game.seats.map(s=>s.number),[1,2,3,4,5,6]);assertHidden(page);
  const roles=['wolf','wolf','seer','villager','villager','villager'];
  await f.ok(f.rpc('10001','game.assign',{gameId:room.gameId,assignments:page.game.seats.map((s,i)=>({botId:s.id,role:roles[i]}))}));
  for(const id of ['10002','10003'])await f.ok(f.rpc(id,'game.act',{gameId:room.gameId,action:'attack',target:'seat:6'}));
  await f.ok(f.rpc('10004','game.act',{gameId:room.gameId,action:'inspect',target:'seat:1'}));
  const seer=await f.ok(f.rpc('10004','game.read',{gameId:room.gameId}));assert(seer.messages.some(m=>m.kind==='inspect_result'&&m.target==='seat:1'&&m.isWolf));assertHidden(seer);
  const villager=await f.ok(f.rpc('10005','game.read',{gameId:room.gameId}));assert(!villager.messages.some(m=>m.kind==='inspect_result'));
 }finally{await f.close()}
});
