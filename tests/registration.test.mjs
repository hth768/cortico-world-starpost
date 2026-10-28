import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';

test('免码注册、ID 和昵称凭据登录、旧账号补录哈希', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-register-'));
  const keys = { 10001: 'a'.repeat(32) };
  let app = createStarpostServer({ file: join(dir, 'data.json'), keys, port: 0 });
  await app.listen();
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body, who, token) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { 'x-starpost-id': who, authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, ...await response.json() };
  };
  const installationId = randomUUID(), token = 'b'.repeat(64);
  try {
    assert.equal((await post('/register', { installationId, token })).result.botId, '10002');
    assert.equal((await post('/register', { installationId, token })).result.botId, '10002');
    assert.equal((await post('/register', { installationId, token: 'c'.repeat(64) })).status, 409);
    assert.equal((await post('/login', { identifier: '10002', token })).result.botId, '10002');
    assert.equal((await post('/login', { identifier: '10002', token: 'bad-token'.padEnd(64, 'x') })).status, 401);
    await post('/rpc', { action: 'profile.update', args: { nickname: '小星' } }, '10002', token);
    assert.equal((await post('/login', { identifier: '小星', token })).result.botId, '10002');
    assert.equal((await post('/credential/claim', {}, '10001', keys[10001])).result.botId, '10001');
    assert.equal(app.store.get('credentials', '10001').tokenHash, createHash('sha256').update(keys[10001]).digest('hex'));
    assert.equal(JSON.stringify(app.store.entries('credentials')).includes(keys[10001]), false);
    await app.close(); app = createStarpostServer({ file: join(dir, 'data.json'), keys, port: 0 }); await app.listen();
    base = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await post('/login', { identifier: '10001', token: keys[10001] })).result.botId, '10001');
    assert.equal((await post('/login', { identifier: '小星', token })).result.botId, '10002');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('第 500 个账号可注册，第 501 个收到满额提示；重试不再占位', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-full-'));
  const app = createStarpostServer({ file: join(dir, 'data.json'), keys: { 10001: 'a'.repeat(32) }, port: 0 });
  try {
    app.store.transaction(() => {
      for (let i = 10002; i <= 10499; i++) app.store.put('accounts', String(i), { installationId: randomUUID(), tokenHash: '0'.repeat(64) });
      app.store.put('meta', 'nextBotId', 10500);
    });
    await app.listen();
    const register = async (installationId, token) => {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installationId, token }) });
      return { status: response.status, ...await response.json() };
    };
    const installationId = randomUUID(), token = 'f'.repeat(64);
    assert.equal((await register(installationId, token)).result.botId, '10500');
    assert.equal((await register(installationId, token)).result.botId, '10500');
    const next = await register(randomUUID(), 'e'.repeat(64));
    assert.equal(next.status, 409);
    assert.match(next.error, /目前注册已满，后续会开放更多名额/);
    assert.equal(app.store.get('meta', 'nextBotId'), 10501);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
