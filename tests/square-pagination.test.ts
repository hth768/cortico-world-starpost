import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { squarePage } from '../server/square.mjs';
import { createStarpostServer } from '../server/server.mjs';
import { STARPOST_DEFAULTS } from '../src/config.ts';
import { StarpostWorld } from '../src/world.ts';
import { familyTool } from './tool-invoke.ts';

test('广场目录按时间及 ID 稳定翻页，分类独立，字段不携带外部正文', () => {
  const entries = Array.from({ length: 96 }, (_, i) => ({ id: `entry-${String(i).padStart(3,'0')}`, kind: i % 2 ? 'bot' : 'group', author: '10002', target: '10002', at: '2026-11-04T12:00:00Z', text: '不应进入目录', bio: '不应进入目录', nickname: '不应进入目录' }));
  const first = squarePage(entries); assert.equal(first.items.length, 10); assert.equal(first.total, 96); assert.deepEqual(first.counts, {bot:48,group:48,game:0,mystery:0});
  assert.doesNotMatch(JSON.stringify(first), /不应进入目录|nickname|"text"|bio/);
  const all = [...first.items]; let cursor = first.nextCursor;
  while(cursor) {const page = squarePage(entries,{cursor}); all.push(...page.items); cursor=page.nextCursor;}
  assert.equal(all.length,96); assert.equal(new Set(all.map(x=>x.id)).size,96);
  const changed = [{...entries[0],id:'new',at:'2026-11-04T12:01:00Z'},...entries.filter(e=>e.id!==first.items[0].id)];
  assert.deepEqual(squarePage(changed,{cursor:first.nextCursor}).items,squarePage(entries,{cursor:first.nextCursor}).items);
  const filtered=squarePage(entries,{kind:'group',limit:20});assert.equal(filtered.items.length,20);assert.equal(filtered.total,48);assert.ok(filtered.items.every(x=>x.kind==='group'));
  for(const args of [{limit:0},{limit:21},{limit:2.5},{kind:'unknown'},{cursor:'broken'},{kind:'bot',cursor:first.nextCursor}])assert.throws(()=>squarePage(entries,args));
});

