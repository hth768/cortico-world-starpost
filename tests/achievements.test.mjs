import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createStarpostServer} from '../server/server.mjs';
import {AccountTitles} from '../server/account-titles.mjs';
import {Achievements,ACHIEVEMENTS} from '../server/achievements.mjs';

async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'starpost-achievements-')),keys=Object.fromEntries(Array.from({length:6},(_,i)=>[String(10001+i),String(i).repeat(32)]));
 let now=Date.parse('2026-11-07T18:00:00+08:00');const file=join(dir,'db.json');
 let app=createStarpostServer({file,keys,port:0,clock:()=>now});await app.listen();
 const token='a'.repeat(64),key=createHash('sha256').update(token).digest('hex');
 app.store.put('people','10001H',{humanId:'10001H',email:'achievement@example.com',nickname:'星友',epoch:1});
 app.store.put('humanSessions',key,{key,owner:'10001H',epoch:1,selectedBotId:'10001',expiresAt:now+90*86400000});app.store.put('botOwners','10001',{humanId:'10001H'});
 app.store.befriend('10001','10002');app.store.befriend('10001H','10002');
 const request=async(path,action,args,headers)=>{const r=await fetch(`http://127.0.0.1:${app.server.address().port}`+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({action,args})});return {status:r.status,...await r.json()};};
 const bot=(action,args={},who='10001')=>request('/rpc',action,args,{'x-starpost-id':who,authorization:`Bearer ${keys[who]}`});
 const human=(action,args={})=>request('/mobile/rpc',action,args,{authorization:`Bearer ${token}`});
 const ok=async p=>{const r=await p;assert.equal(r.ok,true,r.error);return r.result;};
 const titles=()=>new AccountTitles(app.store,{known:id=>id in keys,clock:()=>now});
 const achievements=()=>new Achievements(app.store,titles(),{clock:()=>now,isKnown:id=>id in keys||Boolean(app.store.get('people',id))});
 const tx=fn=>app.store.transaction(()=>fn(achievements()));
 const match=(outcome='win',extra={})=>({id:randomUUID(),creator:'10001',status:'finished',winner:outcome==='draw'?'draw':outcome==='win'?'village':'wolves',participants:['10001'],roles:{10001:'villager'},forfeited:[],finishedAt:new Date(now).toISOString(),...extra});
 return {get app(){return app;},get now(){return now;},set:n=>now=typeof n==='number'?n:Date.parse(n),bot,human,ok,titles,achievements,tx,match,
  restart:async()=>{await app.close();app=createStarpostServer({file,keys,port:0,clock:()=>now});await app.listen();},
  close:async()=>{await app.close();rmSync(dir,{recursive:true,force:true});}};
}
const item=(a,who,id)=>a.progress(who).items.find(r=>r.id===id);

test('普通消息成功后计数：151边界、人类独立、游戏/戳一戳/失败/撤回不重复计入，不自动佩戴',async()=>{
 const f=await fixture();try{
  const send={kind:'private',target:'10002',text:'今天来打个招呼',idleToEndSec:0,maxConsecutiveBotTurns:100};
  assert.equal((await f.bot('message.send',{...send,text:''})).ok,false);assert.equal(f.achievements().stats('10001').messages,0);
  await f.ok(f.bot('poke',{to:'10002'}));assert.equal(f.achievements().stats('10001').messages,0);
  const first=await f.ok(f.bot('message.send',send));assert.equal(f.achievements().stats('10001').messages,1);
  assert.equal(f.titles().inventory('10001').equippedTitleId,'');
  await f.ok(f.bot('message.recall',{kind:'private',target:'10002',messageId:first.id}));assert.equal(f.achievements().stats('10001').messages,1);
  for(let i=1;i<150;i++){if(i===95)await f.ok(f.bot('message.send',{...send,target:'10001',text:'收到你的问候'},'10002'));await f.ok(f.bot('message.send',send));}
  assert.equal(item(f.achievements(),'10001','chatty').earned,false);
  await f.ok(f.bot('message.send',send));assert.equal(item(f.achievements(),'10001','chatty').earned,true);
  const t=f.titles().inventory('10001').titles.find(t=>t.text==='话痨');assert.equal(t.style.background,'jade');assert.equal(t.source,'achievement');
  await f.ok(f.human('owner.address',{address:'主人'}));await f.ok(f.human('owner.send',{text:'主人频道也聊一句'}));
  assert.equal(f.achievements().stats('10001H').messages,1);assert.equal(f.achievements().stats('10001').messages,151);
  await f.ok(f.bot('owner.send',{text:'收到'}));assert.equal(f.achievements().stats('10001').messages,152);
  assert.equal((await f.human('social.profile',{botId:'10001',section:'achievements'})).status,403);
  assert.equal((await f.bot('profile.read',{botId:'10002',section:'achievements'})).status,403);
  assert.equal((await f.bot('achievement.unlock',{id:'wolf-champion'})).ok,false);
  const before=f.achievements().stats('10001');await f.ok(f.bot('profile.update',{achievementStats:{messages:999999}}));assert.deepEqual(f.achievements().stats('10001'),before);
 }finally{await f.close();}
});

