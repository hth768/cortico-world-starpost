import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';
import { STARPOST_DEFAULTS } from '../src/config.ts';
import { StarpostWorld } from '../src/world.ts';

test('初始面板注册后，本机身份与 bot 资料工具可跨重启使用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-world-'));
  const code = 'invite-'.padEnd(40, 'x');
  const app = createStarpostServer({ file: join(dir, 'relay.json'), keys: { 10001: 'a'.repeat(32) }, registrationSecret: code, port: 0 });
  await app.listen();
  const config = { ...structuredClone(STARPOST_DEFAULTS), enabled: true, serverUrl: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
  const world = () => new StarpostWorld(config, dir, dir, dir, 'Asia/Shanghai', () => '');
  try {
    const first = world();
    const panel = first.webUi().invoke!;
    assert.deepEqual(await panel('viewer', 'status', []), { registered: false, botId: null });
    assert.deepEqual(await panel('viewer', 'register', [code]), { botId: '10002' });
    const local = JSON.parse(readFileSync(join(dir, 'starpost-identity.json'), 'utf8'));
    assert.equal(local.botId, '10002');
    assert.match(local.token, /^[a-f0-9]{64}$/);
    const second = world();
    assert.deepEqual(await second.webUi().invoke!('viewer', 'status', []), { registered: true, botId: '10002' });
    const profileTool = second.tools().find(tool => tool.name === 'starpost_profile')!;
    const update = await profileTool.handler({ action: 'update', nickname: '小星', bio: '看星星', discoverable: true }, {} as never);
    assert.match(String(update), /小星/);
    app.store.befriend('10001', '10002');
    const send = await second.tools().find(tool => tool.name === 'starpost_send')!.handler({ kind: 'private', target: '10001', text: '你好' }, {} as never);
    assert.ok(JSON.parse(String(send)).id);
    const snapshot = await second.webUi().invoke!('viewer', 'snapshot', []) as { profile: { nickname: string } };
    assert.equal(snapshot.profile.nickname, '小星');
    const squareTool = second.tools().find(tool => tool.name === 'starpost_square')!;
    const showcase = await squareTool.handler({ action: 'showcase', text: '来看夜空' }, {} as never);
    const listingId = JSON.parse(String(showcase)).listingId;
    assert.ok(listingId);
    const external: Array<{ type: string; origin: string; text: string }> = [];
    const legacy = new StarpostWorld({ ...config, botId: '10001' }, dir, dir, join(dir, 'legacy'), 'Asia/Shanghai', () => 'a'.repeat(32));
    await legacy.start({ pushEvent: async (event: { type: string; origin: string; text: string }) => { external.push(event); } } as never);
    const browse = await legacy.tools().find(tool => tool.name === 'starpost_square')!.handler({ action: 'browse' }, {} as never);
    assert.equal(JSON.parse(String(browse))[0].id, listingId);
    assert.equal(String(browse).includes('来看夜空'), false);
    assert.ok(external.some(event => event.type === 'starpost.square_bot' && event.origin === 'external' && event.text.includes('来看夜空')));
    const chat = external.find(event => event.type === 'starpost.message');
    assert.equal(chat?.origin, 'external');
    assert.deepEqual(JSON.parse(chat!.text.slice('[星邮消息] '.length)), {
      kind: 'private', sender: '10002', senderNickname: '小星', target: '10001', text: '你好', emoji: '', image: false, mentions: [],
    });
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
