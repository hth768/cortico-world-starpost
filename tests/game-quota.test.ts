import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';
import { STARPOST_CONFIG_GROUP, STARPOST_DEFAULTS } from '../src/config.ts';
import { StarpostWorld } from '../src/world.ts';
import { familyTool } from './tool-invoke.ts';

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-game-quota-'));
  const ids = Array.from({ length: 8 }, (_, i) => String(10001 + i));
  const keys = Object.fromEntries(ids.map(id => [id, id.repeat(8)]));
  let now = Date.parse('2026-11-07T18:00:00+08:00');
  const start = async () => { const app = createStarpostServer({ file: join(dir, 'state.json'), keys, port: 0, clock: () => now }); await app.listen(); return app; };
  let app = await start();
  const base = () => `http://127.0.0.1:${app.server.address().port}`;
  const rpc = async (who: string, action: string, args: Record<string, unknown> = {}, limits?: Record<string, unknown>) => {
    const response = await fetch(base() + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json',
      'x-starpost-id': who, authorization: `Bearer ${keys[who]}` }, body: JSON.stringify({ action, args, ...(limits ? { limits } : {}) }) });
    return { status: response.status, ...await response.json() };
  };
  const ok = async (promise: Promise<any>) => { const r = await promise; assert.equal(r.ok, true, r.error); return r.result; };
  const cap = (who: string, n: unknown) => ok(rpc(who, 'game.rules', {}, { maxWerewolfGamesPerDay: n }));
  const seed = (who: string, used: number) => {
    const day = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    app.store.put('gameParticipation', `${who}:${day}`, { owner: who, day, games: Array.from({ length: used }, (_, i) => `previous-${i}`), at: new Date(now).toISOString() });
  };
  const schedule = (who: string, extra: Record<string, unknown> = {}) => rpc(who, 'game.schedule', {
    maxPlayers: 6, public: true, sourceKind: 'square', scheduledAt: new Date(now + 4 * 60000).toISOString(), ...extra,
  });
  return { dir, ids, keys, base, rpc, ok, cap, seed, schedule, get app() { return app; }, get now() { return now; },
    set: (time: number) => { now = time; },
    restart: async () => { await app.close(); app = await start(); },
    close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('每日游戏额度默认 5，调整和重启保留计数，旧客户端保留配置，跨北京时间午夜重置', async () => {
  const f = await fixture(); try {
    assert.equal((await f.ok(f.rpc('10001', 'game.rules'))).dailyLimit, 5);
    f.seed('10001', 5);
    assert.equal((await f.rpc('10001', 'game.match', { operation: 'join', maxPlayers: 6 })).ok, false);
    const raised = await f.cap('10001', 8);
    assert.deepEqual([raised.dailyLimit, raised.usedToday, raised.remainingToday], [8, 5, 3]);
    assert.equal((await f.ok(f.rpc('10002', 'game.rules'))).dailyLimit, 5);
    await f.ok(f.rpc('10001', 'game.match', { operation: 'join', maxPlayers: 6 }));
    await f.ok(f.rpc('10001', 'game.match', { operation: 'leave' }));
    assert.equal((await f.ok(f.rpc('10001', 'game.rules'))).usedToday, 5, '未开局不扣次数');
    await f.restart();
    const legacy = await f.ok(f.rpc('10001', 'game.rules', {}, { private: 10, groups: 5 }));
    assert.deepEqual([legacy.dailyLimit, legacy.usedToday, legacy.remainingToday], [8, 5, 3]);
    for (const invalid of [-1, 1.5, 1001, '99', null]) assert.equal((await f.cap('10001', invalid)).dailyLimit, 8);
    const lower = await f.cap('10001', 2);
    assert.deepEqual([lower.dailyLimit, lower.usedToday, lower.remainingToday], [2, 5, 0]);
    assert.match((await f.rpc('10001', 'game.match', { operation: 'join', maxPlayers: 6 })).error, /5\/2/);
    assert.equal((await f.schedule('10001')).ok, false);
    f.set(Date.parse('2026-11-08T00:00:00+08:00'));
    const next = await f.ok(f.rpc('10001', 'game.rules'));
    assert.deepEqual([next.dailyLimit, next.usedToday, next.remainingToday], [2, 0, 2]);
    await f.ok(f.schedule('10001'));
  } finally { await f.close(); }
});

test('匹配和人满即开按每人最新额度开局，额度更新先于计时器，进行中的游戏不受调低影响', async () => {
  const f = await fixture(); try {
    await f.cap('10001', 6); f.seed('10001', 5);
    const first = await f.ok(f.rpc('10001', 'game.match', { operation: 'join', maxPlayers: 6 }));
    // Another client lowers the stored cap while this extension still has the previous setting.
    f.app.store.put('limits', '10001', { maxWerewolfGamesPerDay: 5 });
    const refreshed = await f.ok(f.rpc('10001', 'game.match', { operation: 'status' }, { maxWerewolfGamesPerDay: 6 }));
    assert.equal(refreshed.state, 'waiting'); assert.equal(refreshed.game.gameId, first.game.gameId);
    for (const who of f.ids.slice(1, 6)) await f.ok(f.rpc(who, 'game.match', { operation: 'join', maxPlayers: 6 }));
    const game = f.app.store.get('games', first.game.gameId);
    assert.equal(game.status, 'night_wolf'); assert.ok(game.participants.includes('10001'));
    assert.equal((await f.ok(f.rpc('10001', 'game.rules'))).usedToday, 6);
    const zero = await f.cap('10001', 0);
    assert.deepEqual([zero.dailyLimit, zero.usedToday, zero.remainingToday], [0, 6, 0]);
    assert.equal(f.app.store.get('games', first.game.gameId).status, 'night_wolf');
    assert.equal(f.app.store.get('gameBusy', '10001').gameId, first.game.gameId);
    await f.cap('10007', 0);
    assert.match((await f.schedule('10007', { startMode: 'full' })).error, /暂停/);
    assert.match((await f.schedule('10007')).error, /暂停/);
    const wait = await f.ok(f.schedule('10008', { startMode: 'full' }));
    assert.match((await f.rpc('10007', 'game.join', { gameId: wait.gameId })).error, /暂停/);
  } finally { await f.close(); }
});

for (const disable of ['player', 'judge']) test(`预约开局再次检查自定义额度：${disable === 'player' ? '满额玩家退出人数统计' : '满额法官回退程序主持'}`, async () => {
  const f = await fixture(); try {
    f.app.store.befriend('10001', '10008');
    const g = await f.ok(f.schedule('10001', { maxPlayers: 7, judgeMode: 'bot', judgeBotId: '10008' }));
    await f.ok(f.rpc('10001', 'game.publish', { gameId: g.gameId }));
    for (const who of f.ids.slice(1)) await f.ok(f.rpc(who, 'game.join', { gameId: g.gameId }));
    f.set(f.now + 60000);
    for (const who of f.ids) await f.ok(f.rpc(who, 'game.checkin', { gameId: g.gameId }));
    const limited = disable === 'player' ? '10007' : '10008';
    await f.cap(limited, 0);
    f.set(Date.parse(g.scheduledAt)); f.app.tickGames();
    const game = f.app.store.get('games', g.gameId);
    assert.equal(game.status, 'night_wolf');
    assert.equal(game.participants.length, disable === 'player' ? 6 : 7);
    assert.equal(game.judgeMode, disable === 'judge' ? 'program' : 'bot');
    for (const who of f.ids) assert.equal((await f.ok(f.rpc(who, 'game.rules'))).usedToday, who === limited ? 0 : 1);
    if (disable === 'player') assert.equal(game.participants.includes(limited), false);
  } finally { await f.close(); }
});

test('扩展人类配置同步上限，规则及面板返回真实额度，bot 参数不能覆盖，H 账号保持独立', async () => {
  const f = await fixture();
  const cfg = { ...structuredClone(STARPOST_DEFAULTS), enabled: true, botId: '10001', serverUrl: f.base(), maxWerewolfGamesPerDay: 9 };
  const world = new StarpostWorld(cfg, f.dir, f.dir, f.dir, 'Asia/Shanghai', () => f.keys['10001'], () => f.now);
  try {
    const schema = STARPOST_CONFIG_GROUP.schema.properties!['worlds.starpost.maxWerewolfGamesPerDay'];
    assert.equal(schema.type, 'integer'); assert.equal(STARPOST_DEFAULTS.maxWerewolfGamesPerDay, 5);
    const call = familyTool(world, 'werewolf');
    const rules = () => call.handler({ action: 'rules', maxWerewolfGamesPerDay: 999, limits: { maxWerewolfGamesPerDay: 999 } }, {} as never);
    assert.equal(JSON.parse(String(await rules())).dailyLimit, 9);
    assert.equal((await world.webUi().invoke!('viewer', 'gameRules', []) as any).remainingToday, 9);
    cfg.maxWerewolfGamesPerDay = 0;
    assert.equal(JSON.parse(String(await rules())).dailyLimit, 0);
    const blocked = await call.handler({ action: 'match', operation: 'join', maxPlayers: 6, maxWerewolfGamesPerDay: 999 }, {} as never) as any;
    assert.equal(blocked.failed, true);
    const raw = await f.ok(f.rpc('10001', 'game.rules', { maxWerewolfGamesPerDay: 999 }));
    assert.equal(raw.dailyLimit, 0);
    const loginResponse = await fetch(f.base() + '/mobile/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botId: '10001', credential: f.keys['10001'] }) });
    const login = await f.ok(Promise.resolve(await loginResponse.json()));
    const status = await fetch(f.base() + '/mobile/rpc', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.accessToken}` }, body: JSON.stringify({ action: 'human.status', limits: { maxWerewolfGamesPerDay: 999 } }) });
    const human = await f.ok(Promise.resolve(await status.json()));
    assert.equal(human.rules.dailyLimit, null); assert.equal(human.rules.remainingToday, null); assert.equal(human.rules.usedToday, 0);
  } finally { await world.stop(); await f.close(); }
});
