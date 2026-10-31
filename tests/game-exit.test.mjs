import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStarpostServer } from '../server/server.mjs';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-game-exit-')), file = join(dir, 'data.json');
  let now = Date.parse('2026-11-01T18:00:00+08:00');
  const ids = Array.from({ length: 9 }, (_, i) => String(10001 + i));
  const keys = Object.fromEntries(ids.map((id, i) => [id, String.fromCharCode(97 + i).repeat(32)]));
  const make = () => createStarpostServer({ file, keys, port: 0, clock: () => now });
  let app = make(); await app.listen();
  app.store.befriend('10001', '10002');
  const rpc = async (who, action, args = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/rpc`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-starpost-id': who, authorization: `Bearer ${keys[who]}` },
      body: JSON.stringify({ action, args }) });
    return { status: response.status, ...await response.json() };
  };
  const ok = async (who, action, args) => { const r = await rpc(who, action, args); assert.equal(r.ok, true, r.error); return r.result; };
  const save = (extra = {}) => {
    const id = randomUUID(), players = ids.slice(0, 6), roles = Object.fromEntries(players.map((who, i) => [who, ['wolf','wolf','seer','witch','hunter','villager'][i]]));
    app.store.put('games', id, { id, title: '离场测试局', creator: '10001', judgeMode: 'program', judgeBotId: null,
      assignmentMode: 'random', status: 'day', maxPlayers: 6, scheduledAt: new Date(now - 240000).toISOString(),
      startedAt: new Date(now - 240000).toISOString(), deadlineAt: new Date(now + 300000).toISOString(),
      joined: players, checkedIn: players, participants: players, invited: players.slice(1), alive: players,
      roles, rules: { wolf: 2, seer: 1, witch: 1, hunter: 1, villager: 1 }, day: 1, night: {}, votes: {}, spectators: [],
      uses: Object.fromEntries(players.map(who => [who, { save: false, poison: false, shot: false }])), public: false, ...extra });
    for (const who of [...players, ...(extra.judgeBotId ? [extra.judgeBotId] : [])]) {
      app.store.put('gameBusy', who, { gameId: id });
      app.store.put('gameAccess', `${who}:${id}`, { owner: who, gameId: id });
    }
    return id;
  };
  const mystery = (extra = {}) => {
    const id = randomUUID(), players = ids.slice(0, 6);
    app.store.put('mysteryGames', id, { id, title: '自创剧本', presetId: 'laidian', creator: '10001', status: 'active',
      phase: 'discussion', startedAt: new Date(now).toISOString(), scheduledAt: new Date(now).toISOString(),
      joined: players, checkedIn: players, invited: [], minPlayers: 6, maxPlayers: 6, public: false, ...extra });
    for (const who of players) app.store.put('gameBusy', who, { gameId: id, kind: 'mystery' });
    return id;
  };
  return { get app() { return app; }, ids, keys, rpc, ok, save, mystery, get now() { return now; },
    advance: id => { now = Date.parse(app.store.get('games', id).deadlineAt); app.tickGames(); },
    restart: async () => { await app.close(); app = make(); await app.listen(); },
    close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('预约离场向其他成员公告一次；非成员不能伪造离场，原 leave 仍可用', async () => {
  const f = await fixture();
  try {
    const g = await f.ok('10001', 'game.schedule', { sourceKind: 'private', sourceTarget: '10002', maxPlayers: 6, scheduledAt: new Date(f.now + 240000).toISOString() });
    await f.ok('10002', 'game.join', { gameId: g.gameId });
    assert.equal((await f.rpc('10003', 'game.exit', { gameId: g.gameId })).status, 403);
    await f.ok('10002', 'game.leave', { gameId: g.gameId });
    assert.equal((await f.ok('10002', 'game.exit', { gameId: g.gameId })).alreadyLeft, true);
    assert.deepEqual(f.app.store.get('games', g.gameId).joined, ['10001']);
    const notices = f.app.store.events('10001', 0).filter(e => e.type === 'game.public' && e.data.kind === 'left');
    assert.equal(notices.length, 1); assert.match(notices[0].data.text, /离开游戏房间/);
    assert.equal('role' in notices[0].data, false); assert.equal('roles' in notices[0].data, false);
    await f.ok('10002', 'game.join', { gameId: g.gameId });
    assert.equal(f.app.store.get('games', g.gameId).left.includes('10002'), false);
  } finally { await f.close(); }
});

test('进行中离场弃权、清理票、恢复聊天，重启后也不再收到房间事件且不影响其他预约', async () => {
  const f = await fixture();
  try {
    const gameId = f.save({ night: { wolfVotes: { 10001: '10006', 10002: '10004' }, victim: '10006' }, votes: { 10001: '10006', 10006: '10002' } });
    const other = await f.ok('10001', 'game.schedule', { sourceKind: 'private', sourceTarget: '10002', maxPlayers: 6, scheduledAt: new Date(f.now + 240000).toISOString() });
    await f.ok('10002', 'game.join', { gameId: other.gameId });
    f.app.store.put('deferredChat', randomUUID(), { recipient: '10006', type: 'message', data: { text: '离场后查收' }, at: new Date(f.now).toISOString() });
    const result = await f.ok('10006', 'game.exit', { gameId }); assert.equal(result.forfeited, true);
    const game = f.app.store.get('games', gameId);
    assert.equal(game.alive.includes('10006'), false); assert.equal(game.participants.includes('10006'), true);
    assert.deepEqual(game.votes, {}); assert.deepEqual(game.night.wolfVotes, { 10002: '10004' }); assert.equal(game.night.victim, null);
    assert.equal(f.app.store.get('gameBusy', '10006'), undefined);
    assert.equal(f.app.store.events('10006', 0).some(e => e.type === 'message' && e.data.text === '离场后查收'), true);
    assert.equal(f.app.store.get('games', other.gameId).joined.includes('10002'), true);
    for (const action of ['game.message', 'game.act', 'game.vote']) assert.equal((await f.rpc('10006', action, { gameId, channel: 'public', text: '离场后发言', action: 'skip', target: 'abstain' })).status, 403);
    await f.restart();
    const before = f.app.store.events('10006', 0).length;
    await f.ok('10003', 'game.message', { gameId, channel: 'public', text: '继续本局讨论' }); f.advance(gameId);
    assert.equal(f.app.store.events('10006', 0).length, before);
  } finally { await f.close(); }
});

test('最后一狼离场正常结算，次数不退；旧局结束不会解锁已加入的新局', async () => {
  const f = await fixture();
  try {
    const roles = Object.fromEntries(f.ids.slice(0,6).map((id,i) => [id,i===0?'wolf':'villager']));
    const gameId = f.save({ roles, rules: { wolf: 1, villager: 5 } });
    f.app.store.put('gameParticipation', '10001:2026-11-01', { owner: '10001', day: '2026-11-01', games: [gameId] });
    await f.ok('10001', 'game.exit', { gameId });
    assert.equal(f.app.store.get('games', gameId).winner, 'village');
    assert.equal((await f.ok('10001', 'game.rules')).usedToday, 1);
    const newGameId = randomUUID(); f.app.store.put('gameBusy', '10001', { gameId: newGameId });
    f.app.store.put('deferredChat', randomUUID(), { recipient: '10001', type: 'message', data: { text: '新局期间暂存' }, at: new Date(f.now).toISOString() });
    f.advance(gameId);
    assert.equal(f.app.store.get('gameBusy', '10001').gameId, newGameId);
    assert.equal(f.app.store.count('deferredChat', 'target=?', ['10001']), 1);
  } finally { await f.close(); }
});

test('待行动猎人离场跳过开枪，投票者离场后剩余投票可正常结算', async () => {
  const f = await fixture();
  try {
    const gameId = f.save({ status: 'hunter', pendingHunter: '10005', hunterResume: 'day', alive: ['10001','10002','10003','10004','10006'] });
    await f.ok('10005', 'game.exit', { gameId });
    assert.equal(f.app.store.get('games', gameId).status, 'day');
    assert.equal(f.app.store.get('games', gameId).pendingHunter, null);
    assert.equal((await f.rpc('10005', 'game.act', { gameId, action: 'shoot', target: '10001' })).status, 403);
    const voteId = f.save({ status: 'vote', votes: { 10001:'abstain',10002:'abstain',10003:'abstain',10004:'abstain',10005:'abstain' } });
    await f.ok('10006', 'game.exit', { gameId: voteId });
    assert.equal(f.app.store.get('games', voteId).status, 'night_wolf');
  } finally { await f.close(); }
});

test('手工分发期间法官离场，程序随机接管，离场法官仍可在手机查到历史', async () => {
  const f = await fixture();
  try {
    const gameId = f.save({ status: 'assigning', judgeMode: 'bot', judgeBotId: '10007', assignmentMode: 'judge', roles: {}, alive: [] });
    await f.ok('10007', 'game.exit', { gameId });
    const game = f.app.store.get('games', gameId);
    assert.equal(game.judgeMode, 'program'); assert.equal(game.judgeBotId, null); assert.equal(game.status, 'night_wolf');
    assert.equal(Object.keys(game.roles).length, 6);
    const url = `http://127.0.0.1:${f.app.server.address().port}`;
    const login = await (await fetch(url + '/mobile/login', { method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({botId:'10007',credential:f.keys['10007']}) })).json();
    const listed = await (await fetch(url + '/mobile/rpc', { method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${login.result.accessToken}`},body:JSON.stringify({action:'games',args:{scope:'own'}}) })).json();
    assert.ok(listed.result.items.some(item => item.gameId === gameId));
    assert.equal(f.app.store.events('10007', 0).some(e => e.data.gameId === gameId), false);
  } finally { await f.close(); }
});

test('分发身份前玩家离场不会在稍后的随机分发中复活', async () => {
  const f = await fixture();
  try {
    const gameId = f.save({ status:'assigning',judgeMode:'bot',judgeBotId:'10007',assignmentMode:'judge',roles:{},alive:[] });
    await f.ok('10006', 'game.exit', { gameId }); f.advance(gameId);
    assert.equal(f.app.store.get('games', gameId).alive.includes('10006'), false);
    assert.equal(f.app.store.events('10006', 0).some(e => e.type === 'game.private' && e.data.kind === 'role'), false);
  } finally { await f.close(); }
});

test('剧本杀普通玩家离场后不收消息、历史保留；主持离场关闭房间并释放其余玩家', async () => {
  const f = await fixture();
  try {
    const gameId = f.mystery();
    assert.equal((await f.rpc('10009','mystery.exit',{gameId})).status,403);
    await f.ok('10002','mystery.exit',{gameId});
    assert.equal(f.app.store.get('mysteryGames',gameId).status,'active');
    const before = f.app.store.events('10002',0).length;
    await f.ok('10001','mystery.message',{gameId,text:'下一条公开线索'});
    assert.equal((await f.rpc('10002','mystery.message',{gameId,text:'离场后发言'})).status,403);
    await f.ok('10001','mystery.exit',{gameId});
    assert.equal(f.app.store.get('mysteryGames',gameId).status,'closed');
    assert.equal(f.app.store.events('10002',0).length,before);
    assert.equal(f.app.store.count('gameBusy'),0);
    assert.equal((await f.ok('10002','mystery.read',{gameId})).game.gameId,gameId);
    const notices=f.app.store.events('10003',0).filter(e=>e.type==='mystery.message'&&e.data.kind==='left');
    assert.equal(notices.length,2);
  } finally { await f.close(); }
});
