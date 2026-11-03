import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-public-join-'));
  let now = Date.parse('2026-11-02T18:00:00+08:00');
  const ids = Array.from({ length: 8 }, (_, i) => String(10001 + i));
  const keys = Object.fromEntries(ids.map(id => [id, id.repeat(8)]));
  const app = createStarpostServer({ file: join(dir, 'db.json'), keys, port: 0, clock: () => now });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body, headers = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, headers: r.headers, ...await r.json() };
  };
  const ok = async promise => { const r = await promise; assert.equal(r.ok, true, r.error); return r.result; };
  const rpc = (who, action, args = {}) => post('/rpc', { action, args }, { 'x-starpost-id': who, authorization: `Bearer ${keys[who]}` });
  async function human(who, transport = 'mobile') {
    const login = await post(`/${transport}/login`, { botId: who, credential: keys[who] }, transport === 'web' ? { origin: base } : {});
    const value = await ok(login);
    const headers = transport === 'web' ? { origin: base, cookie: login.headers.get('set-cookie').split(';')[0] } : { authorization: `Bearer ${value.accessToken}` };
    return (action, args = {}) => post(`/${transport}/rpc`, { action, args }, headers);
  }
  app.store.befriend('10001', '10002');
  const schedule = (family, publicGame = false) => ok(rpc('10001', `${family}.schedule`, {
    sourceKind: 'private', sourceTarget: '10002', scheduledAt: new Date(now + 600000).toISOString(),
    title: '广场免邀请测试', maxPlayers: 6, presetId: 'laidian', public: publicGame,
  }));
  return { app, ids, rpc, ok, human, schedule, set: time => { now = time; app.tickGames(); },
    close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

for (const family of ['game', 'mystery']) test(`${family} 广场公开预约可由陌生 bot 直接加入，记录可查且重复加入幂等`, async () => {
  const f = await fixture();
  try {
    const g = await f.schedule(family, family === 'game');
    const args = { gameId: g.gameId }, collection = family === 'game' ? 'games' : 'mysteryGames';
    assert.equal((await f.rpc('10003', `${family}.join`, args)).status, 403, '未公告时仍须邀请');
    await f.ok(f.rpc('10001', `${family}.publish`, args));
    const found = (await f.ok(f.rpc('10003', `${family}.browse`))).find(v => v.gameId === g.gameId);
    assert.equal(found.published, true);
    assert.equal(found.public, true);
    assert.equal((await f.ok(f.rpc('10003', `${family}.join`, args))).joined, true);
    assert.equal((await f.ok(f.rpc('10003', `${family}.join`, args))).joined, true);
    const stored = f.app.store.get(collection, g.gameId);
    assert.deepEqual(stored.joined, ['10001', '10003']);
    assert.equal(stored.invited.includes('10003'), false, '公开加入不伪造邀请');
    assert.equal(stored.checkedIn.includes('10003'), false, '仍需自行报到');
    assert.equal((await f.ok(f.rpc('10003', `${family}.list`))).find(v => v.gameId === g.gameId).participant, true);
    assert.equal((await f.ok(f.rpc('10003', `${family}.read`, args))).game.canInvite, true);
    assert.equal(f.app.store.events('10001', 0).filter(e => e.type === `${family}.joined` && e.data.botId === '10003').length, 1);
    const phone = await f.human('10003');
    assert.equal((await f.ok(phone('games', { scope: 'own' }))).items.find(v => v.gameId === g.gameId).own, true);
    if (family === 'game') {
      await f.ok(f.rpc('10001', 'game.visibility', { ...args, public: false }));
      assert.equal((await f.ok(f.rpc('10003', 'game.join', args))).joined, true, '已有成员保留资格');
      assert.equal((await f.rpc('10004', 'game.join', args)).status, 403, '改为私密后停止公开加入');
    }
  } finally { await f.close(); }
});

for (const family of ['game', 'mystery']) test(`${family} 公开加入保留人数与开局限制，私密预约仍需邀请`, async () => {
  const f = await fixture();
  try {
    const g = await f.schedule(family), args = { gameId: g.gameId };
    assert.equal((await f.rpc('10003', `${family}.join`, args)).status, 403);
    await f.ok(f.rpc('10002', `${family}.join`, args));
    await f.ok(f.rpc('10002', `${family}.join`, args));
    if (family === 'game') await f.ok(f.rpc('10001', 'game.visibility', { ...args, public: true }));
    await f.ok(f.rpc('10001', `${family}.publish`, args));
    await Promise.all(f.ids.slice(2).map(who => f.rpc(who, `${family}.join`, args)));
    const stored = f.app.store.get(family === 'game' ? 'games' : 'mysteryGames', g.gameId);
    assert.equal(stored.joined.length, 6, '并发加入不超出人数上限');
    const excluded = f.ids.find(id => !stored.joined.includes(id));
    assert.match((await f.rpc(excluded, `${family}.join`, args)).error, /已满/);
    assert.equal(f.app.store.get(family === 'game' ? 'gameAccess' : 'mysteryAccess', `${excluded}:${g.gameId}`), undefined);
    assert.equal(stored.invited.includes(excluded), false);
    assert.equal((await f.ok(f.rpc(stored.joined.at(-1), `${family}.join`, args))).joined, true);
    f.set(Date.parse(g.scheduledAt) - 180000);
    for (const id of stored.joined) await f.ok(f.rpc(id, `${family}.checkin`, args));
    f.set(Date.parse(g.scheduledAt));
    assert.notEqual(f.app.store.get(family === 'game' ? 'games' : 'mysteryGames', g.gameId).status, 'scheduled');
    assert.equal((await f.rpc(excluded, `${family}.join`, args)).ok, false, '已经开局不得中途插入');
  } finally { await f.close(); }
});

for (const transport of ['mobile', 'web']) test(`${transport} 人类从广场免邀请加入，仅使用本人身份并保留禁赛和五局限制`, async () => {
  const f = await fixture();
  try {
    const human = await f.human('10003', transport), denied = await f.human('10004', transport);
    const g = await f.schedule('game', true), args = { gameId: g.gameId, humanId: '10001H', botId: '10003' };
    assert.equal((await human('human.join', args)).status, 403);
    await f.ok(f.rpc('10001', 'game.publish', args));
    assert.ok((await f.ok(human('human.lobby'))).games.some(v => v.gameId === g.gameId));
    await f.ok(human('human.join', args));
    await f.ok(human('human.join', args));
    let stored = f.app.store.get('games', g.gameId);
    assert.deepEqual(stored.joined, ['10001', '10003H']);
    assert.equal(stored.invited.includes('10003H'), false);
    assert.equal((await f.ok(human('human.room', args))).humanId, '10003H');
    f.app.store.put('humanConduct', '10004', { strikes: 2, banned: true });
    assert.equal((await denied('human.join', args)).status, 403);
    f.app.store.remove('humanConduct', '10004');
    f.app.store.put('gameParticipation', '10004H:2026-11-02', { owner: '10004H', day: '2026-11-02', games: ['1', '2', '3', '4', '5'] });
    assert.match((await denied('human.join', args)).error, /已参加 5 局/);
    f.app.store.remove('gameParticipation', '10004H:2026-11-02');
    stored = f.app.store.get('games', g.gameId); stored.kicked = ['10004H']; f.app.store.put('games', g.gameId, stored);
    assert.equal((await denied('human.join', args)).status, 403);
    assert.equal(f.app.store.get('games', g.gameId).invited.includes('10004H'), false);
    assert.equal(f.app.store.get('gameAccess', `10004H:${g.gameId}`), undefined);
  } finally { await f.close(); }
});

test('公开狼人杀仍限制 bot 每日五局与本局移出资格', async () => {
  const f = await fixture();
  try {
    const g = await f.schedule('game', true), args = { gameId: g.gameId };
    await f.ok(f.rpc('10001', 'game.publish', args));
    f.app.store.put('gameParticipation', '10003:2026-11-02', { owner: '10003', day: '2026-11-02', games: ['1', '2', '3', '4', '5'] });
    assert.match((await f.rpc('10003', 'game.join', args)).error, /已参加 5 局/);
    const stored = f.app.store.get('games', g.gameId); stored.kicked = ['10004']; f.app.store.put('games', g.gameId, stored);
    assert.equal((await f.rpc('10004', 'game.join', args)).status, 403);
    assert.deepEqual(f.app.store.get('games', g.gameId).joined, ['10001']);
  } finally { await f.close(); }
});
