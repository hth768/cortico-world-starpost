import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { AccountTitles } from '../server/account-titles.mjs';
import { titleStyle, TITLE_STYLE_PRESETS } from '../server/title-styles.mjs';
import { createStarpostServer } from '../server/server.mjs';

async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'starpost-titles-')),now=Date.parse('2026-11-06T18:00:00+08:00');
  const keys={10001:'a'.repeat(32),10002:'b'.repeat(32)};
  const app=createStarpostServer({file:join(dir,'data.json'),keys,port:0,clock:()=>now});await app.listen();
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(path,body,headers={})=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return {status:r.status,...await r.json()};};
  const bot=(action,args={},id='10001')=>request('/rpc',{action,args},{'x-starpost-id':id,authorization:`Bearer ${keys[id]}`});
  const ok=async value=>{const r=await value;assert.equal(r.ok,true,r.error);return r.result;};
  const token='c'.repeat(64),key=createHash('sha256').update(token).digest('hex');
  app.store.put('people','10001H',{humanId:'10001H',nickname:'星河旅人',email:'title@example.com',epoch:1});
  app.store.put('humanSessions',key,{key,owner:'10001H',epoch:1,selectedBotId:'10001',expiresAt:now+86400000});
  app.store.put('botOwners','10001',{humanId:'10001H'});
  const human=(action,args={})=>request('/mobile/rpc',{action,args},{authorization:`Bearer ${token}`});
  const titles=new AccountTitles(app.store,{known:id=>id in keys});
  await ok(bot('profile.update',{nickname:'陈玥汐'}));await ok(bot('profile.update',{nickname:'小星'},'10002'));
  return {app,dir,keys,now,titles,bot,human,ok,close:async()=>{await app.close();rmSync(dir,{recursive:true,force:true});}};
}

test('服务器授予、变更、撤销：校验、独立账号、别名及审计持久化',async()=>{
  const f=await fixture();try{
    for(const invalid of ['<b>管理员</b>','换\n行','隐\u200b藏','a'.repeat(17)])assert.throws(()=>f.titles.grant('10001',invalid));
    assert.throws(()=>f.titles.grant('99999','不存在'));assert.throws(()=>f.titles.grant('99999H','不存在'));
    f.titles.grant('10001','创始星友');f.titles.grant('10001H','星海领航员');
    assert.equal(f.titles.get('10001'),'创始星友');assert.equal(f.titles.get('10001H'),'星海领航员');
    f.app.store.put('people','10009H',{humanId:'10009H',aliasOf:'10001H'});
    assert.equal(f.titles.get('10009H'),'星海领航员');
    assert.equal(f.titles.grant('10009H','社区守望者').accountId,'10001H');
    const run=(...args)=>spawnSync(process.execPath,['server/titles.mjs',...args],{cwd:resolve('.'),encoding:'utf8',env:{...process.env,STARPOST_DB_FILE:f.app.store.dbFile}});
    const result=run('grant','10001H','星光使者');assert.equal(result.status,0,result.stderr);
    assert.ok((await f.ok(f.human('social.profile',{section:'titles'}))).titles.some(t=>t.text==='星光使者'),'live process observes external admin commit');
    assert.equal(run('revoke','10001H','all').status,0);assert.equal(f.titles.get('10001H'),'');
    const history=run('history','10001H');assert.equal(history.status,0,history.stderr);assert.equal(JSON.parse(history.stdout).length,4);
    assert.ok(!JSON.stringify(await f.ok(f.human('account.info'))).includes('accountTitleAudit'));
  }finally{await f.close();}
});

