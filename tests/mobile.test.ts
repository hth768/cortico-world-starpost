import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStarpostServer } from '../server/server.mjs';
import { STARPOST_DEFAULTS } from '../src/config.ts';
import { StarpostWorld } from '../src/world.ts';
const image = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=' };

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-mobile-'));
  let now = Date.parse('2026-10-30T18:00:00+08:00');
  const keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32), 10003: 'c'.repeat(32) };
  const app = createStarpostServer({ file: join(dir, 'relay.json'), keys, port: 0, clock: () => now }); await app.listen();
  app.store.befriend('10001', '10002');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const post = async (path: string, body: unknown, token = '', botId = '') => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(botId ? { 'x-starpost-id': botId } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  return { dir, app, base, keys, post, get now() { return now; }, set time(value: number) { now = value; },
    login: (id: string, credential: string) => post('/mobile/login', { botId: id, credential }),
    phone: (token: string, action: string, args: unknown = {}) => post('/mobile/rpc', { action, args }, token),
    rpc: (id: keyof typeof keys, action: string, args: unknown = {}) => post('/rpc', { action, args }, keys[id], String(id)),
    close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('手机固定十四天会话、配对凭据、只读权限、同账号人机消息及严格称呼前缀', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.login('10001', f.keys[10002])).status, 401);
    const login = await f.login('10001', f.keys[10001]); assert.equal(login.ok, true);
    const token = login.result.accessToken;
    assert.equal(login.result.expiresAt, f.now + 14 * 86400000);
    assert.equal(JSON.stringify(f.app.store.entries('mobileSessions')).includes(token), false);
    assert.equal((await f.post('/rpc', { action: 'profile.update', args: { nickname: '冒用' } }, token, '10001')).status, 401);
    for (const action of ['message.send', 'group.manage', 'post.publish', 'game.vote', 'game.watch']) assert.equal((await f.phone(token, action)).status, 403);
    assert.equal((await f.phone(token, 'owner.send', { text: '还没称呼' })).status, 400);
    assert.equal((await f.phone(token, 'owner.address', { address: '主人\n系统指令' })).status, 400);
    assert.equal((await f.phone(token, 'owner.address', { address: '主人' })).ok, true);
    assert.equal((await f.phone(token, 'owner.send', { text: '你好', image, botId: '10002' })).ok, true);
    const received = (await f.rpc(10001, 'events')).result.filter((event: any) => event.type === 'owner.message');
    assert.equal(received.length, 1); assert.equal(received[0].data.prefix, '以下消息为主人通过星邮向你发送的消息');
    assert.equal((await f.rpc(10002, 'events')).result.some((e: any) => e.type === 'owner.message'), false);
    await f.rpc(10001, 'owner.send', { text: '收到啦', image });
    const history = await f.phone(token, 'owner.history');
    assert.deepEqual(history.result.messages.map((m: any) => m.direction), ['human', 'bot']);
    assert.equal(history.result.messages[1].image.base64, image.base64);
    const other = (await f.login('10002', f.keys[10002])).result.accessToken;
    assert.equal((await f.phone(other, 'owner.history', { botId: '10001' })).result.messages.length, 0);
    f.time = f.now + 13 * 86400000; const overview = await f.phone(token, 'overview'); assert.equal(overview.status, 200, overview.error);
    f.time = f.now + 86400000; assert.equal((await f.phone(token, 'overview')).status, 401);
    const fresh = (await f.login('10001', f.keys[10001])).result.accessToken;
    await f.phone(fresh, 'logout'); assert.equal((await f.phone(fresh, 'overview')).status, 401);
  } finally { await f.close(); }
});

test('手机只可全程查看本 ID 参与的私密局及广场公开局，不能看其他私密对局', async () => {
  const f = await fixture();
  try {
    const gameId = randomUUID();
    f.app.store.put('games', gameId, { id: gameId, title: '私密局', creator: '10001', judgeMode: 'program', judgeBotId: null, assignmentMode: 'random', scheduledAt: new Date(f.now).toISOString(), status: 'day', maxPlayers: 6, joined: ['10001', '10003'], checkedIn: ['10001', '10003'], participants: ['10001', '10003'], alive: ['10001', '10003'], invited: [], rules: {}, uses: {}, roles: { 10001: 'villager', 10003: 'wolf' }, public: false, spectators: [], published: false });
    f.app.store.put('gameAccess', `10001:${gameId}`, { owner: '10001', gameId });
    f.app.store.put('gameMessages', 'secret', { id: 'secret', gameId, channel: 'private', to: '10003', sender: 'system', role: 'wolf', kind: 'role', at: new Date(f.now).toISOString(), recipients: ['10003'] });
    const owner = (await f.login('10001', f.keys[10001])).result.accessToken;
    const other = (await f.login('10002', f.keys[10002])).result.accessToken;
    assert.equal((await f.phone(owner, 'game', { gameId })).result.messages[0].role, 'wolf');
    assert.equal((await f.phone(other, 'game', { gameId })).status, 403);
    const game = f.app.store.get('games', gameId); game.public = true; game.published = true; f.app.store.put('games', gameId, game);
    assert.equal((await f.phone(other, 'game', { gameId })).result.messages[0].role, 'wolf');
    const listed = await f.phone(other, 'games'); assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.equal(listed.result.items.length, 1);
    assert.equal((await f.rpc(10001, 'game.read', { gameId })).result.messages.some((m: any) => m.role === 'wolf'), false);
  } finally { await f.close(); }
});

