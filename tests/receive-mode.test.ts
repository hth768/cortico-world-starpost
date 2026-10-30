import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';
import { STARPOST_DEFAULTS } from '../src/config.ts';
import { StarpostWorld } from '../src/world.ts';

for (const receiveMode of ['active', 'passive'] as const) test(`${receiveMode} 模式只使用所选聊天接收路径`, async () => {
  const dir = mkdtempSync(join(tmpdir(), `starpost-${receiveMode}-`));
  const keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32) };
  const app = createStarpostServer({ file: join(dir, 'relay.json'), keys, port: 0 });
  await app.listen(); app.store.befriend('10001', '10002');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const config = { ...structuredClone(STARPOST_DEFAULTS), enabled: true, receiveMode, botId: '10001', serverUrl: base, pollIntervalMs: 300000, deliveryIntervalMs: 1000 };
  let now = Date.parse('2026-10-30T00:00:00Z'), cursor = 0;
  const pushed: string[] = [], promoted: number[] = [];
  const world = new StarpostWorld(config, dir, dir, dir, 'Asia/Shanghai', () => keys[10001], () => now);
  const host = { pushEvent: async (event: { type: string }) => { pushed.push(event.type); return { cursor: ++cursor }; }, promotePending: async (through: number) => { promoted.push(through); return true; } } as never;
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
    } else {
      assert.equal(pushed.includes('starpost.message'), true);
      now += 1000; await (world as unknown as { poll(): Promise<void> }).poll();
      assert.equal(promoted.length, 1);
      const denied = await inbox.handler({ action: 'peek' }, {} as never) as { failed: boolean; text: string };
      assert.equal(denied.failed, true);
      assert.match(denied.text, /被动投递模式/);
    }
  } finally { await world.stop(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