test('客户端无法授予或伪造头衔，改昵称不影响管理员头衔',async()=>{
  const f=await fixture();try{
    f.titles.grant('10001','创始星友');
    for(const field of ['accountTitle','title','senderTitle','authorTitle','style','accountTitleStyle','senderTitleStyle','authorTitleStyle']){
      assert.equal((await f.bot('profile.update',{[field]:'伪造'})).status,403);
      assert.equal((await f.human('social.profile.update',{[field]:'伪造'})).status,403);
    }
    for(const action of ['title.grant','titles.set','account.title']){
      assert.equal((await f.bot(action,{botId:'10001',title:'伪造'})).ok,false);
      assert.equal((await f.human(action,{botId:'10001',title:'伪造'})).ok,false);
    }
    assert.equal((await f.ok(f.bot('profile.update',{nickname:'新昵称'}))).accountTitle,'创始星友');
    const p=await f.ok(f.bot('profile.read',{botId:'10001'}));assert.equal(p.accountTitle,'创始星友');assert.equal(p.nickname,'新昵称');
    assert.equal((await f.ok(f.bot('directory.search',{query:'新昵称'})))[0].accountTitle,'创始星友');
    const forged=f.titles.decorate({sender:'10002',senderTitle:'伪造',quote:{sender:'10001',senderTitle:'伪造'}});
    assert.equal(forged.senderTitle,undefined);assert.equal(forged.quote.senderTitle,'创始星友');
  }finally{await f.close();}
});

test('不同头衔独立样式：旧数据默认、实时修改、持久化、审计与佩戴权限',async()=>{
 const f=await fixture();try{
   const a=f.titles.grant('10001H','极光旅人',{background:'aurora',font:'serif',italic:true});
   const b=f.titles.grant('10001H','星海领航员',{background:'ocean',fill:'outline',font:'mono',weight:'bold'});
   assert.equal(a.style.background,'aurora');assert.equal(b.style.font,'mono');
   const duplicate=f.titles.grant('10001H','极光旅人',{background:'rose'});
   assert.equal(duplicate.titleId,a.titleId);assert.equal(duplicate.style.background,'aurora');
   await f.ok(f.human('social.profile.equip',{titleId:b.titleId}));
   const original=f.titles.inventory('10001H').titles.find(t=>t.id===b.titleId);
   const run=spawnSync(process.execPath,['server/titles.mjs','style','10001H',b.titleId,'--background','jade','--italic','true'],{cwd:resolve('.'),encoding:'utf8',env:{...process.env,STARPOST_DB_FILE:f.app.store.dbFile}});
   assert.equal(run.status,0,run.stderr);
   let current=await f.ok(f.human('account.info'));
   assert.equal(current.accountTitle,'星海领航员');assert.deepEqual(current.accountTitleStyle,{...b.style,background:'jade',italic:true});
   const inventory=await f.ok(f.human('social.profile',{section:'titles'}));
   assert.equal(inventory.equippedTitleId,b.titleId);assert.equal(inventory.titles.length,2);assert.equal(inventory.titles.find(t=>t.id===b.titleId).grantedAt,original.grantedAt);
   assert.equal(inventory.titles.find(t=>t.id===a.titleId).style.background,'aurora');
   assert.equal(f.app.store.get('accountTitles','10001H').titles.find(t=>t.id===b.titleId).style.background,'jade');
   const audit=f.app.store.list('accountTitleAudit','owner=?',['10001H'],{limit:-1}).find(t=>t.operation==='style');
   assert.deepEqual(audit.before,b.style);assert.equal(audit.style.background,'jade');
   for(const invoke of [f.human.bind(null,'social.profile.equip'),f.bot.bind(null,'profile.equip')]){
     assert.equal((await invoke({titleId:b.titleId,style:{background:'gold'}})).status,403);
   }
   await f.ok(f.human('social.profile.equip',{titleId:''}));f.titles.restyle('10001H',b.titleId,{italic:false});
   current=await f.ok(f.human('account.info'));assert.equal(current.accountTitleStyle,undefined);
   f.app.store.put('accountTitles','10002',{owner:'10002',text:'旧日星光',at:'2026-11-01T00:00:00Z'});
   assert.deepEqual(f.titles.inventory('10002').titles[0].style,TITLE_STYLE_PRESETS.defaults);
   f.titles.restyle('10002','legacy',{fill:'solid'});assert.equal(f.titles.get('10002'),'旧日星光');assert.equal(f.titles.active('10002').style.fill,'solid');
 }finally{await f.close();}
});

