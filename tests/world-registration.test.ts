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
    await legacy.stop();
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
