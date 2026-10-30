import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';
import { STARPOST_DEFAULTS } from '../src/config.ts';
import { StarpostWorld } from '../src/world.ts';
import { randomUUID } from 'node:crypto';

for (const receiveMode of ['active', 'passive', 'mixed'] as const) test(`${receiveMode} 重新上线仅提醒积压，会话和条数自主选择，部分读取可跨重启续看`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-backlog-'));
  const keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32) };
  const clock = () => Date.parse('2026-10-31T18:00:00+08:00');
  const app = createStarpostServer({ file: join(dir, 'relay.json'), keys, port: 0, clock });
  await app.listen(); app.store.befriend('10001', '10002');
  const groupId = randomUUID();
  app.store.saveGroup({ id: groupId, owner: '10002', name: '积压测试群', members: ['10001', '10002'] });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const config = { ...structuredClone(STARPOST_DEFAULTS), receiveMode, botId: '10001', serverUrl: base, pollIntervalMs: 300000 };
  const events: Array<{ type: string; text: string; blobs?: unknown[] }> = [];
  const host = { pushEvent: async (event: any) => { events.push(event); return { cursor: events.length }; } } as never;
  const create = () => new StarpostWorld(config, dir, dir, dir, 'Asia/Shanghai', () => keys[10001], clock);
  let world = create();
  const send = async (kind: string, target: string, text: string) => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keys[10002]}`, 'x-starpost-id': '10002' },
      body: JSON.stringify({ action: 'message.send', args: { kind, target, text } }) });
    const result = await response.json(); assert.equal(result.ok, true, result.error);
  };
  const call = (args: Record<string, unknown>) => world.tools().find(t => t.name === 'starpost_inbox')!.handler(args, {} as never);
  const peek = async () => JSON.parse(String(await call({ action: 'peek' })));
  try {
    await world.start(host); await world.stop(); events.length = 0;
    for (let i = 1; i <= 3; i++) await send('private', '10001', `私聊${i}`);
    for (let i = 1; i <= 2; i++) await send('group', groupId, `群聊${i}`);
    world = create(); await world.start(host);
    assert.equal(events.some(event => event.type === 'starpost.message'), false);
    const notice = events.find(event => event.type === 'starpost.inbox_backlog')!;
    assert.match(notice.text, /积压 5 条/); assert.match(notice.text, /上下文/);
    const list = await peek();
    assert.deepEqual(list.conversations.map((c: any) => c.unread).sort(), [2, 3]);
    assert.match(list.contextNotice, /上下文/);
    const first = String(await call({ action: 'read', kind: 'private', target: '10002', limit: 1 }));
    assert.match(first, /私聊1/); assert.doesNotMatch(first, /私聊2|群聊1/);
    await send('group', groupId, '群聊3'); await (world as any).poll();
    assert.equal(events.some(event => event.type === 'starpost.message'), false);
    app.store.emit(['10001'], 'owner.message', { text: '手机发来的消息', prefix: '以下消息为主人通过星邮向你发送的消息' });
    await (world as any).poll();
    assert.ok(events.some(event => event.type === 'starpost.owner_message'));
    assert.equal(events.some(event => event.type === 'starpost.message'), false);
    await world.stop(); world = create(); await world.start(host);
    assert.equal((await peek()).conversations.find((c: any) => c.kind === 'private').unread, 2);
    const second = String(await call({ action: 'read', kind: 'private', target: '10002', limit: 1 }));
    assert.match(second, /私聊2/); assert.doesNotMatch(second, /私聊1|私聊3/);
    await call({ action: 'read', kind: 'private', target: '10002', limit: 50 });
    assert.equal((await peek()).conversations.some((c: any) => c.kind === 'private'), false);
    assert.equal((await peek()).conversations[0].unread, 3);
    assert.equal(events.some(event => event.type === 'starpost.message'), false);
    await send('private', '10001', '恢复在线消息');
    await (world as any).poll();
    assert.equal(events.some(event => event.type === 'starpost.message' && event.text.includes('恢复在线消息')), receiveMode !== 'active');
    if (receiveMode === 'mixed') {
      const client = world as any, original = client.rpc;
      client.rpc = async function(action: string, ...args: unknown[]) {
        if (action === 'events') throw new Error('模拟网络断开');
        return original.call(this, action, ...args);
      };
      try { await client.poll(); } finally { client.rpc = original; }
      await send('private', '10001', '网络断线后的消息');
      await client.poll();
      assert.equal(events.some(event => event.type === 'starpost.message' && event.text.includes('网络断线后的消息')), false);
      assert.equal((await peek()).conversations.find((c: any) => c.kind === 'private').unread, 1);
    }
  } finally { await world.stop(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const receiveMode of ['active', 'passive'] as const) test(`${receiveMode} 模式只使用所选聊天接收路径`, async () => {
  const dir = mkdtempSync(join(tmpdir(), `starpost-${receiveMode}-`));
  const keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32), 10003: 'c'.repeat(32) };
  const app = createStarpostServer({ file: join(dir, 'relay.json'), keys, port: 0 });
  await app.listen(); app.store.befriend('10001', '10002');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const config = { ...structuredClone(STARPOST_DEFAULTS), enabled: true, receiveMode, botId: '10001', serverUrl: base, emojiDir: dir, pollIntervalMs: 300000, deliveryIntervalMs: 1000 };
  let now = Date.parse('2026-10-30T00:00:00Z'), cursor = 0;
  const pushed: string[] = [], images: Array<{ blobs?: Array<{ bytes: Uint8Array }> }> = [], promoted: number[] = [];
  const world = new StarpostWorld(config, dir, dir, dir, 'Asia/Shanghai', () => keys[10001], () => now);
  const host = { pushEvent: async (event: { type: string; blobs?: Array<{ bytes: Uint8Array }> }) => { pushed.push(event.type); if (event.type === 'starpost.inbox_image') images.push(event); return { cursor: ++cursor }; }, promotePending: async (through: number) => { promoted.push(through); return true; } } as never;
  try {
    await world.start(host);
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-starpost-id': '10002', authorization: `Bearer ${keys[10002]}` }, body: JSON.stringify({ action: 'message.send', args: { kind: 'private', target: '10001', text: '测试接收模式' } }) });
    assert.equal((await response.json()).ok, true);
    await (world as unknown as { poll(): Promise<void> }).poll();
    const inbox = world.tools().find(tool => tool.name === 'starpost_inbox')!;
    if (receiveMode === 'active') {
      assert.equal(pushed.includes('starpost.message'), false);
      assert.equal(promoted.length, 0);
      assert.equal(JSON.parse(String(await inbox.handler({ action: 'peek' }, {} as never))).conversations[0].unread, 1);
      assert.match(String(await inbox.handler({ action: 'read', kind: 'private', target: '10002' }, {} as never)), /测试接收模式/);
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=';
      const picture = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-starpost-id': '10002', authorization: `Bearer ${keys[10002]}` }, body: JSON.stringify({ action: 'message.send', args: { kind: 'private', target: '10001', text: '图片', image: { mime: 'image/png', base64: png } } }) });
      const sent = await picture.json(); assert.equal(sent.ok, true);
      await (world as unknown as { poll(): Promise<void> }).poll();
      const read = String(await inbox.handler({ action: 'read', kind: 'private', target: '10002' }, {} as never));
      assert.match(read, /"sticker":"/);
      assert.equal(images.length, 1);
      assert.equal(images[0].blobs?.[0].bytes.length, Buffer.from(png, 'base64').length);
      const forbidden = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-starpost-id': '10003', authorization: `Bearer ${keys[10003]}` }, body: JSON.stringify({ action: 'chat.image', args: { kind: 'private', target: '10002', messageId: sent.result.id } }) });
      assert.equal(forbidden.status, 403);
    } else {
      assert.equal(pushed.includes('starpost.message'), true);
      now += 1000; await (world as unknown as { poll(): Promise<void> }).poll();
      assert.equal(promoted.length, 1);
      assert.equal(JSON.parse(String(await inbox.handler({ action: 'peek' }, {} as never))).conversations.length, 0);
      const denied = await inbox.handler({ action: 'read', kind: 'private', target: '10002' }, {} as never) as { failed: boolean; text: string };
      assert.equal(denied.failed, true);
      assert.match(denied.text, /被动投递模式/);
    }
  } finally { await world.stop(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
