import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStarpostServer} from '../server/server.mjs';
import {STARPOST_DEFAULTS} from '../src/config.ts';
import {StarpostWorld} from '../src/world.ts';
import {familyTool} from './tool-invoke.ts';

test('成就条件仍折叠在profile按需读取，不增加前缀或成就唤醒；自动头衔可由bot自行佩戴',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'starpost-achievement-world-')),key='a'.repeat(32),now=Date.parse('2026-11-07T18:00:00+08:00');
 const app=createStarpostServer({file:join(dir,'db.json'),keys:{10001:key,10002:'b'.repeat(32)},port:0,clock:()=>now});await app.listen();app.store.befriend('10001','10002');
 const world=new StarpostWorld({...structuredClone(STARPOST_DEFAULTS),enabled:true,botId:'10001',serverUrl:`http://127.0.0.1:${(app.server.address() as {port:number}).port}`},dir,dir,dir,'Asia/Shanghai',()=>key,()=>now);
 const events:any[]=[];try{
  await world.start({pushEvent:async(event:any)=>{events.push(event);return {cursor:events.length};}} as never);
  assert.equal(world.tools().length,1);assert.equal(readFileSync('src/ENV_PROMPT.md','utf8').includes('常胜将军'),false);
  const send=familyTool(world,'send');await send.handler({action:'send',kind:'private',target:'10002',text:'今天一起看看星空。'},{} as never);
  assert.equal(events.some(e=>String(e.type).includes('achievement')),false);
  const profile=familyTool(world,'profile');await profile.handler({action:'read',section:'achievements'},{} as never);
  const view=events.filter(e=>e.type==='starpost.profile_view').at(-1);assert.equal(view.origin,'external');assert.ok(view.text.includes('话痨'));assert.ok(view.text.includes('狼人杀常胜将军'));
  await profile.handler({action:'read',section:'titles'},{} as never);
  const inv=JSON.parse(events.filter(e=>e.type==='starpost.profile_view').at(-1).text.replace(/^\[星邮个人资料\] /,''));
  assert.equal(inv.equippedTitleId,'');const title=inv.titles.find((t:any)=>t.achievementId==='first-message');assert.ok(title);
  const worn=JSON.parse(String(await profile.handler({action:'equip',titleId:title.id},{} as never)));assert.equal(worn.equippedTitleId,title.id);
  assert.equal(app.store.count('accountTitleAudit',"json_extract(data,'$.source')='achievement'"),1);
 }finally{await world.stop();await app.close();rmSync(dir,{recursive:true,force:true});}
});
