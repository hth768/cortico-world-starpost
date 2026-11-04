import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';
import { STARPOST } from '../src/definition.ts';
import { normalizeBotId, STARPOST_DEFAULTS } from '../src/config.ts';

test('ID 输入兼容复制空白、全角数字和数值配置，不把昵称或 H 号当成 bot ID', () => {
  for (const input of ['10762', ' 10762\r\n', '\ufeff１０７６２ ', 10762]) assert.equal(normalizeBotId(input), '10762');
  for (const input of ['10000', '10762H', 'ID10762', '10 762', '10,762', '1.0762e4', '9999999999999', '昵称', {}, null]) assert.equal(normalizeBotId(input), null);
});

test('重装后旧配置不阻塞启用，原凭据登录保留账号、关系和注册名额', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-recovery-'));
  const key = 'b'.repeat(64), tokenHash = createHash('sha256').update(key).digest('hex');
  const app = createStarpostServer({ file: join(dir, 'relay.json'), keys: { 10001: 'a'.repeat(32) }, port: 0 });
  const worlds: ReturnType<typeof STARPOST.create>[] = [];
  const make = (name: string, botId = '', token = '') => {
    const dataDir = join(dir, name);
    const cfg = { ...structuredClone(STARPOST_DEFAULTS), enabled: true, botId, serverUrl: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
    const context = { cfg, dataDir, botDir: dataDir, packageDir: resolve('.'), timezone: 'Asia/Shanghai', secret: () => token } as Parameters<NonNullable<typeof STARPOST.preflight>>[0];
    assert.doesNotThrow(() => STARPOST.preflight!(context));
    const world = STARPOST.create(context); worlds.push(world);
    return { dataDir, world, invoke: (method: string, args: unknown[] = []) => world.webUi!().invoke!('viewer', method, args) };
  };
  try {
    app.store.put('accounts', '10762', { installationId: randomUUID(), tokenHash });
    app.store.put('credentials', '10762', { tokenHash });
    app.store.put('profiles', '10762', { nickname: '恢复测试', bio: '原资料', discoverable: false });
    app.store.befriend('10001', '10762');
    await app.listen();
    const accountCount = app.store.count('accounts'), nextId = app.store.get('meta', 'nextBotId');
    const credential = JSON.stringify({ version: 1, botId: '10762', token: key });
    for (const [i, botId] of ['10762', ' 10762 ', 'ID10762', '昵称', '10762H'].entries()) {
      const original = make(`reinstall-${i}`, botId);
      const before = await original.invoke('status') as { registered: boolean; recoveryHint: string };
      assert.equal(before.registered, false); assert.match(before.recoveryHint, /恢复/);
      await original.world.start!({ pushEvent: async () => {} } as never);
      await original.world.stop!();
      assert.equal(existsSync(join(original.dataDir, 'starpost-credential.json')), false);
      assert.deepEqual(await original.invoke('login', [' １０７６２\n', credential]), { botId: '10762' });
      assert.deepEqual(await original.invoke('status'), { registered: true, botId: '10762' });
      assert.deepEqual(JSON.parse(readFileSync(join(original.dataDir, 'starpost-credential.json'), 'utf8')), { version: 1, botId: '10762', token: key });
      const restart = make(`reinstall-${i}`, '错误的旧配置', 'unused'.repeat(6));
      assert.deepEqual(await restart.invoke('status'), { registered: true, botId: '10762' });
      const snapshot = await restart.invoke('overview') as { botId: string; friends: string[]; profile: { bio: string } };
      assert.equal(snapshot.botId, '10762'); assert.deepEqual(snapshot.friends, ['10001']); assert.equal(snapshot.profile.bio, '原资料');
    }
    const pasted = make('pasted', '10762');
    assert.deepEqual(await pasted.invoke('login', ['10762', ` ${key}\r\n`]), { botId: '10762' });
    const nickname = make('nickname');
    assert.deepEqual(await nickname.invoke('login', ['恢复测试', key]), { botId: '10762' });
    assert.equal(app.store.count('accounts'), accountCount);
    assert.equal(app.store.get('meta', 'nextBotId'), nextId);
  } finally {
    for (const world of worlds) await world.stop!();
    await app.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('恢复时拒绝错误凭据、错误 ID 及凭据文件账号不符，不落盘也不创建账号', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-recovery-auth-'));
  const key = 'b'.repeat(32), app = createStarpostServer({ file: join(dir, 'relay.json'), keys: { 10001: 'a'.repeat(32), 10762: key }, port: 0 });
  await app.listen();
  const dataDir = join(dir, 'client'), cfg = { ...structuredClone(STARPOST_DEFAULTS), enabled: true, serverUrl: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
  const world = STARPOST.create({ cfg, dataDir, botDir: dataDir, packageDir: resolve('.'), timezone: 'Asia/Shanghai', secret: () => '' } as never);
  try {
    for (const [identifier, credential] of [
      ['10762', 'c'.repeat(32)], ['10763', key], ['10762H', key],
      ['10762', '{broken'], ['10762', 'short'],
      ['10762', JSON.stringify({ version: 1, botId: '10763', token: key })],
      ['10762', JSON.stringify({ version: 1, botId: '10000', token: key })],
    ]) {
      await assert.rejects(() => world.webUi!().invoke!('viewer', 'login', [identifier, credential]));
      assert.equal(existsSync(join(dataDir, 'starpost-credential.json')), false);
      assert.equal(existsSync(join(dataDir, 'starpost-identity.json')), false);
      assert.equal(app.store.count('accounts'), 0);
    }
    // 原身份文件应优先于残留旧配置，包含凭据登录生成的较短旧密钥。
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'starpost-identity.json'), JSON.stringify({ installationId: randomUUID(), botId: '10762', token: key }));
    cfg.botId = '10763';
    assert.deepEqual(await world.webUi!().invoke!('viewer', 'status'), { registered: true, botId: '10762' });
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'starpost-credential.json'), 'utf8')).token, key);
  } finally {
    await world.stop!(); await app.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    rmSync(dir, { recursive: true, force: true });
  }
});
