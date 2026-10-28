import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStarpostServer } from '../server/server.mjs';

async function fixture(count = 10) {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-werewolf-'));
  let now = Date.parse('2026-10-30T18:00:00+08:00');
  const ids = Array.from({ length: count }, (_, i) => String(10001 + i));
  const keys = Object.fromEntries(ids.map((id, i) => [id, String.fromCharCode(97 + i).repeat(32)]));
  const file = join(dir, 'relay.json');
  let app = createStarpostServer({ file, keys, port: 0, clock: () => now });
  await app.listen();
  const groupId = randomUUID();
  app.store.transaction(() => {
    for (const id of ids.slice(1)) app.store.befriend(ids[0], id);
    app.store.saveGroup({ id: groupId, name: '游戏邀请群', owner: ids[0], members: ids.slice(0, -1), createdAt: new Date(now).toISOString() });
  });
  const rpc = async (who, action, args = {}, limits) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/rpc`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-starpost-id': who, authorization: `Bearer ${keys[who]}`,
    }, body: JSON.stringify({ action, args, ...(limits ? { limits } : {}) }) });
    return { status: response.status, ...await response.json() };
  };
  const ok = async (who, action, args = {}, limits) => {
    const response = await rpc(who, action, args, limits);
    assert.equal(response.ok, true, `${action}: ${response.error}`); return response.result;
  };
  const set = time => { now = typeof time === 'number' ? time : Date.parse(time); app.tickGames(); };
  const advance = gameId => set(Date.parse(app.store.get('games', gameId).deadlineAt));
  const reserve = async (players, extra = {}) => {
    const scheduledAt = new Date(now + 4 * 60000).toISOString();
    const game = await ok(ids[0], 'game.schedule', { maxPlayers: players.length, scheduledAt,
      sourceKind: 'group', sourceTarget: groupId, ...extra });
    for (const who of players) await ok(who, 'game.join', { gameId: game.gameId });
    set(Date.parse(scheduledAt) - 3 * 60000);
    for (const who of players) await ok(who, 'game.checkin', { gameId: game.gameId });
    if (extra.judgeMode === 'bot') {
      const judge = extra.judgeBotId ?? ids[0];
      await ok(judge, 'game.join', { gameId: game.gameId });
      await ok(judge, 'game.checkin', { gameId: game.gameId });
    }
    set(scheduledAt);
    return game.gameId;
  };
  return { ids, groupId, rpc, ok, set, advance, reserve, get now() { return now; }, get app() { return app; },
    restart: async () => { await app.close(); app = createStarpostServer({ file, keys, port: 0, clock: () => now }); await app.listen(); },
    close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('狼人杀预约限制时段、集合提醒只发一次、缺席不占人数与次数，随机身份只经私密频道送达', async () => {
  const f = await fixture();
  try {
    for (const scheduledAt of ['2026-10-31T01:00:00+08:00', '2026-10-31T09:00:00+08:00', '2026-10-31T14:00:00+08:00']) {
      const response = await f.rpc('10001', 'game.schedule', { scheduledAt, maxPlayers: 7, sourceKind: 'group', sourceTarget: f.groupId });
      assert.match(response.error, /只能预约/);
    }
    const scheduledAt = new Date(f.now + 4 * 60000).toISOString();
    const game = await f.ok('10001', 'game.schedule', { scheduledAt, maxPlayers: 7, sourceKind: 'private', sourceTarget: '10002' });
    assert.equal((await f.ok('10001', 'game.list'))[0].gameId, game.gameId);
    assert.equal((await f.ok('10002', 'game.list'))[0].gameId, game.gameId);
    assert.equal((await f.ok('10010', 'game.list')).length, 0);
    assert.equal((await f.rpc('10003', 'game.join', { gameId: game.gameId })).status, 403);
    await f.ok('10001', 'game.invite', { gameId: game.gameId, sourceKind: 'group', sourceTarget: f.groupId });
    for (const who of f.ids.slice(0, 7)) await f.ok(who, 'game.join', { gameId: game.gameId });
    assert.equal((await f.rpc('10001', 'game.checkin', { gameId: game.gameId })).ok, false);
    f.set(Date.parse(scheduledAt) - 3 * 60000);
    f.app.tickGames();
    for (const who of f.ids.slice(0, 6)) await f.ok(who, 'game.checkin', { gameId: game.gameId });
    const reminders = (await f.ok('10002', 'events')).filter(event => event.type === 'game.reminder');
    assert.equal(reminders.length, 1);
    assert.equal((await f.ok('10002', 'events')).find(event => event.type === 'game.invited').data.sourceKind, 'private');
    f.set(scheduledAt);
    const state = f.app.store.get('games', game.gameId);
    assert.equal(state.status, 'night_wolf'); assert.equal(state.participants.length, 6);
    assert.deepEqual(Object.values(state.roles).sort(), ['seer', 'villager', 'villager', 'villager', 'wolf', 'wolf']);
    for (const who of f.ids.slice(0, 6)) {
      const events = await f.ok(who, 'events');
      const roles = events.filter(event => event.type === 'game.private' && event.data.kind === 'role');
      assert.equal(roles.length, 1); assert.equal(roles[0].data.to, who);
      const room = await f.ok(who, 'game.read', { gameId: game.gameId });
      assert.equal(room.game.ownRole, state.roles[who]); assert.equal(room.game.assignments, undefined);
      assert.equal(room.messages.some(message => message.channel === 'private' && message.to !== who), false);
      assert.equal((await f.ok(who, 'game.rules')).usedToday, 1);
    }
    assert.equal((await f.ok('10007', 'game.rules')).usedToday, 0);
    assert.equal((await f.rpc('10007', 'game.read', { gameId: game.gameId })).status, 403);
    assert.equal((await f.rpc('10010', 'game.read', { gameId: game.gameId })).status, 403);
    assert.equal(JSON.stringify(await f.ok('10010', 'snapshot')).includes('ownRole'), false);
    const overlapping = await f.reserve(f.ids.slice(0, 6));
    assert.equal(f.app.store.get('games', overlapping).status, 'cancelled');
    assert.equal((await f.ok('10001', 'game.rules')).usedToday, 1);
  } finally { await f.close(); }
});

test('bot 法官手动分发、私密夜间行动与公共投票、药剂和守护约束、游戏消息豁免及结束关房', async () => {
  const f = await fixture();
  const players = f.ids.slice(1, 9), roles = ['wolf', 'wolf', 'seer', 'witch', 'guard', 'hunter', 'villager', 'villager'];
  try {
    const gameId = await f.reserve(players, { judgeMode: 'bot', assignmentMode: 'judge', roles: { wolf: 2, seer: 1, witch: 1, guard: 1, hunter: 1, villager: 2 } });
    assert.equal(f.app.store.get('games', gameId).status, 'assigning');
    assert.equal((await f.rpc('10002', 'game.assign', { gameId, assignments: [] })).status, 403);
    const assignments = players.map((botId, i) => ({ botId, role: roles[i] }));
    assert.equal((await f.rpc('10001', 'game.assign', { gameId, assignments: assignments.map(item => ({ ...item, role: 'wolf' })) })).ok, false);
    await f.ok('10001', 'game.assign', { gameId, assignments });
    assert.equal((await f.ok('10001', 'game.rules')).usedToday, 1);
    assert.equal((await f.rpc('10008', 'game.message', { gameId, channel: 'public', text: '夜晚偷说话' })).ok, false);
    await f.ok('10002', 'game.message', { gameId, channel: 'wolf', text: '第一夜秘密' });
    assert.equal((await f.rpc('10004', 'game.message', { gameId, channel: 'wolf', text: '偷看' })).status, 403);
    for (const who of ['10002', '10003']) await f.ok(who, 'game.act', { gameId, action: 'attack', target: '10007' });
    f.advance(gameId);
    await f.ok('10004', 'game.act', { gameId, action: 'inspect', target: '10002' });
    await f.ok('10006', 'game.act', { gameId, action: 'protect', target: '10007' });
    await f.ok('10005', 'game.act', { gameId, action: 'poison', target: '10002' });
    assert.equal((await f.rpc('10005', 'game.act', { gameId, action: 'save' })).ok, false);
    assert.equal((await f.rpc('10008', 'game.act', { gameId, action: 'inspect', target: '10002' })).status, 403);
    const seer = await f.ok('10004', 'game.read', { gameId });
    assert.equal(seer.messages.find(message => message.kind === 'inspect_result').isWolf, true);
    assert.equal((await f.ok('10008', 'game.read', { gameId })).messages.some(message => message.kind === 'inspect_result' || message.channel === 'wolf'), false);
    f.advance(gameId);
    assert.equal(f.app.store.get('games', gameId).status, 'day');
    await f.ok('10009', 'game.message', { gameId, channel: 'public', text: '游戏发言不扣聊天额度' }, { maxMessagesPerDay: 0 });
    for (let i = 0; i < 5; i++) await f.ok('10009', 'game.message', { gameId, channel: 'public', text: `讨论 ${i}\n第二行` });
    assert.equal((await f.rpc('10009', 'game.message', { gameId, channel: 'public', text: '第七条被限速' })).status, 429);
    assert.equal((await f.ok('10009', 'snapshot')).messageQuota.used, 0);
    assert.equal((await f.rpc('10009', 'message.send', { kind: 'group', target: f.groupId, text: '普通群消息' })).status, 429);
    f.advance(gameId);
    assert.equal((await f.rpc('10001', 'game.vote', { gameId, target: '10008' })).status, 403);
    for (const who of players.filter(id => id !== '10002')) await f.ok(who, 'game.vote', { gameId, target: '10008' });
    assert.equal(f.app.store.get('games', gameId).status, 'night_wolf');
    await f.ok('10003', 'game.message', { gameId, channel: 'wolf', text: '第二夜秘密' });
    assert.equal((await f.ok('10002', 'game.read', { gameId })).messages.some(message => message.text === '第二夜秘密'), false);
    await f.ok('10003', 'game.act', { gameId, action: 'attack', target: '10007' });
    f.advance(gameId);
    assert.equal((await f.rpc('10006', 'game.act', { gameId, action: 'protect', target: '10007' })).ok, false);
    await f.ok('10006', 'game.act', { gameId, action: 'protect', target: '10009' });
    assert.equal((await f.rpc('10005', 'game.act', { gameId, action: 'poison', target: '10003' })).ok, false);
    await f.ok('10005', 'game.act', { gameId, action: 'save' });
    f.advance(gameId); f.advance(gameId);
    for (const who of players.filter(id => !['10002', '10008'].includes(id))) await f.ok(who, 'game.vote', { gameId, target: '10003' });
    const finished = f.app.store.get('games', gameId);
    assert.equal(finished.status, 'finished'); assert.equal(finished.winner, 'village');
    await f.ok('10002', 'game.message', { gameId, channel: 'public', text: '复盘' });
    f.advance(gameId);
    assert.equal(f.app.store.get('games', gameId).status, 'closed');
    assert.equal((await f.rpc('10002', 'game.message', { gameId, channel: 'public', text: '关房后不能发言' })).ok, false);
    assert.ok((await f.ok('10002', 'game.read', { gameId })).messages.some(message => message.kind === 'finished'));
  } finally { await f.close(); }
});

test('猎人夜间出局后完成开枪再进入同一天讨论，结算前不跳过技能', async () => {
  const f = await fixture(8);
  try {
    const players = f.ids.slice(1, 7), gameId = await f.reserve(players, { judgeMode: 'bot', assignmentMode: 'judge', roles: { wolf: 1, hunter: 1, villager: 4 } });
    await f.ok('10001', 'game.assign', { gameId, assignments: players.map((botId, i) => ({ botId, role: i === 0 ? 'wolf' : i === 1 ? 'hunter' : 'villager' })) });
    await f.ok('10002', 'game.act', { gameId, action: 'attack', target: '10003' });
    f.advance(gameId); f.advance(gameId);
    assert.equal(f.app.store.get('games', gameId).status, 'hunter');
    await f.ok('10003', 'game.act', { gameId, action: 'shoot', target: '10004' });
    assert.equal(f.app.store.get('games', gameId).status, 'day'); assert.equal(f.app.store.get('games', gameId).day, 1);
    f.advance(gameId);
    for (const who of ['10002', '10005', '10006', '10007']) await f.ok(who, 'game.vote', { gameId, target: '10002' });
    assert.equal(f.app.store.get('games', gameId).winner, 'village');
  } finally { await f.close(); }
});

test('每天最多三局在实际开局时持久化计数，跨北京时间午夜恢复，取消不扣次数', async () => {
  const f = await fixture(8);
  const players = f.ids.slice(0, 6);
  try {
    for (let round = 0; round < 3; round++) {
      const gameId = await f.reserve(players, { roles: { wolf: 1, villager: 5 } });
      const wolf = Object.keys(f.app.store.get('games', gameId).roles).find(id => f.app.store.get('games', gameId).roles[id] === 'wolf');
      f.advance(gameId); f.advance(gameId); f.advance(gameId);
      for (const who of players) await f.ok(who, 'game.vote', { gameId, target: wolf });
      f.advance(gameId);
    }
    await f.restart();
    assert.equal((await f.ok('10001', 'game.rules')).usedToday, 3);
    const game = await f.ok('10001', 'game.schedule', { maxPlayers: 6, scheduledAt: new Date(f.now + 4 * 60000).toISOString(), sourceKind: 'group', sourceTarget: f.groupId });
    assert.equal((await f.rpc('10002', 'game.join', { gameId: game.gameId })).ok, false);
    await f.ok('10001', 'game.cancel', { gameId: game.gameId });
    assert.equal((await f.ok('10001', 'game.rules')).usedToday, 3);
    f.set('2026-10-31T06:00:00+08:00');
    assert.equal((await f.ok('10001', 'game.rules')).usedToday, 0);
  } finally { await f.close(); }
});

test('超时与重启可继续所有阶段，连续三天无人出局以平局收尾，手工分发超时回退随机', async () => {
  const f = await fixture(8);
  try {
    const gameId = await f.reserve(f.ids.slice(1, 7), { judgeMode: 'bot', assignmentMode: 'judge', roles: { wolf: 1, villager: 5 } });
    assert.equal(f.app.store.get('games', gameId).status, 'assigning');
    f.advance(gameId);
    const assigned = f.app.store.get('games', gameId).roles;
    await f.restart();
    assert.deepEqual(f.app.store.get('games', gameId).roles, assigned);
    for (let phase = 0; phase < 12; phase++) f.advance(gameId);
    assert.equal(f.app.store.get('games', gameId).status, 'finished');
    assert.equal(f.app.store.get('games', gameId).winner, 'draw');
    f.advance(gameId);
    assert.equal(f.app.store.get('games', gameId).status, 'closed');
  } finally { await f.close(); }
});

test('法官未报到回退程序主持，自定义配置只减少平民；延误到限制时段则取消且不扣次数', async () => {
  const f = await fixture();
  try {
    const scheduledAt = new Date(f.now + 4 * 60000).toISOString();
    const game = await f.ok('10001', 'game.schedule', { scheduledAt, roles: { wolf: 2, seer: 1, villager: 5 },
      judgeMode: 'bot', assignmentMode: 'judge', sourceKind: 'group', sourceTarget: f.groupId });
    f.set(Date.parse(scheduledAt) - 3 * 60000);
    for (const who of f.ids.slice(1, 7)) {
      await f.ok(who, 'game.join', { gameId: game.gameId }); await f.ok(who, 'game.checkin', { gameId: game.gameId });
    }
    f.set(scheduledAt);
    const started = f.app.store.get('games', game.gameId);
    assert.equal(started.judgeMode, 'program'); assert.equal(started.judgeBotId, null);
    assert.equal(started.rules.villager, 3); assert.equal(started.rules.wolf, 2);
    assert.equal((await f.ok('10001', 'game.rules')).usedToday, 0);
  } finally { await f.close(); }
  const late = await fixture(8);
  try {
    late.set('2026-10-31T08:55:00+08:00');
    const game = await late.ok('10001', 'game.schedule', { scheduledAt: '2026-10-31T08:59:00+08:00', maxPlayers: 6,
      sourceKind: 'group', sourceTarget: late.groupId });
    late.set('2026-10-31T08:56:00+08:00');
    for (const who of late.ids.slice(0, 6)) { await late.ok(who, 'game.join', { gameId: game.gameId }); await late.ok(who, 'game.checkin', { gameId: game.gameId }); }
    late.set('2026-10-31T09:00:00+08:00');
    assert.equal(late.app.store.get('games', game.gameId).status, 'cancelled');
    assert.equal((await late.ok('10001', 'game.rules')).usedToday, 0);
  } finally { await late.close(); }
});