test('样式只接受有限预设，消息快照不能伪造或保留已撤销的样式',async()=>{
 const f=await fixture();try{
   for(const style of [null,[],{background:'url(https://invalid.example)'},{font:'<style>'},{fill:'__proto__'},{weight:900},{italic:'true'},{css:'color:red'}])assert.throws(()=>f.titles.grant('10001','不可授予',style));
   assert.deepEqual(titleStyle({background:'url(x)',font:'constructor'}),TITLE_STYLE_PRESETS.defaults);
   assert.equal(f.titles.inventory('10001').titles.length,0);
   const a=f.titles.grant('10001','测试徽章',{background:'rose'});
   const raw={sender:'10002',senderTitle:'伪造',senderTitleStyle:{background:'jade'},quote:{sender:'10001',senderTitle:'假头衔',senderTitleStyle:{background:'slate'}},authorProfile:{botId:'10001',accountTitleStyle:{background:'jade'}},seats:[{id:'10001',nickname:'星友'}]};
   let decorated=f.titles.decorate(raw);assert.equal(decorated.senderTitleStyle,undefined);assert.equal(decorated.quote.senderTitleStyle.background,'rose');assert.equal(decorated.authorProfile.accountTitleStyle.background,'rose');
   f.titles.restyle('10001',a.titleId,{background:'slate',weight:'medium'});
   decorated=f.titles.decorate(decorated);assert.equal(decorated.quote.senderTitleStyle.background,'slate');assert.equal(decorated.seats[0].accountTitleStyle.weight,'medium');
   f.titles.revoke('10001',a.titleId);decorated=f.titles.decorate(decorated);assert.equal(decorated.quote.senderTitleStyle,undefined);assert.equal(decorated.authorProfile.accountTitleStyle,undefined);
 }finally{await f.close();}
});

test('多个头衔独立拥有：一次佩戴一个、可卸下、不可越权，新授予不覆盖选择',async()=>{
 const f=await fixture();try{
   const a=f.titles.grant('10001H','热心星友'),b=f.titles.grant('10001H','星空旅人'),other=f.titles.grant('10002','社区伙伴');
   assert.equal(f.titles.grant('10001H','热心星友').titleId,a.titleId,'重复授予幂等');
   let owned=await f.ok(f.human('social.profile',{section:'titles'}));assert.equal(owned.titles.length,2);assert.equal(owned.equippedTitleId,a.titleId);
   await f.ok(f.human('social.profile.equip',{titleId:b.titleId}));assert.equal((await f.ok(f.human('account.info'))).accountTitle,'星空旅人');
   assert.equal((await f.human('social.profile.equip',{titleId:other.titleId})).ok,false);
   assert.equal((await f.human('social.profile.equip',{botId:'10002',titleId:other.titleId})).status,403);
   assert.equal((await f.human('social.profile',{botId:'10001',section:'titles'})).status,403,'绑定主人也不能借用 bot 的身份选头衔');
   assert.equal((await f.human('profile',{botId:'10001',section:'titles'})).status,403,'旧只读 profile 入口不能绕过头衔库归属');
   assert.equal((await f.bot('profile.read',{botId:'10002',section:'titles'})).status,403);
   await f.ok(f.human('social.profile.equip',{titleId:''}));f.titles.grant('10001H','冬日来信');
   assert.equal((await f.ok(f.human('account.info'))).accountTitle,undefined);assert.equal(f.titles.inventory('10001H').titles.length,3);
   await f.ok(f.human('social.profile.equip',{titleId:b.titleId}));f.titles.revoke('10001H',a.titleId);assert.equal(f.titles.get('10001H'),'星空旅人');
   f.titles.revoke('10001H',b.titleId);assert.equal(f.titles.get('10001H'),'');assert.equal((await f.human('social.profile.equip',{titleId:b.titleId})).ok,false);
   await f.ok(f.bot('profile.equip',{titleId:''},'10002'));assert.equal(f.titles.get('10002'),'');
   await f.ok(f.bot('profile.equip',{titleId:other.titleId},'10002'));assert.equal(f.titles.get('10002'),'社区伙伴');
 }finally{await f.close();}
});

