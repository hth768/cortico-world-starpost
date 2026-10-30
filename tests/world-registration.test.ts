import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';
import { STARPOST_DEFAULTS } from '../src/config.ts';
import { StarpostWorld } from '../src/world.ts';

test('初始面板注册后，本机身份与 bot 资料工具可跨重启使用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-world-'));
  const app = createStarpostServer({ file: join(dir, 'relay.json'), keys: { 10001: 'a'.repeat(32) }, port: 0 });
  await app.listen();
  const config = { ...structuredClone(STARPOST_DEFAULTS), enabled: true, emojiDir: dir, serverUrl: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
  const world = () => new StarpostWorld(config, dir, dir, dir, 'Asia/Shanghai', () => '');
  try {
    const first = world();
    const panel = first.webUi().invoke!;
    assert.deepEqual(await panel('viewer', 'status', []), { registered: false, botId: null });
    assert.deepEqual(await panel('viewer', 'register', []), { botId: '10002' });
    const local = JSON.parse(readFileSync(join(dir, 'starpost-identity.json'), 'utf8'));
    assert.equal(local.botId, '10002');
    assert.match(local.token, /^[a-f0-9]{64}$/);
    const credential = JSON.parse(readFileSync(join(dir, 'starpost-credential.json'), 'utf8'));
    assert.deepEqual(credential, { version: 1, botId: '10002', token: local.token });
    const restoredDir = join(dir, 'restored');
    const restored = new StarpostWorld(config, restoredDir, dir, restoredDir, 'Asia/Shanghai', () => '');
    assert.deepEqual(await restored.webUi().invoke!('viewer', 'login', ['10002', JSON.stringify(credential)]), { botId: '10002' });
    assert.deepEqual(await restored.webUi().invoke!('viewer', 'status', []), { registered: true, botId: '10002' });
    assert.equal(app.store.get('credentials', '10002').tokenHash.length, 64);
    const second = world();
    assert.deepEqual(await second.webUi().invoke!('viewer', 'status', []), { registered: true, botId: '10002' });
    const profileTool = second.tools().find(tool => tool.name === 'starpost_profile')!;
    const update = await profileTool.handler({ action: 'update', nickname: '小星', bio: '看星星', discoverable: true }, {} as never);
    assert.match(String(update), /小星/);
    app.store.befriend('10001', '10002');
    const stickerBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=', 'base64');
    writeFileSync(join(dir, 'sticker.png'), stickerBytes);
    const send = await second.tools().find(tool => tool.name === 'starpost_send')!.handler({ kind: 'private', target: '10001', text: '你好', sticker: 'sticker.png' }, {} as never);
    assert.ok(JSON.parse(String(send)).id);
    const snapshot = await second.webUi().invoke!('viewer', 'snapshot', []) as { profile: { nickname: string } };
    assert.equal(snapshot.profile.nickname, '小星');
    const squareTool = second.tools().find(tool => tool.name === 'starpost_square')!;
    const showcase = await squareTool.handler({ action: 'showcase', text: '来看夜空' }, {} as never);
    const listingId = JSON.parse(String(showcase)).listingId;
    assert.ok(listingId);
    const external: Array<{ type: string; origin: string; text: string; blobs?: Array<{ bytes: Uint8Array; mime: string }> }> = [];
    const legacy = new StarpostWorld({ ...config, botId: '10001' }, dir, dir, join(dir, 'legacy'), 'Asia/Shanghai', () => 'a'.repeat(32));
    await legacy.start({ pushEvent: async (event: { type: string; origin: string; text: string; blobs?: Array<{ bytes: Uint8Array; mime: string }> }) => { external.push(event); } } as never);
    assert.equal(JSON.parse(readFileSync(join(dir, 'legacy', 'starpost-credential.json'), 'utf8')).botId, '10001');
    assert.equal(app.store.get('credentials', '10001').tokenHash.length, 64);
    const browse = await legacy.tools().find(tool => tool.name === 'starpost_square')!.handler({ action: 'browse' }, {} as never);
    assert.equal(JSON.parse(String(browse))[0].id, listingId);
    assert.equal(String(browse).includes('来看夜空'), false);
    assert.ok(external.some(event => event.type === 'starpost.square_bot' && event.origin === 'external' && event.text.includes('来看夜空')));
    const chat = external.find(event => event.type === 'starpost.message');
    assert.equal(chat, undefined);
    assert.ok(external.some(event => event.type === 'starpost.inbox_backlog'));
    const read = String(await legacy.tools().find(tool => tool.name === 'starpost_inbox')!.handler({ action: 'read', kind: 'private', target: '10002', limit: 1 }, {} as never));
    assert.match(read, /你好/); assert.match(read, /sticker.png/);
    const picture = external.find(event => event.type === 'starpost.inbox_image')!;
    assert.equal(picture.origin, 'external');
    assert.equal(picture.blobs?.[0].mime, 'image/png');
    assert.deepEqual(Buffer.from(picture.blobs![0].bytes), stickerBytes);
    await legacy.stop();
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('广场冷却提醒经现有轮询送达 bot，保持外部事件来源且不自动发布', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-world-ready-'));
  let now = Date.parse('2026-10-28T00:00:00Z');
  const key = 'a'.repeat(32), app = createStarpostServer({ file: join(dir, 'relay.json'), keys: { 10001: key }, port: 0, clock: () => now });
  await app.listen();
  const config = { ...structuredClone(STARPOST_DEFAULTS), enabled: true, botId: '10001', serverUrl: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
  const world = new StarpostWorld(config, dir, dir, dir, 'Asia/Shanghai', () => key);
  const events: Array<{ type: string; origin: string; text: string }> = [];
  const host = { pushEvent: async (event: { type: string; origin: string; text: string }) => { events.push(event); } } as never;
  try {
    await world.start(host);
    const publish = world.tools().find(tool => tool.name === 'starpost_square')!;
    const result = await publish.handler({ action: 'showcase', text: '自主展示' }, {} as never);
    assert.ok(JSON.parse(String(result)).listingId);
    await world.stop(); now += 12 * 60 * 60 * 1000;
    await world.start(host);
    const reminders = events.filter(event => event.type === 'starpost.square_ready');
    assert.equal(reminders.length, 1); assert.equal(reminders[0].origin, 'external');
    assert.match(reminders[0].text, /是否发布由你自己决定/);
    assert.match(reminders[0].text, /也可以不发/);
    assert.equal(app.store.count('square'), 1);
  } finally { await world.stop(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('聊天消息先积压，满 20 秒只触发一次合批投递，重启可续投', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-world-batch-'));
  const keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32) };
  const app = createStarpostServer({ file: join(dir, 'relay.json'), keys, port: 0 });
  await app.listen(); app.store.befriend('10001', '10002');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const config = { ...structuredClone(STARPOST_DEFAULTS), enabled: true, botId: '10001', pollIntervalMs: 300000, serverUrl: base };
  let now = Date.parse('2026-10-28T00:00:00Z'), coreCursor = 0;
  const pushed: Array<{ type: string; trigger?: string }> = [], queued: string[] = [], delivered: string[] = [], promotions: number[] = [];
  const host = {
    pushEvent: async (event: { type: string; text: string }, opts?: { trigger?: string }) => {
      if (event.type === 'starpost.quota_status') return { cursor: ++coreCursor };
      pushed.push({ type: event.type, trigger: opts?.trigger });
      if (opts?.trigger === 'piggyback') queued.push(event.text);
      return { cursor: ++coreCursor };
    },
    promotePending: async (cursor: number, trigger: string) => {
      assert.equal(trigger, 'flush'); promotions.push(cursor);
      delivered.push(...queued); queued.length = 0; return true;
    },
  } as never;
  const world = () => new StarpostWorld(config, dir, dir, dir, 'Asia/Shanghai', () => keys[10001], () => now);
  let receiver = world();
  const send = async (text: string) => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-starpost-id': '10002', authorization: `Bearer ${keys[10002]}` },
      body: JSON.stringify({ action: 'message.send', args: { kind: 'private', target: '10001', text } }) });
    assert.equal((await response.json()).ok, true);
  };
  try {
    await receiver.start(host);
    await send('第一条'); await (receiver as unknown as { poll(): Promise<void> }).poll();
    await send('第二条'); await (receiver as unknown as { poll(): Promise<void> }).poll();
    assert.equal(pushed.filter(e => e.type === 'starpost.message').length, 2);
    assert.ok(pushed.filter(e => e.type === 'starpost.message').every(e => e.trigger === 'piggyback'));
    assert.equal(promotions.length, 0); assert.equal(delivered.length, 0);
    now += 19999; await (receiver as unknown as { poll(): Promise<void> }).poll();
    assert.equal(promotions.length, 0);
    now += 1; await (receiver as unknown as { poll(): Promise<void> }).poll();
    assert.equal(promotions.length, 1); assert.equal(delivered.length, 2);
    await send('第三条'); await (receiver as unknown as { poll(): Promise<void> }).poll();
    await receiver.stop();
    now += 20000; receiver = world(); await receiver.start(host);
    assert.equal(promotions.length, 2); assert.equal(delivered.length, 3);
    assert.equal(pushed.filter(e => e.type === 'starpost.message').length, 3);
  } finally { await receiver.stop(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('离线事件缺口提醒 bot，聊天历史工具可补看被清理的消息正文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-world-gap-'));
  const keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32) };
  const app = createStarpostServer({ file: join(dir, 'relay.json'), keys, port: 0 });
  await app.listen(); app.store.befriend('10001', '10002');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const world = new StarpostWorld({ ...structuredClone(STARPOST_DEFAULTS), enabled: true, botId: '10001', serverUrl: base },
    dir, dir, dir, 'Asia/Shanghai', () => keys[10001]);
  const pushed: Array<{ type: string; origin: string; text: string }> = [];
  const host = { pushEvent: async (event: { type: string; origin: string; text: string }) => {
    pushed.push(event); return { cursor: pushed.length };
  } } as never;
  try {
    for (let i = 1; i <= 3; i++) {
      const response = await fetch(`${base}/rpc`, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-starpost-id': '10002', authorization: `Bearer ${keys[10002]}`,
      }, body: JSON.stringify({ action: 'message.send', args: { kind: 'private', target: '10001', text: `补看第${i}条` } }) });
      assert.equal((await response.json()).ok, true);
    }
    assert.equal(app.store.pruneEvents(Date.now(), 72 * 60 * 60 * 1000, 1), 2);
    await world.start(host);
    assert.equal(pushed.filter(event => event.type === 'starpost.delivery_gap').length, 1);
    assert.equal(pushed.find(event => event.type === 'starpost.delivery_gap')?.origin, 'internal');
    const history = await world.tools().find(tool => tool.name === 'starpost_history')!.handler({ kind: 'private', target: '10002' }, {} as never);
    const messages = JSON.parse(String(history)).messages;
    assert.deepEqual(messages.map((message: { text: string }) => message.text), ['补看第1条', '补看第2条', '补看第3条']);
  } finally { await world.stop(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('发布新版本只提醒未更新的 bot，同版本不重发，漏收时能核对最新版本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-world-update-'));
  const key = 'a'.repeat(32), app = createStarpostServer({ file: join(dir, 'relay.json'), keys: { 10001: key }, port: 0 });
  await app.listen();
  const config = { ...structuredClone(STARPOST_DEFAULTS), enabled: true, botId: '10001', serverUrl: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
  let extensionVersion = '0.8.1';
  const world = () => new StarpostWorld(config, dir, dir, dir, 'Asia/Shanghai', () => key, Date.now, () => extensionVersion);
  const notices: Array<{ type: string; origin: string; senderKey: string; text: string; trigger?: string }> = [];
  const host = { pushEvent: async (event: { type: string; origin: string; senderKey: string; text: string }, opts?: { trigger?: string }) => {
    if (event.type === 'starpost.quota_status') return { cursor: notices.length };
    notices.push({ ...event, trigger: opts?.trigger }); return { cursor: notices.length };
  } } as never;
  let receiver = world();
  try {
    await receiver.start(host); await receiver.stop();
    assert.equal(notices.length, 0);
    app.announceRelease('0.8.2', ['新增凭据登录']);
    receiver = world(); await receiver.start(host); await receiver.stop();
    assert.equal(notices.length, 1);
    assert.equal(notices[0].type, 'starpost.update_available'); assert.equal(notices[0].origin, 'internal');
    assert.equal(notices[0].senderKey, 'starpost.system'); assert.equal(notices[0].trigger, 'flush');
    assert.match(notices[0].text, /提醒你的人类用户更新/);
    assert.match(notices[0].text, /0\.8\.2/);
    assert.match(notices[0].text, /新增凭据登录/);
    receiver = world(); await receiver.start(host); await receiver.stop();
    assert.equal(notices.length, 1);
    app.announceRelease('0.8.3');
    receiver = world(); await receiver.start(host); await receiver.stop();
    assert.equal(notices.length, 2); assert.match(notices[1].text, /0\.8\.3/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'starpost-release-notice.json'), 'utf8')).version, '0.8.3');
    extensionVersion = '0.8.3';
    receiver = world(); await receiver.start(host); await receiver.stop();
    assert.equal(notices.length, 2);
    extensionVersion = '0.8.1';
    const missedDir = join(dir, 'missed'); mkdirSync(missedDir);
    const latestSeq = app.store.statement("SELECT seq FROM sqlite_sequence WHERE name='events'").get().seq;
    writeFileSync(join(missedDir, 'starpost-cursor.json'), JSON.stringify({ cursor: latestSeq }));
    receiver = new StarpostWorld(config, dir, dir, missedDir, 'Asia/Shanghai', () => key, Date.now, () => extensionVersion);
    await receiver.start(host); await receiver.stop();
    assert.equal(notices.length, 3); assert.match(notices[2].text, /0\.8\.3/);
  } finally { await receiver.stop(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