test('北京时间跨日边界、不同活跃日、动态与漂流瓶：双账号独立，重复操作或读取不叠加',async()=>{
 const f=await fixture();try{
  f.set('2026-11-07T23:59:59+08:00');f.tx(a=>{for(let i=0;i<150;i++)a.record('10001','message',f.now);});
  f.set('2026-11-08T00:00:00+08:00');f.tx(a=>a.record('10001','message',f.now));assert.equal(item(f.achievements(),'10001','chatty').earned,false);
  for(let d=0;d<30;d++){f.set(Date.parse('2026-11-08T18:00:00+08:00')+d*86400000);await f.ok(f.bot('post.publish',{text:'记录今天的新鲜事'}));f.tx(a=>a.record('10001','message',f.now));}
  assert.equal(item(f.achievements(),'10001','regular').earned,true);assert.equal(item(f.achievements(),'10001','perseverance').earned,true);assert.equal(item(f.achievements(),'10001','chronicler').earned,true);
  const days=f.achievements().stats('10001').postDays.length;const p=await f.ok(f.bot('post.publish',{text:'同日的另一件事'}));await f.ok(f.bot('post.delete',{postId:p.id}));assert.equal(f.achievements().stats('10001').postDays.length,days);
  const bottle=await f.ok(f.bot('bottle.throw',{text:'给你一份祝福'}));await f.ok(f.human('social.bottle.pick'));await f.ok(f.human('social.bottle.reply',{bottleId:bottle.id,text:'收到了，谢谢'}));
  assert.equal(f.achievements().stats('10001').bottles,1);assert.equal(f.achievements().stats('10001H').bottles,1);
  assert.equal((await f.human('social.bottle.reply',{bottleId:bottle.id,text:'再来一次'})).ok,false);await f.ok(f.human('social.bottle.read',{bottleId:bottle.id}));assert.equal(f.achievements().stats('10001H').bottles,1);
 }finally{await f.close();}
});

test('狼人杀成就：有效局、五局边界、胜率21局与75%边界、平局、弃权、永久保留',async()=>{
 const f=await fixture();try{
  for(let i=0;i<4;i++)f.tx(a=>a.finish(f.match()));assert.equal(item(f.achievements(),'10001','wolf-five-day').earned,false);
  const fifth=f.match('draw');f.tx(a=>{a.finish(fifth);a.finish(fifth);});assert.equal(f.achievements().stats('10001').games.completed,5);assert.equal(item(f.achievements(),'10001','wolf-five-day').earned,true);
  for(let i=0;i<11;i++)f.tx(a=>a.finish(f.match()));for(let i=0;i<5;i++)f.tx(a=>a.finish(f.match('loss')));
  assert.equal(f.achievements().stats('10001').games.wins,15);assert.equal(item(f.achievements(),'10001','wolf-champion').earned,false,'20场75%仍不够');
  const aborted=f.match('win',{forfeited:['10001']});f.tx(a=>a.finish(aborted));assert.equal(f.achievements().stats('10001').games.completed,21);
  assert.equal(f.achievements().stats('10001').games.streak,0);assert.equal(item(f.achievements(),'10001','wolf-champion').earned,false);
  f.tx(a=>a.finish(f.match()));assert.equal(item(f.achievements(),'10001','wolf-champion').earned,true);
  for(let i=0;i<24;i++){
    f.tx(a=>a.finish(f.match(i<6?'loss':'win',{participants:['10002'],roles:{10002:'villager'}})));
    if(i===22)assert.equal(item(f.achievements(),'10002','wolf-champion').earned,false,'17/23不足75%');
  }
  assert.equal(item(f.achievements(),'10002','wolf-champion').earned,true,'18/24恰好75%达成');
  f.tx(a=>a.finish(f.match('win',{participants:['10002'],roles:{10002:'villager'},kicked:['10002']})));
  assert.equal(f.achievements().stats('10002').games.completed,24,'被踢不算有效局');
  const champion=f.titles().inventory('10001').titles.find(t=>t.achievementId==='wolf-champion');assert.equal(champion.style.background,'gold');assert.equal(champion.style.font,'serif');
  f.tx(()=>f.titles().equip('10001',champion.id));for(let i=0;i<10;i++)f.tx(a=>a.finish(f.match('loss')));
  assert.equal(f.titles().inventory('10001').equippedTitleId,champion.id);assert.equal(item(f.achievements(),'10001','wolf-champion').earned,true);
  f.titles().revoke('10001',champion.id);f.tx(a=>a.record('10001','message'));assert.equal(item(f.achievements(),'10001','wolf-champion').owned,false);
  await f.restart();assert.equal(item(f.achievements(),'10001','wolf-champion').owned,false);assert.equal(item(f.achievements(),'10001','wolf-champion').earned,true);
 }finally{await f.close();}
});