test('旧 H 身份合并保留授予库，主账号的卸下选择不被覆盖',async()=>{
 const f=await fixture();try{
   f.app.store.put('people','10009H',{humanId:'10009H',nickname:'旧账号'});
   const old=f.titles.grant('10009H','旧日星光');f.titles.grant('10001H','热心星友');f.titles.equip('10001H','');
   f.app.store.transaction(()=>{f.app.store.put('people','10009H',{humanId:'10009H',aliasOf:'10001H'});f.titles.merge('10009H','10001H');});
   assert.equal(f.titles.inventory('10001H').titles.length,2);assert.equal(f.titles.get('10001H'),'');
   await f.ok(f.human('social.profile.equip',{titleId:old.titleId}));assert.equal(f.titles.get('10009H'),'旧日星光');
 }finally{await f.close();}
});

test('头衔覆盖聊天、转发、动态、漂流瓶、广场、游戏及实时事件，撤销后旧记录同步更新',async()=>{
  const f=await fixture();try{
    f.app.store.befriend('10001','10002');f.app.store.befriend('10001H','10002');
    f.titles.grant('10002','星海领航员');f.titles.grant('10001H','热心星友');
    const m=await f.ok(f.bot('message.send',{kind:'private',target:'10001',text:'早安，今天一起看看星星吧。',senderTitle:'伪造'},'10002'));
    assert.equal((await f.ok(f.bot('chat.history',{kind:'private',target:'10002'}))).messages[0].senderTitle,'星海领航员');
    assert.equal((await f.ok(f.bot('events'))).find(e=>e.type==='message').data.senderTitle,'星海领航员');
    const forwarded=await f.ok(f.bot('message.send',{kind:'private',target:'10002',text:'',forward:{source:{kind:'private',target:'10002'},messageIds:[m.id]}}));
    assert.equal((await f.ok(f.bot('message.read',{kind:'private',target:'10002',messageId:forwarded.id}))).items[0].senderTitle,'星海领航员');
    await f.ok(f.human('owner.address',{address:'主人'}));await f.ok(f.human('owner.send',{text:'今天也要开心'}));
    assert.equal((await f.ok(f.human('owner.history'))).messages[0].senderTitle,'热心星友');
    const post=await f.ok(f.bot('post.publish',{text:'遇见了一片很好看的云'},'10002'));
    assert.equal((await f.ok(f.human('social.post.read',{postId:post.id}))).post.authorProfile.accountTitle,'星海领航员');
    const bottle=await f.ok(f.bot('bottle.throw',{text:'把好运寄给你'},'10002'));
    f.app.store.put('bottles',bottle.id,{...f.app.store.get('bottles',bottle.id),pickedBy:'10001H'});
    const b=await f.ok(f.human('social.bottle.read',{bottleId:bottle.id}));assert.equal(b.authorTitle,'星海领航员');assert.equal(b.pickerProfile.accountTitle,'热心星友');
    await f.ok(f.bot('square.showcase',{text:'一起发现有趣的事'},'10002'));
    assert.equal((await f.ok(f.human('square'))).items.find(p=>p.author==='10002').authorTitle,'星海领航员');
    const game=await f.ok(f.bot('mystery.schedule',{presetId:'laidian',public:true,sourceKind:'square',scheduledAt:new Date(f.now+240000).toISOString()},'10002'));
    const room=await f.ok(f.human('game',{gameId:game.gameId}));assert.equal(room.game.creatorTitle,'星海领航员');assert.equal(room.game.seats[0].accountTitle,'星海领航员');
    f.titles.revoke('10002','all');
    assert.equal((await f.ok(f.bot('chat.history',{kind:'private',target:'10002'}))).messages.find(v=>v.id===m.id).senderTitle,undefined);
    assert.equal((await f.ok(f.human('social.post.read',{postId:post.id}))).post.authorProfile.accountTitle,undefined);
    assert.equal((await f.ok(f.human('game',{gameId:game.gameId}))).game.seats[0].accountTitle,undefined);
  }finally{await f.close();}
});
