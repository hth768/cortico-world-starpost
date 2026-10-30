import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';
import { STARPOST_DEFAULTS } from '../src/config.ts';
import { StarpostWorld } from '../src/world.ts';
import { familyTool } from './tool-invoke.ts';

test('统一工具按 family 和 action 调用狼人杀，房间正文作为外部事件，WebUI 只开放读取', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-world-werewolf-'));
  let now = Date.parse('2026-10-30T18:00:00+08:00');
  const key = 'a'.repeat(32);
  const app = createStarpostServer({ file: join(dir, 'relay.json'), keys: { 10001: key, 10002: 'b'.repeat(32) }, port: 0, clock: () => now });
  await app.listen(); app.store.befriend('10001', '10002');
  const world = new StarpostWorld({ ...structuredClone(STARPOST_DEFAULTS), enabled: true, botId: '10001',
    serverUrl: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` }, dir, dir, dir, 'Asia/Shanghai', () => key, () => now);
  const events: Array<{ type: string; origin: string; text: string; trigger?: string }> = [], promotions: number[] = [];
  try {
    await world.start({ pushEvent: async (event: { type: string; origin: string; text: string }, opts?: { trigger?: string }) => {
      events.push({ ...event, trigger: opts?.trigger }); return { cursor: events.length };
    }, promotePending: async (cursor: number) => { promotions.push(cursor); return true; } } as never);
    const tools = world.tools();
    assert.equal(tools.length, 1); assert.equal(tools[0].name, 'starpost_use');
    const mysteryHelp = JSON.parse(String(await tools[0].handler({ family: 'help', action: 'show', argsJson: '{"family":"mystery"}' }, {} as never)));
    assert.equal(mysteryHelp.family, 'mystery');
    assert.ok(mysteryHelp.parameters.properties.action.enum.includes('catalog'));
    const call = async (args: Record<string, unknown>) => JSON.parse(String(await familyTool(world, 'werewolf').handler(args, {} as never)));
    assert.equal((await call({ action: 'rules' })).dailyLimit, 5);
    const profile = familyTool(world, 'profile');
    assert.deepEqual(JSON.parse(String(await profile.handler({ action: 'read', section: 'record' }, {} as never))),
      { botId: '10001', wins: 0, losses: 0, draws: 0 });
    assert.equal(JSON.parse(String(await profile.handler({ action: 'read', section: 'basic' }, {} as never))).delivered, true);
    assert.ok(events.some(event => event.type === 'starpost.profile_view' && event.origin === 'external'));
    const square = familyTool(world, 'square');
    assert.equal(JSON.parse(String(await square.handler({ action: 'featured' }, {} as never))).totalGames, 0);
    const game = await call({ action: 'schedule', maxPlayers: 6, scheduledAt: '2026-10-30T18:10:00+08:00',
      sourceKind: 'private', sourceTarget: '10002', title: '外部标题 <script>' });
    const list = await call({ action: 'list' });
    assert.equal(list.games[0].gameId, game.gameId); assert.equal(JSON.stringify(list).includes('<script>'), false);
    await call({ action: 'read', gameId: game.gameId });
    const views = events.filter(event => event.type === 'starpost.game_view');
    assert.equal(views.length, 2); assert.ok(views.every(event => event.origin === 'external'));
    assert.match(views[0].text, /外部标题 <script>/);
    const panel = world.webUi().invoke!;
    assert.equal((await panel('viewer', 'gameList', []) as unknown[]).length, 1);
    await assert.rejects(panel('viewer', 'gameMessage', [game.gameId, 'human message']), /不支持/);
    app.store.emit(['10001'], 'game.public', { gameId: game.gameId, kind: 'chat', text: '讨论一', sender: '10002' });
    app.store.emit(['10001'], 'game.public', { gameId: game.gameId, kind: 'chat', text: '讨论二', sender: '10002' });
    app.store.emit(['10001'], 'game.public', { gameId: game.gameId, kind: 'day', day: 1 });
    const poll = () => (world as unknown as { poll(): Promise<void> }).poll();
    await poll();
    const gameEvents = events.filter(event => event.type === 'starpost.game_public');
    assert.deepEqual(gameEvents.map(event => event.trigger), ['piggyback', 'piggyback', undefined]);
    now += 19999; await poll(); assert.equal(promotions.length, 0);
    now++; await poll(); assert.equal(promotions.length, 1);
  } finally { await world.stop(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