test('自动统计与授予同事务回滚，账号合并去重游戏和活跃日期、不越权选择头衔',async()=>{
 const f=await fixture();try{
  assert.throws(()=>f.tx(a=>{a.record('10001','message');throw Error('rollback');}));assert.equal(f.achievements().stats('10001').messages,0);assert.equal(f.titles().inventory('10001').titles.length,0);
  f.app.store.put('people','10009H',{humanId:'10009H',nickname:'旧星友'});
  const match=f.match('win',{participants:['10001H','10009H'],roles:{'10001H':'villager','10009H':'villager'}});
  f.tx(a=>{a.record('10009H','message');a.record('10001H','message');a.finish(match);});
  f.tx(a=>{f.app.store.put('people','10009H',{humanId:'10009H',aliasOf:'10001H'});f.titles().merge('10009H','10001H');a.merge('10009H','10001H');});
  const s=f.achievements().stats('10001H');assert.equal(s.messages,2);assert.equal(s.messageDays.length,1);assert.equal(s.games.completed,1);assert.equal(f.titles().get('10001H'),'');
  assert.equal(f.app.store.count('achievementGames','owner=?',['10009H']),0);
 }finally{await f.close();}
});

test('狼人杀正常流程结束自动发奖，离开者无有效局，复盘离开不撤销已结算成绩',async()=>{
 const f=await fixture();try{
  const ids=Array.from({length:6},(_,i)=>String(10001+i));
  const {gameId}=await f.ok(f.bot('game.schedule',{startMode:'full',public:true,sourceKind:'square',maxPlayers:6,roles:{wolf:1,villager:5}}));
  for(const who of ids.slice(1))await f.ok(f.bot('game.join',{gameId},who));
  const game=f.app.store.get('games',gameId),wolf=ids.find(id=>game.roles[id]==='wolf');
  const leaver=ids.find(id=>id!==wolf);await f.ok(f.bot('game.exit',{gameId},leaver));
  f.set(Date.parse(f.app.store.get('games',gameId).deadlineAt));f.app.tickGames();
  assert.equal(f.app.store.get('games',gameId).status,'day');
  for(const who of ids.filter(id=>id!==leaver))await f.ok(f.bot('game.act',{gameId,action:'end_speech'},who));
  for(const who of ids.filter(id=>id!==leaver))await f.ok(f.bot('game.vote',{gameId,target:wolf},who));
  assert.equal(f.app.store.get('games',gameId).status,'finished');assert.equal(f.achievements().stats(leaver).games.completed,0);
  const winner=ids.find(id=>id!==wolf&&id!==leaver);assert.equal(item(f.achievements(),winner,'wolf-first-win').earned,true);
  await f.ok(f.bot('game.exit',{gameId},winner));assert.equal(f.achievements().stats(winner).games.wins,1);
  assert.equal(f.achievements().stats(winner).messages,0,'游戏消息和动作不增加聊天成就');
 }finally{await f.close();}
});

test('保留的历史狼人杀只补算一次，旧缺失时间用结算消息，人类与bot分别归属',async()=>{
 const f=await fixture();try{
  const game=f.match('win',{participants:['10001','10001H','10002'],roles:{10001:'villager','10001H':'villager','10002':'villager'},left:['10001']});delete game.finishedAt;delete game.forfeited;
  f.app.store.put('gameMessages',randomUUID(),{gameId:game.id,kind:'left',phase:'finished',botId:'10001',at:new Date(f.now+60000).toISOString(),sender:'system',channel:'public'});
  f.app.store.put('gameMessages',randomUUID(),{gameId:game.id,kind:'forfeit',phase:'day',botId:'10002',at:new Date(f.now-60000).toISOString(),sender:'system',channel:'public'});
  f.app.store.put('games',game.id,game);f.app.store.put('gameMessages',randomUUID(),{gameId:game.id,kind:'finished',at:new Date(f.now).toISOString(),sender:'system',channel:'public'});
  f.app.store.remove('meta','achievementGamesBackfilled');await f.restart();
  assert.equal(f.achievements().stats('10001').games.wins,1);assert.equal(f.achievements().stats('10001H').games.wins,1);
  assert.equal(f.achievements().stats('10002').games.completed,0,'旧版bot被暂停也不计有效局');
  await f.restart();assert.equal(f.achievements().stats('10001').games.wins,1);
  assert.equal(ACHIEVEMENTS.length,15);assert.equal(new Set(ACHIEVEMENTS.map(a=>a.id)).size,15);
 }finally{await f.close();}
});
