import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStarpostServer } from '../server/server.mjs';

async function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'starpost-game-weekend-'));
  let now=Date.parse('2026-10-30T18:00:00+08:00');
  const ids=Array.from({length:6},(_,i)=>String(10001+i)), keys=Object.fromEntries(ids.map(id=>[id,id.repeat(8)]));
  const app=createStarpostServer({file:join(dir,'data.json'),keys,port:0,clock:()=>now});await app.listen();
  const groupId=randomUUID();app.store.saveGroup({id:groupId,owner:ids[0],members:ids,name:'周末测试群'});
  const post=async(path,body,headers={})=>{const r=await fetch(`http://127.0.0.1:${app.server.address().port}${path}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return r.json()};
  const rpc=(who,action,args={})=>post('/rpc',{action,args},{'x-starpost-id':who,authorization:`Bearer ${keys[who]}`});
  const ok=async promise=>{const r=await promise;assert.equal(r.ok,true,r.error);return r.result};
  return {app,ids,keys,groupId,rpc,post,ok,set:t=>{now=Date.parse(t);app.tickGames()},close:async()=>{await app.close();rmSync(dir,{recursive:true,force:true})}};
}
for(const family of ['game','mystery'])test(`${family} 按预约目标的北京时间判断周末，周一恢复限制且规则可查`,async()=>{
  const f=await fixture();try{
    for(const [scheduledAt,allowed] of [
      ['2026-10-30T15:59:00Z',true],['2026-10-30T16:00:00Z',true],
      ['2026-10-31T01:00:00+08:00',true],['2026-10-31T09:00:00+08:00',true],['2026-10-31T14:00:00+08:00',true],
      ['2026-11-01T01:00:00+08:00',true],['2026-11-01T09:00:00+08:00',true],['2026-11-01T14:00:00+08:00',true],
      ['2026-11-01T15:59:00Z',true],['2026-11-01T16:00:00Z',false],
      ['2026-11-02T09:00:00+08:00',false],['2026-11-02T14:00:00+08:00',false],['2026-11-02T06:00:00+08:00',true],
    ]){
      const r=await f.rpc('10001',`${family}.schedule`,{scheduledAt,maxPlayers:6,presetId:'laidian',sourceKind:'group',sourceTarget:f.groupId});
      assert.equal(r.ok,allowed,`${family} ${scheduledAt}: ${r.error}`);
      if(allowed)await f.ok(f.rpc('10001',`${family}.cancel`,{gameId:r.result.gameId}));else assert.match(r.error,/周六、周日全天/);
    }
    const rules=await f.ok(f.rpc('10001',`${family}.rules`,{section:'protocol'}));
    assert.match(JSON.stringify(rules),/周六、周日全天/);
    if(family==='game'){assert.equal(rules.dailyLimit,5);assert.equal(rules.usedToday,0);assert.deepEqual(rules.weekendStartWindows,['00:00–24:00'])}
  }finally{await f.close()}
});
for(const family of ['game','mystery'])test(`${family} 实际开局周末不取消，延误至周一凌晨才取消`,async()=>{
  for(const [before,scheduledAt,actual,expected] of [
    ['2026-10-31T08:55:00+08:00','2026-10-31T08:59:00+08:00','2026-10-31T09:00:00+08:00',family==='game'?'night_wolf':'active'],
    ['2026-11-01T23:55:00+08:00','2026-11-01T23:59:00+08:00','2026-11-02T00:00:00+08:00','cancelled'],
  ]){
    const f=await fixture();try{
      f.set(before);const game=await f.ok(f.rpc('10001',`${family}.schedule`,{scheduledAt,maxPlayers:6,presetId:'laidian',sourceKind:'group',sourceTarget:f.groupId}));
      for(const who of family==='mystery'?f.ids.slice(1):f.ids)await f.ok(f.rpc(who,`${family}.join`,{gameId:game.gameId}));
      f.set(new Date(Date.parse(scheduledAt)-180000).toISOString());
      for(const who of f.ids)await f.ok(f.rpc(who,`${family}.checkin`,{gameId:game.gameId}));
      f.set(actual);assert.equal(f.app.store.get(family==='game'?'games':'mysteryGames',game.gameId).status,expected);
      if(family==='game')assert.equal((await f.ok(f.rpc('10001','game.rules'))).usedToday,expected==='cancelled'?0:1);
    }finally{await f.close()}
  }
});
test('手机/网页的人类预约同样可预约周末凌晨，工作日仍受限',async()=>{
 const f=await fixture();try{
  const login=await f.ok(f.post('/mobile/login',{botId:'10001',credential:f.keys['10001']}));
  const phone=(action,args)=>f.post('/mobile/rpc',{action,args},{authorization:`Bearer ${login.accessToken}`});
  const game=await f.ok(phone('human.schedule',{title:'周末人类预约',scheduledAt:'2026-11-01T01:00:00+08:00',maxPlayers:6,public:true}));
  await f.ok(phone('human.cancel',{gameId:game.gameId}));
  const invalid=await phone('human.schedule',{title:'周一人类预约',scheduledAt:'2026-11-02T01:00:00+08:00',maxPlayers:6,public:true});
  assert.equal(invalid.ok,false);assert.match(invalid.error,/周六、周日全天/);
 }finally{await f.close()}
});
