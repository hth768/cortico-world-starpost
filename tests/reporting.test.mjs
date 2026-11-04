import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-safety-'));
  let now = Date.parse('2026-11-07T10:00:00+08:00');
  const keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32), 10003: 'c'.repeat(32) };
  const mails=[];
  const app = createStarpostServer({ file: join(dir, 'data.json'), keys, port: 0, clock: () => now, sendMail:async m=>mails.push(m) });
  await app.listen();
  app.store.befriend('10001', '10002');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const rpc = async (who, action, args = {}) => {
    const response = await fetch(base + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keys[who]}`, 'x-starpost-id': who }, body: JSON.stringify({ action, args }) });
    return { status: response.status, ...await response.json() };
  };
  const post=async(path,body,headers={})=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return {status:r.status,headers:r.headers,...await r.json()};};
  const register=async email=>{const v=await post('/mobile/auth',{action:'code',purpose:'register',email});assert.equal(v.ok,true,v.error);const result=await post('/mobile/auth',{action:'register',email,nickname:'测试访客',password:'test-password-123',challengeId:v.result.challengeId,code:mails.at(-1).code});assert.equal(result.ok,true,result.error);return result.result;};
  const phone=(token,action,args={})=>post('/mobile/rpc',{action,args},{authorization:`Bearer ${token}`});
  return { dir,app, rpc, phone,post,register,base,keys,advance: ms => { now += ms; }, close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('举报必填具体原因，服务端取证、去重与账号隔离，撤回后证据保留且不会自动处罚', async () => {
  const f = await fixture();
  try {
    const sent = await f.rpc('10002', 'message.send', { kind: 'private', target: '10001', text: '这是用于验证举报证据保存的原始发言。' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const evidence = { type: 'message', id: sent.result.id, kind: 'private', target: '10002' };
    assert.equal((await f.rpc('10001', 'safety.report', { botId: '10002', reason: '  ', evidence })).status, 400);
    assert.equal((await f.rpc('10001', 'safety.report', { botId: '10003', reason: '冒充证据作者', evidence })).status, 400);
    assert.equal((await f.rpc('10003', 'safety.report', { botId: '10002', reason: '试图查看私聊', evidence })).status, 403);
    const submitted = await f.rpc('10001', 'safety.report', { botId: '10002', reason: '这条消息涉嫌骚扰，请人工核实上下文。', evidence, owner: '10003', status: 'confirmed' });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.equal(submitted.result.status, 'pending');
    const record = f.app.store.get('safetyReports', submitted.result.reportId);
    assert.equal(record.owner, '10001'); assert.equal(record.evidence.text, '这是用于验证举报证据保存的原始发言。');
    assert.equal((await f.rpc('10001', 'safety.report', { botId: '10002', reason: '重复提交', evidence })).result.reportId, record.id);
    assert.equal((await f.rpc('10003', 'safety.reports')).result.items.length, 0);
    assert.equal((await f.rpc('10001', 'safety.reports')).result.items[0].id, record.id);
    assert.equal((await f.rpc('10002', 'message.recall', { kind: 'private', target: '10001', messageId: sent.result.id })).ok, true);
    assert.equal(f.app.store.get('safetyReports', record.id).evidence.text, record.evidence.text);
    assert.equal(f.app.store.get('conduct', '10002'), undefined);
    assert.equal((await f.rpc('10001', 'safety.review', { reportId: record.id, approve: true })).ok, false, '普通账号没有审核接口');
    assert.equal((await f.rpc('10001', 'safety.report', { botId: '10001', reason: '不能举报自己' })).ok, false);
  } finally { await f.close(); }
});

test('拉黑阻断双方直接互动和旧待投递消息，历史可读，共同群聊保留，解除不自动恢复好友',async()=>{
  const f=await fixture();try{
    const message=(await f.rpc('10002','message.send',{kind:'private',target:'10001',text:'拉黑前的聊天原文'})).result;
    const pending={recipient:'10001',data:{id:'deferred',kind:'private',sender:'10002',target:'10001',text:'尚未投递'},at:new Date().toISOString()};
    f.app.store.put('deferredChat','deferred',pending);f.app.store.put('heldEvents','held',{...pending,type:'message'});
    f.app.store.put('groups','shared',{id:'shared',name:'共同群',owner:'10003',members:['10001','10002','10003'],admins:[]});
    const bottle=(await f.rpc('10002','bottle.throw',{text:'来自即将拉黑账号的瓶子'})).result.id;
    const block=await f.rpc('10001','safety.block',{botId:'10002'});assert.equal(block.ok,true,block.error);
    assert.deepEqual(f.app.store.friends('10001'),[]);assert.equal(f.app.store.get('deferredChat','deferred'),undefined);assert.equal(f.app.store.get('heldEvents','held'),undefined);
    assert.ok((await f.rpc('10001','events')).result.every(e=>e.type!=='message'));
    for(const [a,b] of [['10001','10002'],['10002','10001']]){
      assert.equal((await f.rpc(a,'friend.request',{to:b})).status,403);
      assert.equal((await f.rpc(a,'message.send',{kind:'private',target:b,text:'不应送达'})).status,403);
      assert.equal((await f.rpc(a,'poke',{to:b,groupId:'shared'})).status,403);
    }
    assert.equal((await f.rpc('10001','bottle.pick')).result.bottle,null);assert.equal(f.app.store.get('bottles',bottle).pickedBy,null);
    const history=await f.rpc('10001','chat.history',{kind:'private',target:'10002'});assert.equal(history.result.messages[0].id,message.id);
    assert.equal((await f.rpc('10003','chat.history',{kind:'private',target:'10002'})).status,403);
    assert.equal((await f.rpc('10002','message.send',{kind:'group',target:'shared',text:'共同群中的正常消息仍然可见'})).ok,true);
    assert.equal((await f.rpc('10001','safety.blocks')).result.items[0].hasHistory,true);
    await f.rpc('10002','safety.block',{botId:'10001'});await f.rpc('10001','safety.unblock',{botId:'10002'});
    assert.equal((await f.rpc('10001','friend.request',{to:'10002'})).status,403,'对方仍拉黑时，单方面解除不会恢复互动');
    await f.rpc('10002','safety.unblock',{botId:'10001'});
    assert.deepEqual(f.app.store.friends('10001'),[]);
    assert.equal((await f.rpc('10001','friend.request',{to:'10002'})).ok,true);
  }finally{await f.close()}
});

test('人工审核仅本地授权入口可操作，警告与禁言明确生效，到期恢复且不重复处罚',async()=>{
  const f=await fixture();try{
    const r=(await f.rpc('10001','safety.report',{botId:'10002',reason:'请审核该账号交流行为'})).result.reportId;
    assert.throws(()=>f.app.reviewSafetyReport(r,{decision:'confirmed',outcome:'mute',minutes:30,note:''}),/审核说明/);
    assert.equal(f.app.store.get('safetyReports',r).status,'pending');
    f.app.reviewSafetyReport(r,{decision:'confirmed',outcome:'mute',minutes:30,note:'人工核实后，禁言三十分钟。'});
    const until=(await f.rpc('10002','safety.status')).result.mutedUntil;assert.ok(until>0);
    assert.equal((await f.rpc('10002','message.send',{kind:'private',target:'10001',text:'禁言期发言'})).status,403);
    assert.equal((await f.rpc('10002','bottle.throw',{text:'尝试绕过禁言'})).status,403);
    assert.equal((await f.rpc('10002','chat.history',{kind:'private',target:'10001'})).ok,true);
    assert.equal((await f.rpc('10002','safety.report',{botId:'10003',reason:'禁言期间仍可提交举报'})).ok,true);
    assert.throws(()=>f.app.reviewSafetyReport(r,{decision:'confirmed',outcome:'mute',minutes:60,note:'重复处罚'}),/已经审核/);
    assert.equal((await f.rpc('10002','safety.status')).result.mutedUntil,until);
    const result=(await f.rpc('10001','safety.reports')).result.items[0];assert.equal(result.status,'confirmed');assert.match(result.reviewNote,/三十分钟/);
    assert.equal((await f.rpc('10003','safety.status')).result.notices.length,0);
    f.advance(30*60000);
    assert.equal((await f.rpc('10002','message.send',{kind:'private',target:'10001',text:'期限到了，恢复正常交流。'})).ok,true);
    const next=(await f.rpc('10001','safety.report',{botId:'10002',reason:'另一个待审核事项'})).result.reportId;
    f.app.reviewSafetyReport(next,{decision:'dismissed',note:'证据不足，未作处罚。'});
    assert.equal((await f.rpc('10002','safety.status')).result.mutedUntil,0);
  }finally{await f.close()}
});

test('手机与网页以人类自己的身份举报拉黑，不冒用绑定 bot；证据与禁言按人类账号隔离',async()=>{
  const f=await fixture();try{
    const a=await f.register('safety-a@example.com'),b=await f.register('safety-b@example.com');
    f.app.store.befriend(a.humanId,b.humanId);
    const bound=await f.phone(a.accessToken,'account.bind',{botId:'10001',credential:f.keys[10001]});assert.equal(bound.ok,true,bound.error);
    const sent=(await f.phone(b.accessToken,'social.message.send',{kind:'private',target:a.humanId,text:'人类间的聊天证据'})).result.id;
    const report=await f.phone(a.accessToken,'safety.report',{botId:b.humanId,reason:'人工核实这段人类发言',evidence:{type:'message',id:sent,kind:'private',target:b.humanId}});
    assert.equal(report.ok,true,report.error);assert.equal(f.app.store.get('safetyReports',report.result.reportId).owner,a.humanId);
    assert.equal((await f.phone(a.accessToken,'safety.report',{botId:'10002',reason:'试图借用未绑定bot取证',evidence:{type:'message',id:sent,kind:'private',target:b.humanId,viewerBotId:'10003'}})).status,403);
    const login=await f.post('/web/auth',{action:'login',method:'password',email:'safety-a@example.com',password:'test-password-123'},{origin:f.base});
    const web=(action,args={})=>f.post('/web/rpc',{action,args},{origin:f.base,cookie:login.headers.get('set-cookie').split(';')[0]});
    assert.equal((await web('safety.reports')).result.items[0].id,report.result.reportId);
    assert.equal((await web('safety.block',{botId:b.humanId})).ok,true);
    assert.equal((await f.phone(a.accessToken,'safety.blocks')).result.items[0].botId,b.humanId);
    assert.equal((await f.rpc('10001','safety.blocks')).result.items.length,0,'人类操作不修改自己的 bot 黑名单');
    assert.equal((await f.phone(a.accessToken,'safety.block',{botId:'10001'})).ok,false,'自家专属频道不会被误拉黑');
    f.app.reviewSafetyReport(report.result.reportId,{decision:'confirmed',outcome:'mute',minutes:2,note:'测试人工禁言效果'});
    assert.equal((await f.phone(b.accessToken,'social.post.publish',{text:'不能绕过禁言发动态'})).status,403);
    assert.equal((await f.phone(a.accessToken,'social.post.publish',{text:'其他账号仍然可以正常发言'})).ok,true);
    assert.equal((await f.phone(b.accessToken,'account.info')).result.safety.notices.length,1);
  }finally{await f.close()}
});

test('拉黑取消跨人类及青少年模式的待审批申请，旧审批不能恢复关系',async()=>{
  const f=await fixture();try{
    const owner=await f.register('owner@example.com'),peer=await f.register('peer@example.com');
    await f.phone(owner.accessToken,'account.bind',{botId:'10001',credential:f.keys[10001]});
    const request=await f.rpc('10001','friend.request',{to:peer.humanId});assert.equal(request.result.pendingApproval,true);
    await f.phone(peer.accessToken,'safety.block',{botId:'10001'});
    const decided=await f.phone(owner.accessToken,'account.decide',{requestId:request.result.requestId,approve:true});assert.equal(decided.result.status,'cancelled');
    assert.equal(f.app.store.count('requests'),0);
    const control=(operation,args)=>f.post('/owner/control',{operation,args},{authorization:`Bearer ${f.keys[10003]}`,'x-starpost-id':'10003'});
    assert.equal((await control('set',{enabled:true})).ok,true);
    const teen=await f.rpc('10003','friend.request',{to:'10002'});assert.equal(teen.result.pendingApproval,true);
    const listing=await f.rpc('10002','square.showcase',{text:'一起认识新朋友'});assert.equal(listing.ok,true);
    const square=await f.rpc('10003','square.friend',{listingId:listing.result.listingId});assert.equal(square.result.pendingApproval,true);
    await f.rpc('10002','safety.block',{botId:'10003'});
    assert.equal((await control('decide',{requestId:teen.result.requestId,approve:true})).result.status,'cancelled');
    assert.equal((await control('decide',{requestId:square.result.requestId,approve:true})).result.status,'cancelled');
    assert.equal((await f.rpc('10003','square.friend',{listingId:listing.result.listingId})).status,403);
    assert.equal(f.app.store.friends('10003').length,0);
  }finally{await f.close()}
});

test('游戏取证沿用频道权限，参赛人类不能借取证进入全知视角，共同游戏不受拉黑影响',async()=>{
  const f=await fixture();try{
    const owner=await f.register('watcher@example.com');
    await f.phone(owner.accessToken,'account.bind',{botId:'10001',credential:f.keys[10001]});
    const id=randomUUID(),players=['10001','10002',owner.humanId];
    f.app.store.put('games',id,{id,title:'私密对局',creator:'10001',judgeMode:'program',judgeBotId:null,status:'day',day:1,participants:players,joined:players,checkedIn:players,invited:players,alive:players,rules:{},uses:{},roles:{10001:'villager',10002:'wolf',[owner.humanId]:'villager'},maxPlayers:6,public:false,published:false});
    const save=(messageId,channel)=>f.app.store.put('gameMessages',messageId,{id:messageId,gameId:id,sender:'10002',kind:'chat',channel,recipients:['10002'],text:channel==='wolf'?'仅狼人有权读取':'公共讨论内容',at:new Date().toISOString()});
    save('secret','wolf');save('public','public');
    const evidence=messageId=>({type:'game',id:messageId,gameId:id});
    assert.equal((await f.rpc('10001','safety.report',{botId:'10002',reason:'不能读取隐藏狼人消息',evidence:evidence('secret')})).status,403);
    assert.equal((await f.rpc('10003','safety.report',{botId:'10002',reason:'无权进入私密对局',evidence:evidence('public')})).status,403);
    assert.equal((await f.phone(owner.accessToken,'safety.report',{botId:'10002',reason:'绑定主人的合法观战证据',evidence:{...evidence('secret'),viewerBotId:'10001'}})).ok,true);
    f.app.store.put('humanGameLock',owner.humanId.slice(0,-1),{gameId:id});
    assert.equal((await f.phone(owner.accessToken,'safety.report',{botId:'10002',reason:'参赛时不能切换视角',evidence:{...evidence('secret'),viewerBotId:'10001'}})).status,403);
    assert.equal((await f.phone(owner.accessToken,'safety.report',{botId:'10002',reason:'不能读自己不可见的频道',evidence:evidence('secret')})).status,403);
    assert.equal((await f.phone(owner.accessToken,'safety.report',{botId:'10002',reason:'公共发言可以举报',evidence:evidence('public')})).ok,true);
    await f.rpc('10001','safety.block',{botId:'10002'});
    assert.equal((await f.rpc('10001','game.read',{gameId:id})).result.messages.some(m=>m.id==='public'),true);
  }finally{await f.close()}
});

test('管理员命令在服务运行时原子审核，数据可重读，旧 H 账号合并不能逃避禁言',async()=>{
  const f=await fixture();try{
    const r=(await f.rpc('10001','safety.report',{botId:'10002H',reason:'请审核这个旧人类账号'})).result.reportId;
    const file=join(f.dir,'decision.json');writeFileSync(file,JSON.stringify({decision:'confirmed',outcome:'mute',minutes:30,note:'核实后禁言三十分钟'}));
    const run=(...args)=>spawnSync(process.execPath,['server/reports.mjs',...args],{cwd:new URL('..',import.meta.url),encoding:'utf8',env:{...process.env,STARPOST_DB_FILE:f.app.store.dbFile}});
    const listed=run('list');assert.equal(listed.status,0,listed.stderr);assert.equal(JSON.parse(listed.stdout).items[0].id,r);
    const reviewed=run('review',r,file);assert.equal(reviewed.status,0,reviewed.stderr);assert.equal(JSON.parse(reviewed.stdout).status,'confirmed');
    assert.equal(JSON.parse(run('read',r).stdout).outcome,'mute');assert.notEqual(run('review',r,file).status,0);
    const until=f.app.store.get('safetyMutes','10002H').until;
    f.advance(until-30*60000-Date.parse('2026-11-07T10:00:00+08:00'));
    const person=await f.register('merged@example.com');
    const bind=await f.phone(person.accessToken,'account.bind',{botId:'10002',credential:f.keys[10002]});assert.equal(bind.ok,true,bind.error);
    assert.equal(f.app.store.get('safetyMutes',person.humanId).until,until);
    assert.equal(f.app.store.get('safetyReports',r).target,person.humanId);
    assert.equal((await f.phone(person.accessToken,'social.post.publish',{text:'换绑邮箱后仍在禁言期'})).status,403);
  }finally{await f.close()}
});
