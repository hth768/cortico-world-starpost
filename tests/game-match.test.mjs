import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStarpostServer } from '../server/server.mjs';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-match-')), file = join(dir, 'state.json');
  let now = Date.parse('2026-11-01T18:00:00+08:00');
  const ids = Array.from({ length: 24 }, (_, i) => String(10001 + i)), keys = Object.fromEntries(ids.map(id => [id, id.repeat(8)]));
  const make = () => createStarpostServer({ file, keys, port: 0, clock: () => now });
  let app = make(); await app.listen();
  const post = async (path, body, headers = {}) => {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify(body) });
    return { status: res.status, headers: res.headers, ...await res.json() };
  };
  const rpc = (who, action, args = {}) => post('/rpc', { action, args }, { 'x-starpost-id': who, authorization: `Bearer ${keys[who]}` });
  const ok = async promise => { const r = await promise; assert.equal(r.ok, true, r.error); return r.result; };
  async function human(who, transport = 'mobile') {
    const login = await post(`/${transport}/login`, { botId: who, credential: keys[who] });
    const result = await ok(login), headers = transport === 'web' ? { cookie: login.headers.get('set-cookie').split(';')[0] } : { authorization: `Bearer ${result.accessToken}` };
    return (action, args = {}) => post(`/${transport}/rpc`, { action, args }, headers);
  }
  const full = (family = 'game', who = ids[0], extra = {}) => ok(rpc(who, `${family}.schedule`, { startMode: 'full', public: true, sourceKind: 'square', maxPlayers: 6, presetId: 'laidian', ...extra }));
  const seed = (extra = {}) => {
    const id = randomUUID(), players = ids.slice(0, 8), roleList = ['wolf','wolf','seer','witch','guard','hunter','villager','villager'];
    app.store.put('games', id, { id, title: '阶段推进', creator: ids[0], status: 'night_wolf', scheduledAt: new Date(now).toISOString(), startedAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + 180000).toISOString(), public: false, judgeMode: 'program', judgeBotId: null, maxPlayers: 8, invited: [], joined: players, participants: players, checkedIn: players, alive: players,
      roles: Object.fromEntries(players.map((who,i) => [who,roleList[i]])), uses: Object.fromEntries(players.map(who => [who,{save:false,poison:false,shot:false}])), rules: {}, night: {}, votes: {}, day: 1, ...extra });
    return id;
  };
  return { get app() { return app; }, get now() { return now; }, ids, rpc, ok, human, full, seed,
    set: value => { now = typeof value === 'number' ? value : Date.parse(value); app.tickGames(); },
    restart: async () => { await app.close(); app = make(); await app.listen(); },
    close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

for (const family of ['game','mystery']) test(`${family} 人满就开为公开可选设置，仍保留定时预约，最后一席立即开局且不能超员`, async () => {
  const f = await fixture(); try {
    assert.equal((await f.rpc('10001', `${family}.schedule`, { startMode: 'full', public: false, sourceKind: 'square', maxPlayers: 6, presetId: 'laidian' })).ok, false);
    const scheduled = await f.ok(f.rpc('10024', `${family}.schedule`, { scheduledAt: new Date(f.now+600000).toISOString(), public: true, sourceKind: 'square', maxPlayers: 6, presetId: 'laidian' }));
    assert.equal(scheduled.startMode, 'scheduled');
    const g = await f.full(family), collection = family === 'game' ? 'games' : 'mysteryGames';
    assert.equal(g.startMode, 'full'); assert.equal(g.scheduledAt, null); assert.equal(f.app.store.get(collection,g.gameId).published,true);
    for (const who of f.ids.slice(1,5)) await f.ok(f.rpc(who, `${family}.join`, { gameId:g.gameId }));
    assert.equal(f.app.store.get(collection,g.gameId).status,'scheduled');
    const results = await Promise.all(f.ids.slice(5,8).map(who => f.rpc(who, `${family}.join`, { gameId:g.gameId })));
    assert.equal(results.filter(r => r.ok).length,1);
    const live = f.app.store.get(collection,g.gameId);
    assert.equal(live.status,family === 'game' ? 'night_wolf' : 'active'); assert.equal(live.joined.length,6);
    assert.equal(live.startedAt,new Date(f.now).toISOString());
    assert.equal(f.app.store.get(collection,scheduled.gameId).status,'scheduled','原定时局不受影响');
    if(family==='game') assert.equal((await f.ok(f.rpc('10001','game.rules'))).usedToday,1);
  } finally { await f.close(); }
});

test('匹配隔离人数、禁止重复排队/非标准人数，满员随机身份、查询和退出均使用本人', async () => {
  const f=await fixture();try{
    const first=await f.ok(f.rpc('10001','game.match',{operation:'join',maxPlayers:6}));
    assert.equal(first.state,'waiting');assert.equal(first.game.joined,1);
    assert.equal((await f.ok(f.rpc('10001','game.match',{operation:'join',maxPlayers:6}))).game.joined,1);
    assert.equal((await f.rpc('10001','game.match',{operation:'join',maxPlayers:8})).ok,false);
    assert.equal((await f.rpc('10002','game.match',{operation:'join',maxPlayers:7})).ok,false);
    const other=await f.ok(f.rpc('10024','game.match',{operation:'join',maxPlayers:8}));assert.notEqual(other.game.gameId,first.game.gameId);
    for(const who of f.ids.slice(1,6))await f.ok(f.rpc(who,'game.match',{operation:'join',maxPlayers:6}));
    const state=await f.ok(f.rpc('10001','game.match',{operation:'status'}));assert.equal(state.state,'matched');
    const game=f.app.store.get('games',state.game.gameId);assert.equal(Object.keys(game.roles).length,6);assert.equal(game.judgeMode,'program');
    assert.deepEqual(Object.values(game.roles).sort(),['seer','villager','villager','villager','wolf','wolf']);
    assert.equal((await f.ok(f.rpc('10024','game.match'))).state,'waiting');
    assert.equal((await f.rpc('10001','game.match',{operation:'join',maxPlayers:6})).ok,false,'参赛中不得新匹配');
    assert.equal((await f.rpc('10024','game.cancel',{gameId:other.game.gameId})).ok,false,'单人不得取消匹配房间');
    assert.equal((await f.ok(f.rpc('10024','game.match',{operation:'leave',botId:'10001'}))).state,'idle');
    assert.equal((await f.ok(f.rpc('10024','game.rules'))).usedToday,0);
  }finally{await f.close()}
});

for(const size of [8,10,12,16,20])test(`匹配 ${size} 人局准确满员并生成合法身份`,async()=>{
  const f=await fixture();try{
    let result;for(const who of f.ids.slice(0,size))result=await f.ok(f.rpc(who,'game.match',{operation:'join',maxPlayers:size}));
    const game=f.app.store.get('games',result.game.gameId);assert.equal(game.status,'night_wolf');assert.equal(game.participants.length,size);
    assert.equal(Object.keys(game.roles).length,size);assert.ok(game.rules.wolf<size/2&&game.rules.villager>=1);
  }finally{await f.close()}
});

for(const transport of ['mobile','web'])test(`${transport} 人类可与 bot 匹配并进入自身聊天室，次数与自家 bot 独立`,async()=>{
  const f=await fixture();try{
    const human=await f.human('10024',transport);
    const matching=await f.ok(human('human.match',{operation:'join',maxPlayers:6,botId:'10001',humanId:'10001H'}));
    for(const who of f.ids.slice(0,5))await f.ok(f.rpc(who,'game.match',{operation:'join',maxPlayers:6}));
    const status=await f.ok(human('human.status'));assert.equal(status.activeGameId,matching.game.gameId);
    const game=f.app.store.get('games',status.activeGameId);assert.ok(game.participants.includes('10024H'));assert.ok(!game.participants.includes('10001H'));
    assert.equal(status.rules.usedToday,1);assert.equal((await f.ok(f.rpc('10024','game.rules'))).usedToday,0);
    const room=await f.ok(human('human.room',{gameId:game.id}));assert.equal(room.messages.filter(m=>m.kind==='role').length,1);
    assert.equal((await human('owner.history')).status,423);
  }finally{await f.close()}
});

test('等待席位持久化，普通连接续期不唤醒 bot，掉线自动离场且不扣次数',async()=>{
  const f=await fixture();try{
    const m=await f.ok(f.rpc('10001','game.match',{operation:'join',maxPlayers:6}));
    await f.restart();assert.equal((await f.ok(f.rpc('10001','game.match'))).game.gameId,m.game.gameId);
    const n=f.app.store.count('events');f.set(f.now+61000);await f.ok(f.rpc('10001','events'));
    assert.equal(f.app.store.count('events'),n,'保活没有额外 bot 事件');
    f.set(f.now+61000);assert.equal((await f.ok(f.rpc('10001','game.match'))).state,'waiting');
    f.set(f.now+120001);assert.equal((await f.ok(f.rpc('10001','game.match'))).state,'idle');
    assert.equal((await f.ok(f.rpc('10001','game.rules'))).usedToday,0);assert.equal(f.app.store.get('gameWaiting','10001'),undefined);
  }finally{await f.close()}
});

test('实时模式检查时段、日上限和跨游戏占用；主持断线取消剧本杀',async()=>{
  const f=await fixture();try{
    f.set('2026-11-02T09:00:00+08:00');assert.equal((await f.rpc('10001','game.match',{operation:'join',maxPlayers:6})).ok,false);
    f.set('2026-11-07T09:00:00+08:00');const script=await f.full('mystery');
    assert.equal((await f.rpc('10001','game.match',{operation:'join',maxPlayers:6})).ok,false);
    f.app.store.put('gameParticipation','10002:2026-11-07',{owner:'10002',games:['a','b','c','d','e']});
    assert.equal((await f.rpc('10002','game.match',{operation:'join',maxPlayers:6})).ok,false);
    await f.ok(f.rpc('10003','mystery.join',{gameId:script.gameId}));
    f.set(f.now+61000);await f.ok(f.rpc('10003','events'));f.set(f.now+60000);
    assert.equal(f.app.store.get('mysteryGames',script.gameId).status,'cancelled');assert.equal(f.app.store.get('mysteryWaiting','10003'),undefined);
    const busyId=randomUUID();f.app.store.put('mysteryGames',busyId,{id:busyId,status:'active',creator:'10004',joined:['10004'],scheduledAt:new Date(f.now).toISOString(),startedAt:new Date(f.now).toISOString(),deadlineAt:null});f.app.store.put('gameBusy','10004',{gameId:busyId});
    assert.equal((await f.rpc('10004','game.match',{operation:'join',maxPlayers:6})).ok,false);
    f.set('2026-11-08T23:59:30+08:00');const last=await f.full('game','10005');f.set('2026-11-09T00:00:00+08:00');assert.equal(f.app.store.get('games',last.gameId).status,'cancelled');
  }finally{await f.close()}
});

test('夜间行动齐立即推进，白天全员结束后投票；重复/迟到行动不会影响新阶段',async()=>{
  const f=await fixture();try{
    const gameId=f.seed(),act=(id,action,target)=>f.ok(f.rpc(id,'game.act',{gameId,action,target}));
    await act('10001','attack','10007');assert.equal(f.app.store.get('games',gameId).status,'night_wolf');
    assert.equal((await f.rpc('10001','game.act',{gameId,action:'attack',target:'10008'})).ok,false);
    const old={status:'night_wolf',day:1,deadlineAt:f.app.store.get('games',gameId).deadlineAt};
    await act('10002','skip');assert.equal(f.app.store.get('games',gameId).status,'night_gods');
    assert.equal((await f.rpc('10003','game.act',{gameId,action:'skip',expectedPhase:old})).status,409);
    await act('10003','inspect','10001');await act('10004','save');assert.equal(f.app.store.get('games',gameId).status,'night_gods');
    await act('10005','skip');assert.equal(f.app.store.get('games',gameId).status,'day');
    for(const who of f.ids.slice(0,7))await act(who,'end_speech');
    assert.equal(f.app.store.get('games',gameId).status,'day');await act('10001','end_speech');
    await act('10008','end_speech');assert.equal(f.app.store.get('games',gameId).status,'vote');
    for(const who of f.ids.slice(0,8))await f.ok(f.rpc(who,'game.vote',{gameId,target:'abstain'}));
    const next=f.app.store.get('games',gameId);assert.equal(next.status,'night_wolf');assert.equal(next.day,2);
    assert.equal(f.now,Date.parse('2026-11-01T18:00:00+08:00'),'未推进测试时钟也能完成整轮');
  }finally{await f.close()}
});

test('无技能或全员离场无需等旧倒计时；未行动仍由原时长兜底',async()=>{
  const f=await fixture();try{
    const gameId=f.seed({roles:{10001:'wolf',10002:'villager',10003:'villager',10004:'witch',10005:'villager',10006:'villager',10007:'villager',10008:'villager'},uses:{10004:{save:true,poison:true,shot:false}}});
    await f.ok(f.rpc('10001','game.act',{gameId,action:'skip'}));assert.equal(f.app.store.get('games',gameId).status,'day');
    f.set(f.now+299999);assert.equal(f.app.store.get('games',gameId).status,'day');f.set(f.now+1);assert.equal(f.app.store.get('games',gameId).status,'vote');
    f.set(f.now+120000);assert.equal(f.app.store.get('games',gameId).status,'night_wolf');
    const second=f.seed({status:'day',dayDone:f.ids.slice(0,7)});await f.ok(f.rpc('10008','game.exit',{gameId:second}));assert.equal(f.app.store.get('games',second).status,'vote');
  }finally{await f.close()}
});
