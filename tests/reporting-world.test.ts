import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';
import { STARPOST_DEFAULTS } from '../src/config.ts';
import { STARPOST } from '../src/definition.ts';
import { StarpostWorld } from '../src/world.ts';
import { familyTool } from './tool-invoke.ts';

test('举报与拉黑折叠在 friend 家族，昵称及审核文本走外部事件，通知已声明',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'starpost-report-world-')),key='a'.repeat(32);
  const now=Date.parse('2026-11-07T10:00:00+08:00');
  const app=createStarpostServer({file:join(dir,'data.json'),keys:{10001:key,10002:'b'.repeat(32)},port:0,clock:()=>now});
  await app.listen();app.store.befriend('10001','10002');
  app.store.put('profiles','10002',{nickname:'昵称里的外部内容',bio:'简介',discoverable:true});
  const world=new StarpostWorld({...structuredClone(STARPOST_DEFAULTS),enabled:true,botId:'10001',serverUrl:`http://127.0.0.1:${(app.server.address() as {port:number}).port}`},dir,dir,dir,'Asia/Shanghai',()=>key,()=>now);
  const events:Array<{type:string;origin:string;text:string}>=[];
  try{
    await world.start({pushEvent:async(event:typeof events[number])=>{events.push(event);return {cursor:events.length}},promotePending:async()=>true} as never);
    const tools=world.tools();assert.equal(tools.length,1);assert.equal(tools[0].name,'starpost_use');
    const help=JSON.parse(String(await tools[0].handler({family:'help',action:'show',argsJson:'{"family":"friend"}'},{} as never)));
    for(const action of ['report','reports','block','unblock','blocks','status'])assert.ok(help.parameters.properties.action.enum.includes(action));
    const call=async(args:Record<string,unknown>)=>JSON.parse(String(await familyTool(world,'friend').handler(args,{} as never)));
    const report=await call({action:'report',botId:'10002',reason:'请管理员核实这项行为'});assert.equal(report.status,'pending');
    await call({action:'block',botId:'10002'});
    const list=await call({action:'blocks'});assert.equal(list.count,1);assert.equal(list.delivered,true);assert.doesNotMatch(JSON.stringify(list),/昵称里的/);
    const view=events.find(e=>e.type==='starpost.friend_view'&&e.text.includes('昵称里的外部内容'));assert.equal(view?.origin,'external');
    app.reviewSafetyReport(report.reportId,{decision:'confirmed',outcome:'warning',note:'人工核实，请文明交流'});
    await (world as unknown as {poll():Promise<void>}).poll();
    assert.ok(events.some(e=>e.type==='starpost.safety_notice'&&e.origin==='external'));
    assert.ok(STARPOST.describe.events.some(e=>e.type==='starpost.safety_notice'));
    const reports=await call({action:'reports'});assert.equal(reports.count,1);assert.equal(reports.delivered,true);
    assert.ok(events.some(e=>e.origin==='external'&&e.text.includes('人工核实，请文明交流')));
    await call({action:'unblock',botId:'10002'});assert.equal(app.store.friends('10001').length,0);
  }finally{await world.stop();await app.close();rmSync(dir,{recursive:true,force:true})}
});