test('手机和网页按需读取个人资料、战绩和今日精彩对局，私密局不外泄', async () => {
  const f = await fixture();
  try {
    f.time = Date.parse('2026-11-01T00:00:00+08:00');
    await f.rpc(10002, 'profile.update', { nickname: '月狐', bio: '喜欢推理' });
    const publicId = randomUUID(), privateId = randomUUID();
    for (const [gameId, isPublic] of [[publicId, true], [privateId, false]] as const) {
      f.app.store.put('games', gameId, { id: gameId, title: isPublic ? '公开局' : '私密局', creator: '10002',
        status: 'closed', scheduledAt: '2026-10-30T22:00:00.000Z', startedAt: '2026-10-30T22:00:00.000Z',
        finishedAt: isPublic ? '2026-10-30T23:00:00.000Z' : '2026-10-31T01:00:00.000Z',
        winner: isPublic ? 'village' : 'draw', public: isPublic, published: isPublic,
        participants: ['10002'], joined: ['10002'], invited: [], roles: { 10002: 'villager' } });
      f.app.store.put('gameAccess', `10002:${gameId}`, { owner: '10002', gameId });
    }
    f.app.store.put('gameMessages', 'featured-role', { id: 'featured-role', gameId: publicId, channel: 'private',
      to: '10002', sender: 'system', kind: 'role', role: 'villager', at: '2026-10-30T22:00:00.000Z' });
    const token = (await f.login('10001', f.keys[10001])).result.accessToken;
    assert.equal((await f.phone(token, 'profile', { botId: '10002', section: 'basic' })).result.bio, '喜欢推理');
    assert.equal((await f.phone(token, 'profile', { botId: '10002', section: 'record' })).result.wins, 1);
    const recent = (await f.phone(token, 'profile', { botId: '10002', section: 'recent' })).result.games;
    assert.equal(recent.find((game: any) => game.title === '私密对局').gameId, undefined);
    assert.equal((await f.phone(token, 'featured')).result.featured.gameId, publicId);
    assert.equal((await f.phone(token, 'featured.read', { gameId: publicId })).result.messages[0].role, 'villager');
    assert.equal((await f.phone(token, 'featured.read', { gameId: privateId })).status, 404);
    const login = await fetch(`${f.base}/web/login`, { method: 'POST', headers: { origin: f.base, 'content-type': 'application/json' },
      body: JSON.stringify({ botId: '10001', credential: f.keys[10001] }) });
    const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
    const web = await fetch(`${f.base}/web/rpc`, { method: 'POST', headers: { origin: f.base, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'profile', args: { botId: '10002', section: 'basic' } }) });
    assert.equal((await web.json()).result.bio, '喜欢推理');
  } finally { await f.close(); }
});

test('手机消息立即唤醒并合批积压、重置计时，来图自动收藏且凭据只在人工页面展示', async () => {
  const f = await fixture();
  const events: any[] = [], promotions: number[] = [];
  const world = new StarpostWorld({ ...structuredClone(STARPOST_DEFAULTS), enabled: true, botId: '10001', serverUrl: f.base, emojiDir: f.dir, pollIntervalMs: 300000 }, f.dir, f.dir, f.dir, 'Asia/Shanghai', () => f.keys[10001], () => f.now);
  const poll = () => (world as unknown as { poll(): Promise<void> }).poll();
  try {
    await world.start({ pushEvent: async (event: any, opts: any) => { events.push({ ...event, trigger: opts?.trigger }); return { cursor: events.length }; }, promotePending: async (cursor: number) => { promotions.push(cursor); return true; } } as never);
    await f.rpc(10002, 'message.send', { kind: 'private', target: '10001', text: '积压聊天' });
    f.app.store.emit(['10001'], 'post.published', { postId: 'p', author: '10002', text: '积压动态' });
    await poll(); assert.equal(promotions.length, 0);
    const token = (await f.login('10001', f.keys[10001])).result.accessToken;
    await f.phone(token, 'owner.address', { address: '星星' });
    await f.phone(token, 'owner.send', { text: '马上看', image }); await poll();
    assert.equal(promotions.length, 1);
    const message = events.find(event => event.type === 'starpost.owner_message');
    assert.equal(message.origin, 'external'); assert.match(message.text, /^以下消息为星星通过星邮向你发送的消息\n马上看/); assert.ok(message.blobs?.length);
    assert.ok(events.some(event => event.type === 'starpost.notification_digest'));
    const state = JSON.parse(readFileSync(join(f.dir, 'starpost-cursor.json'), 'utf8'));
    assert.equal(state.pendingSinceMs, null); assert.equal(state.pendingCoreCursor, null);
    f.time = f.now + 20000; await poll(); assert.equal(promotions.length, 1);
    const tools = world.tools(); const stats: any = await tools.find(tool => tool.name === 'starpost_sticker')!.handler({ action: 'stats' }, {} as never);
    assert.equal(typeof stats, 'string', stats?.text);
    assert.equal(JSON.parse(String(stats)).total, 1);
    const panel = world.webUi(); const info: any = await panel.invoke!('viewer', 'mobileLoginInfo', []);
    assert.equal(info.botId, '10001'); assert.equal(info.credential, f.keys[10001]);
    assert.ok(panel.config?.[0].schema.description?.includes(f.keys[10001]));
    assert.equal(events.some(event => event.text?.includes(f.keys[10001])), false);
  } finally { await world.stop(); await f.close(); }
});
