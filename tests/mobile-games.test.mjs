import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStarpostServer } from '../server/server.mjs';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-mobile-games-'));
  const now = Date.parse('2026-11-01T18:00:00+08:00');
  const keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32), 10003: 'c'.repeat(32) };
  const app = createStarpostServer({ file: join(dir, 'data.json'), keys, port: 0, clock: () => now });
  await app.listen();
  app.store.befriend('10001', '10002');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body, headers = {}) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const bot = (who, action, args = {}) => post('/rpc', { action, args }, { authorization: `Bearer ${keys[who]}`, 'x-starpost-id': who });
  const token = (await post('/mobile/login', { botId: '10002', credential: keys[10002] })).result.accessToken;
  const login = await fetch(base + '/web/login', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ botId: '10002', credential: keys[10002] }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const phone = (action, args = {}) => post('/mobile/rpc', { action, args }, { authorization: `Bearer ${token}` });
  const web = (action, args = {}) => post('/web/rpc', { action, args }, { origin: base, cookie });
  const save = (extra = {}) => {
    const id = randomUUID();
    app.store.put('games', id, { id, title: '其他 bot 发起的私密局', creator: '10001', judgeMode: 'program',
      judgeBotId: null, assignmentMode: 'random', scheduledAt: new Date(now + 240000).toISOString(),
      status: 'closed', maxPlayers: 6, joined: ['10001', '10002'], checkedIn: ['10001', '10002'],
      participants: ['10001', '10002'], alive: [], invited: ['10002'], rules: {}, uses: {}, roles: {},
      public: false, published: false, ...extra });
    return id;
  };
  return { app, phone, web, bot, save, now, close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('其他 bot 发起的私密预约加入后可查，超过 50 条新邀请不会挤掉该局', async () => {
  const f = await fixture();
  try {
    const scheduled = await f.bot('10001', 'game.schedule', { sourceKind: 'private', sourceTarget: '10002', maxPlayers: 6,
      scheduledAt: new Date(f.now + 240000).toISOString() });
    assert.equal(scheduled.ok, true, scheduled.error);
    const gameId = scheduled.result.gameId;
    assert.equal((await f.bot('10002', 'game.join', { gameId })).ok, true);
    for (let i = 0; i < 55; i++) {
      const id = f.save({ participants: [], joined: ['10001'] });
      f.app.store.put('gameAccess', `10002:${id}`, { owner: '10002', gameId: id });
    }
    for (const client of [f.phone, f.web]) {
      const page = await client('games', { scope: 'own' });
      assert.equal(page.ok, true, page.error);
      assert.deepEqual(page.result.items.map(g => g.gameId), [gameId]);
      assert.equal((await client('game', { gameId })).ok, true);
    }
  } finally { await f.close(); }
});

test('本人参加的历史局按实际成员查询、分页且不泄露其他私密局，手机与网页一致', async () => {
  const f = await fixture();
  try {
    const ids = Array.from({ length: 52 }, (_, i) => f.save({ title: `历史局 ${i}` }));
    const privateId = f.save({ title: '无权查看', participants: ['10001', '10003'], joined: ['10001', '10003'], invited: [] });
    const publicId = f.save({ title: '公开历史局', participants: ['10001'], joined: ['10001'], public: true, published: true });
    const mysteryId = randomUUID();
    f.app.store.put('mysteryGames', mysteryId, { id: mysteryId, title: '别人的剧本杀', creator: '10001', joined: ['10002'],
      checkedIn: ['10002'], status: 'closed', phase: 'closed', scheduledAt: new Date(f.now).toISOString(), minPlayers: 5, maxPlayers: 6 });
    for (const client of [f.phone, f.web]) {
      const first = (await client('games', { scope: 'own' })).result;
      assert.equal(first.items.length, 50);
      assert.equal(first.items[0].gameId, mysteryId);
      assert.equal(first.items.some(g => [privateId, publicId].includes(g.gameId)), false);
      const second = (await client('games', { scope: 'own', before: first.nextBefore })).result;
      assert.equal(second.nextBefore, null);
      assert.deepEqual(new Set([...first.items, ...second.items].map(g => g.gameId)), new Set([...ids, mysteryId]));
      assert.equal((await client('game', { gameId: ids[0] })).ok, true);
      assert.equal((await client('game', { gameId: privateId })).status, 403);
      assert.deepEqual((await client('games', { scope: 'public' })).result.items.map(g => g.gameId), [publicId]);
      assert.equal((await client('games', { scope: 'invalid' })).status, 400);
      assert.equal((await client('games', { before: 'not-a-cursor' })).status, 400);
    }
  } finally { await f.close(); }
});
