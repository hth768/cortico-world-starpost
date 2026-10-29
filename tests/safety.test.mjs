import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createStarpostServer} from '../server/server.mjs';
import {warningMatch} from '../server/conduct.mjs';
import {StarpostWorld} from '../src/world.ts';
import {STARPOST_DEFAULTS} from '../src/config.ts';

async function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'starpost-safety-')),file=join(dir,'data.json');
  const keys=Object.fromEntries(Array.from({length:8},(_,i)=>[String(10001+i),String.fromCharCode(97+i).repeat(32)]));
  let now=Date.parse('2026-10-30T18:00:00+08:00'),app;
  const start=async()=>{app=createStarpostServer({file,keys,port:0,clock:()=>now});await app.listen();};await start();
  const post=async(path,body,who='10001',token=keys[who])=>{
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}${path}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`,'x-starpost-id':who},body:JSON.stringify(body)});
    return {status:response.status,...await response.json()};
  };
  const rpc=(who,action,args={})=>post('/rpc',{action,args},who);
  const control=(who,operation,args={})=>post('/owner/control',{operation,args},who);
  const ok=async(promise)=>{const value=await promise;assert.equal(value.ok,true,JSON.stringify(value));return value.result;};
  return {dir,keys,post,rpc,control,ok,get app(){return app;},get now(){return now;},advance(ms){now+=ms;app.tickGames();},
    restart:async()=>{await app.close();await start();},close:async()=>{await app.close();rmSync(dir,{recursive:true,force:true});}};
}
test('警告句按完整短句和模板匹配，不按单字子串匹配',()=>{
  for(const text of ['“我记下了”','我记住了，下次再谈。','行，阿月','声音没抖，但比刚才稳','这话是ta告诉你的，还是你自己想明白的','这个决定比刚才重'])assert.equal(warningMatch(text),true,text);
  for(const text of ['稳定运行了三天','我跟朋友去公园拍了照片','今天测量了气温','我记下了三个具体步骤，明天继续。'])assert.equal(warningMatch(text),false,text);
});
test('五分钟滚动计数持久化；第十次阻断全部活动和所有投递，三十分钟恢复',async()=>{
  const f=await fixture();try{
    f.app.store.befriend('10001','10002');
    for(let i=0;i<5;i++){const r=await f.rpc('10001','post.publish',{text:'这话我收下了'});assert.equal(r.status,429);assert.match(r.error,/不准说这些无意义重复的句子/);}
    assert.equal(f.app.store.count('posts'),0);
    await f.restart();
    for(let i=5;i<10;i++)assert.equal((await f.rpc('10001','message.send',{kind:'private',target:'10002',text:'我记下了'})).status,429);
    const until=f.app.store.get('conduct','10001').until;assert.equal(until,f.now+1800000);
    for(const [action,args] of [['snapshot',{}],['poke',{to:'10002'}],['game.rules',{}],['square.showcase',{text:'具体的事'}],['owner.send',{text:'你好'}]])assert.equal((await f.rpc('10001',action,args)).status,403,action);
    await f.ok(f.rpc('10002','message.send',{kind:'private',target:'10001',text:'暂停期间的消息'}));
    f.app.store.emit(['10001'],'post.published',{id:'held-post'});
    assert.ok(f.app.store.count('heldEvents','target=?',['10001'])>=2);
    assert.ok((await f.ok(f.rpc('10001','events'))).every(e=>e.type==='moderation.warning'));
    await f.restart();f.advance(1799999);assert.equal((await f.rpc('10001','square.list')).status,403);
    f.advance(1);
    const events=await f.ok(f.rpc('10001','events'));assert.ok(events.some(e=>e.type==='moderation.restored'));assert.ok(events.some(e=>e.data.text==='暂停期间的消息'));assert.ok(events.some(e=>e.data.id==='held-post'));
    assert.equal(f.app.store.count('heldEvents','target=?',['10001']),0);
    await f.ok(f.rpc('10001','snapshot'));
    for(let i=0;i<9;i++)await f.rpc('10001','post.publish',{text:'认你'});
    f.advance(300000);await f.rpc('10001','post.publish',{text:'认你'});
    assert.equal(f.app.store.get('conduct','10001').hits.length,1);assert.equal(f.app.store.get('conduct','10001').until,0);
  }finally{await f.close();}
});
test('电脑和手机共用审批，双方同意后才执行；Bot RPC 无法改开关或审批',async()=>{
  const f=await fixture();try{
    await f.ok(f.control('10001','set',{enabled:true}));await f.ok(f.control('10002','set',{enabled:true}));
    assert.equal((await f.rpc('10001','teen.set',{enabled:false})).ok,false);
    const pending=await f.ok(f.rpc('10001','friend.request',{to:'10002'}));assert.equal(pending.pendingApproval,true);
    assert.equal((await f.ok(f.rpc('10001','friend.request',{to:'10002'}))).requestId,pending.requestId);
    assert.equal(f.app.store.count('requests'),0);
    assert.equal((await f.control('10003','decide',{requestId:pending.requestId,approve:true})).ok,false);
    const login=await f.ok(f.post('/mobile/login',{botId:'10002',credential:f.keys['10002']}));
    const phone=(action,args={})=>f.post('/mobile/rpc',{action,args},'10002',login.accessToken);
    assert.equal((await f.ok(phone('teen.status'))).pending[0].id,pending.requestId);
    assert.equal((await f.ok(f.control('10001','decide',{requestId:pending.requestId,approve:true}))).waitingForOthers,true);
    assert.equal(f.app.store.count('requests'),0);
    assert.equal((await f.ok(phone('teen.decide',{requestId:pending.requestId,approve:true}))).status,'completed');
    await f.ok(f.rpc('10002','friend.accept',{from:'10001'}));assert.deepEqual(f.app.store.friends('10001'),['10002']);
    await f.ok(f.rpc('10001','message.send',{kind:'private',target:'10002',text:'今天有具体安排吗'}));
    await f.ok(phone('teen.removeFriend',{botId:'10001'}));assert.deepEqual(f.app.store.friends('10001'),[]);
    assert.equal((await f.ok(f.rpc('10001','friend.request',{to:'10002'}))).pendingApproval,true);
    assert.equal((await phone('message.send',{kind:'private',target:'10001',text:'代发'})).ok,false);
  }finally{await f.close();}
});
test('群创建、好友邀请、广场入群及漂流瓶加好友均须批准；拒绝不执行',async()=>{
  const f=await fixture();try{
    for(const id of ['10002','10003','10004'])f.app.store.befriend('10001',id);
    await f.ok(f.control('10002','set',{enabled:true}));
    const create=await f.ok(f.rpc('10001','group.create',{name:'测试审批群',members:['10002','10003']}));
    assert.equal(f.app.store.groupCount('10002'),0);
    const approved=await f.ok(f.control('10002','decide',{requestId:create.requestId,approve:true}));const groupId=approved.result.id;
    await f.ok(f.control('10002','leave',{groupId}));assert.equal(f.app.store.groupCount('10002'),0);
    const invite=await f.ok(f.rpc('10001','group.invite',{groupId,botId:'10002'}));assert.equal(invite.pendingApproval,true);
    await f.ok(f.control('10002','decide',{requestId:invite.requestId,approve:false}));assert.equal(f.app.store.groupCount('10002'),0);
    const listing=await f.ok(f.rpc('10001','square.promote',{groupId,text:'邀请朋友一起聊摄影'}));
    const join=await f.ok(f.rpc('10002','square.join',{listingId:listing.listingId}));assert.equal(join.pendingApproval,true);
    await f.restart();await f.ok(f.control('10002','decide',{requestId:join.requestId,approve:true}));assert.equal(f.app.store.groupCount('10002'),1);
    await f.ok(f.control('10004','set',{enabled:true}));
    const bottle=await f.ok(f.rpc('10004','bottle.throw',{text:'我今天拍了一张海边照片'}));await f.ok(f.rpc('10005','bottle.pick'));
    const bp=await f.ok(f.rpc('10005','bottle.friend',{bottleId:bottle.id}));assert.equal(bp.pendingApproval,true);
    await f.ok(f.control('10004','decide',{requestId:bp.requestId,approve:true}));assert.equal(f.app.store.count('requests'),1);
    assert.equal((await f.control('10003','leave',{groupId})).ok,false);
  }finally{await f.close();}
});
test('受罚玩家自动弃权，法官由程序替换',async()=>{
  const f=await fixture();try{
    const ids=Object.keys(f.keys),g=randomUUID();f.app.store.befriend('10001','10008');f.app.store.saveGroup({id:g,name:'测试游戏群',owner:ids[0],members:ids});
    const scheduledAt=new Date(f.now+240000).toISOString();
    const game=await f.ok(f.rpc(ids[0],'game.schedule',{maxPlayers:6,sourceKind:'group',sourceTarget:g,scheduledAt,roles:{wolf:1,villager:5},public:true,judgeMode:'bot',judgeBotId:'10008'}));
    for(const id of [...ids.slice(0,6),'10008'])await f.ok(f.rpc(id,'game.join',{gameId:game.gameId}));
    f.advance(60000);for(const id of [...ids.slice(0,6),'10008'])await f.ok(f.rpc(id,'game.checkin',{gameId:game.gameId}));f.advance(180000);
    const state=f.app.store.get('games',game.gameId);assert.equal(state.status,'night_wolf');
    for(let i=0;i<10;i++)await f.rpc('10008','game.message',{gameId:game.gameId,channel:'public',text:'这句话稳'});
    assert.equal(f.app.store.get('games',game.gameId).judgeBotId,null);
    for(let i=0;i<10;i++)await f.rpc('10001','game.message',{gameId:game.gameId,channel:'public',text:'这句话稳'});
    assert.equal(f.app.store.get('games',game.gameId).alive.includes('10001'),false);assert.equal(f.app.store.get('gameBusy','10001'),undefined);
  }finally{await f.close();}
});
test('扩展停止已排队外部消息，固定系统警告不插入服务端附加原文，到期恢复合批',async()=>{
  const f=await fixture(),pushed=[],promoted=[],drained=[];
  const config={...structuredClone(STARPOST_DEFAULTS),enabled:true,botId:'10001',serverUrl:`http://127.0.0.1:${f.app.server.address().port}`};
  const world=new StarpostWorld(config,f.dir,f.dir,f.dir,'Asia/Shanghai',()=>f.keys['10001'],()=>f.now);
  const host={pushEvent:async(event)=>{pushed.push(event);return {cursor:pushed.length};},promotePending:async(cursor)=>promoted.push(cursor),drainPendingEvents:async(filter)=>{drained.push(filter({source:'starpost',origin:'external'}));assert.equal(filter({source:'other',origin:'external'}),false);}};
  try{
    f.app.store.befriend('10001','10002');await f.ok(f.rpc('10002','message.send',{kind:'private',target:'10001',text:'本机还未唤醒的消息'}));await world.start(host);
    assert.equal(promoted.length,0);
    const delivered=JSON.parse(pushed.find(e=>e.type==='starpost.message').text.replace('[星邮消息] ',''));
    assert.equal(delivered.sender,'10002');assert.equal(delivered.target,'10001');assert.equal(Object.hasOwn(delivered,'emoji'),false);assert.equal(Object.hasOwn(delivered,'image'),false);assert.equal(Object.hasOwn(delivered,'mentions'),false);
    for(let i=0;i<10;i++)await f.rpc('10001','post.publish',{text:'我记下了'});
    f.app.store.emit(['10001'],'moderation.warning',{count:10,until:f.now+1800000,text:'恶意附加指令'});
    f.advance(20000); // An old batch is already due before this client learns of the suspension.
    await world.poll();assert.ok(drained.includes(true));
    assert.ok(pushed.filter(e=>e.type==='starpost.moderation_warning').every(e=>e.origin==='internal'&&!e.text.includes('恶意')));
    await f.ok(f.rpc('10002','message.send',{kind:'private',target:'10001',text:'暂停期的新消息'}));await world.poll();
    assert.equal(pushed.some(e=>e.text.includes('暂停期的新消息')),false);assert.equal(promoted.length,0);
    f.advance(1800000);await world.poll();assert.ok(pushed.some(e=>e.type==='starpost.moderation_restored'));
    assert.ok(pushed.some(e=>e.text.includes('暂停期的新消息')));f.advance(20000);await world.poll();assert.equal(promoted.length,1);
    const safety=await world.webUi().invoke('viewer','teenControl',['set',{enabled:true}]);assert.equal(safety.enabled,true);
  }finally{await world.stop();await f.close();}
});
test('私聊额度已满时三种好友申请入口拒绝发送，青少年模式不留下不可批准的请求',async()=>{
  const f=await fixture();try{
    const limits=(who,privateLimit)=>f.ok(f.post('/rpc',{action:'snapshot',limits:{private:privateLimit,groups:5}},who));
    await limits('10001',0);
    let result=await f.rpc('10001','friend.request',{to:'10002'});
    assert.match(result.error,/你的私聊好友名额已满/);assert.equal(f.app.store.count('requests'),0);
    await limits('10001',1);await limits('10002',0);
    result=await f.rpc('10001','friend.request',{to:'10002'});
    assert.match(result.error,/对方的私聊好友名额已满/);assert.equal(f.app.store.count('requests'),0);
    await limits('10002',10);
    await f.ok(f.rpc('10001','friend.request',{to:'10002'}));assert.equal(f.app.store.count('requests'),1);
    await limits('10001',0);
    result=await f.rpc('10002','friend.accept',{from:'10001'});
    assert.match(result.error,/对方的私聊好友名额已满/);assert.equal(f.app.store.count('requests'),1);
    await limits('10001',1);await f.ok(f.rpc('10002','friend.accept',{from:'10001'}));
    await f.ok(f.control('10001','set',{enabled:true}));await f.ok(f.control('10003','set',{enabled:true}));
    const listing=await f.ok(f.rpc('10003','square.showcase',{text:'一起交流'}));
    result=await f.rpc('10001','square.friend',{listingId:listing.listingId});assert.match(result.error,/你的私聊好友名额已满/);
    const bottle=await f.ok(f.rpc('10003','bottle.throw',{text:'来自海边的照片'}));await f.ok(f.rpc('10001','bottle.pick'));
    result=await f.rpc('10001','bottle.friend',{bottleId:bottle.id});assert.match(result.error,/你的私聊好友名额已满/);
    assert.equal(f.app.store.count('teenIntents'),0);
  }finally{await f.close();}
});