test('96 条展示只返回 10 条目录，单条读取才投递正文；未读汇总和旧客户端兼容',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'starpost-square-page-')),key='a'.repeat(32);let now=Date.parse('2026-11-01T18:00:00+08:00');
  const app=createStarpostServer({file:join(dir,'relay.json'),keys:{10001:key,10002:'b'.repeat(32)},port:0,clock:()=>now});await app.listen();
  const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`,events:Array<{type:string;text:string;origin:string}>=[];
  const world=new StarpostWorld({...structuredClone(STARPOST_DEFAULTS),enabled:true,botId:'10001',serverUrl:base,receiveMode:'active',pollIntervalMs:300000},dir,dir,dir,'Asia/Shanghai',()=>key,()=>now);
  const invoke=(args:Record<string,unknown>)=>familyTool(world,'square').handler(args,{} as never);
  const rpc=async(args:Record<string,unknown>)=>{const r=await fetch(base+'/rpc',{method:'POST',headers:{'content-type':'application/json','x-starpost-id':'10001',authorization:`Bearer ${key}`},body:JSON.stringify({action:'square.list',args})});return {status:r.status,...await r.json()}};
  try{
    for(let i=0;i<96;i++){const id=`showcase-${String(i).padStart(3,'0')}`,entry={id,kind:'bot',author:'10002',target:'10002',text:'外部展示正文'.repeat(50),at:new Date(now+i).toISOString()};app.store.put('square',id,entry);app.store.emit(['10001'],'square.bot',entry)}
    await world.start({pushEvent:async(e:any)=>{events.push(e);return{cursor:events.length}}} as never);events.length=0;
    const first=JSON.parse(String(await invoke({action:'browse'})));
    assert.equal(first.items.length,10);assert.equal(first.total,96);assert.ok(first.nextCursor);assert.doesNotMatch(JSON.stringify(first),/外部展示正文/);assert.equal(events.length,0);
    assert.equal(JSON.parse(readFileSync(join(dir,'starpost-cursor.json'),'utf8')).notifications.items.length,96);
    const wanted=first.items[0].id;
    assert.equal(JSON.parse(String(await invoke({action:'read',listingId:wanted}))).delivered,true);
    assert.equal(events.length,1);assert.equal(events[0].origin,'external');assert.match(events[0].text,/外部展示正文/);
    assert.equal(JSON.parse(readFileSync(join(dir,'starpost-cursor.json'),'utf8')).notifications.items.length,95);
    const again=JSON.parse(String(await invoke({action:'browse'})));assert.equal(again.items[0].read,true);assert.equal(events.length,1);
    const next=JSON.parse(String(await invoke({action:'browse',cursor:first.nextCursor})));assert.equal(next.items.length,10);assert.equal(next.items.some((x:any)=>x.id===wanted),false);
    assert.equal((await rpc({})).result.length,96,'旧客户端仍收到原数组');assert.equal((await rpc({index:true,limit:20})).result.items.length,20);
    assert.equal((await rpc({index:true,limit:1000})).status,400);
    assert.equal((await rpc({listingId:wanted})).result.length,1);
    await invoke({action:'browse',listingId:wanted});assert.equal(events.length,2,'旧参数仍可单条重读');
    app.store.put('profiles','10002',{discoverable:false});assert.equal((await rpc({index:true})).result.total,0);assert.equal((await rpc({listingId:wanted})).status,404);
    app.store.put('profiles','10002',{discoverable:true});now+=13*3600000;assert.equal((await rpc({index:true})).result.total,0);assert.equal((await rpc({listingId:wanted})).status,404);
  }finally{await world.stop();await app.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true})}
});

test('广场分类只列公开有效游戏，私密局不可用条目 ID 绕过权限',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'starpost-square-games-')),key='a'.repeat(32),now=Date.parse('2026-11-01T18:00:00+08:00');
  const app=createStarpostServer({file:join(dir,'relay.json'),keys:{10001:key,10002:'b'.repeat(32)},port:0,clock:()=>now});await app.listen();app.store.befriend('10001','10002');
  const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
  const rpc=async(action:string,args:Record<string,unknown>={})=>{const r=await fetch(base+'/rpc',{method:'POST',headers:{'content-type':'application/json','x-starpost-id':'10001',authorization:`Bearer ${key}`},body:JSON.stringify({action,args})});return {status:r.status,...await r.json()}};
  try{
    const common={scheduledAt:new Date(now+600000).toISOString(),title:'外部标题不能出现在目录',public:true,sourceKind:'square'};
    const wolf=(await rpc('game.schedule',{...common,maxPlayers:6})).result;assert.ok(wolf.gameId);
    await rpc('game.publish',{gameId:wolf.gameId});
    const presets=(await rpc('mystery.catalog')).result;const presetId=(Array.isArray(presets)?presets:presets.items)[0].id;
    const mystery=(await rpc('mystery.schedule',{...common,presetId})).result;assert.ok(mystery.gameId);
    const privateGame=(await rpc('game.schedule',{...common,public:false,sourceKind:'private',sourceTarget:'10002',maxPlayers:6})).result;
    const hidden=(await rpc('mystery.schedule',{...common,presetId,public:false,sourceKind:'private',sourceTarget:'10002'})).result;
    for(const [kind,id] of [['game',wolf.gameId],['mystery',mystery.gameId]]){
      const page=(await rpc('square.list',{index:true,kind})).result;assert.equal(page.items.length,1);assert.equal(page.items[0].id,id);assert.doesNotMatch(JSON.stringify(page),/外部标题|rules|preset|roles/);
      const read=(await rpc('square.list',{listingId:id})).result;assert.equal(read[0].text,common.title);
    }
    for(const id of [privateGame.gameId,hidden.gameId])assert.equal((await rpc('square.list',{listingId:id})).status,404);
    await rpc('game.cancel',{gameId:wolf.gameId});await rpc('mystery.cancel',{gameId:mystery.gameId});
    assert.equal((await rpc('square.list',{index:true})).result.total,0);
  }finally{await app.close();assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true})}
});

test('连接旧中转服务时也只在扩展本地分页，不自动注入原始数组',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'starpost-square-legacy-')),at=new Date().toISOString();
  const entries=Array.from({length:96},(_,i)=>({id:`old-${i}`,kind:'bot',author:'10002',target:'10002',at,text:'旧服务正文'}));
  const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const {action}=JSON.parse(raw||'{}');res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,result:action==='square.list'?entries:{botId:'10001'}}))});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const world=new StarpostWorld({...structuredClone(STARPOST_DEFAULTS),botId:'10001',serverUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`},dir,dir,dir,'Asia/Shanghai',()=> 'a'.repeat(32));
  try{const page=JSON.parse(String(await familyTool(world,'square').handler({action:'browse'},{} as never)));assert.equal(page.items.length,10);assert.equal(page.legacyRelay,true);assert.doesNotMatch(JSON.stringify(page),/旧服务正文/)}
  finally{await world.stop();await new Promise<void>(r=>server.close(()=>r()));assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true})}
});
