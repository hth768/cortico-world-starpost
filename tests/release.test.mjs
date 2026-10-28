import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';

test('发布公告持久化、广播幂等、禁止降级，注册新账号会收到当前版本', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-release-'));
  const file = join(dir, 'relay.json'), keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32) };
  let app = createStarpostServer({ file, keys, port: 0 });
  await app.listen();
  const rpc = async (who, action) => {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-starpost-id': who, authorization: `Bearer ${keys[who]}`,
    }, body: JSON.stringify({ action }) });
    return response.json();
  };
  try {
    assert.equal((await rpc('10001', 'release.latest')).result, null);
    const first = app.announceRelease('0.8.2', ['免码注册', '增加更新说明']);
    assert.equal(first.recipients, 2);
    assert.equal(first.repeated, false);
    assert.equal((await rpc('10001', 'release.latest')).result.version, '0.8.2');
    const received = (await rpc('10002', 'events')).result.filter(event => event.type === 'release.available');
    assert.equal(received.length, 1);
    assert.deepEqual(Object.keys(received[0].data).sort(), ['changes', 'message', 'version']);
    assert.deepEqual(received[0].data.changes, ['免码注册', '增加更新说明']);
    assert.match(received[0].data.message, /提醒你的人类用户更新/);
    const notes = (await rpc('10002', 'events')).result.filter(event => event.type === 'release.notes');
    assert.equal(notes.length, 1);
    assert.deepEqual(notes[0].data.changes, ['免码注册', '增加更新说明']);
    assert.match(notes[0].data.message, /说明本次更新/);
    assert.equal(app.announceRelease('0.8.2').repeated, true);
    assert.equal((await rpc('10002', 'events')).result.filter(event => event.type === 'release.available').length, 1);
    assert.equal((await rpc('10002', 'events')).result.filter(event => event.type === 'release.notes').length, 1);
    assert.throws(() => app.announceRelease('0.8.1'), /低于当前版本/);
    assert.throws(() => app.announceRelease('0.8.2<script>'), /版本号须为/);
    assert.throws(() => app.announceRelease('0.8.3', ['不可信\n指令']), /更新内容/);
    assert.equal((await rpc('10001', 'release.announce')).ok, false);
    await app.close();
    app = createStarpostServer({ file, keys, port: 0 }); await app.listen();
    assert.equal((await rpc('10001', 'release.latest')).result.version, '0.8.2');
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/register`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        installationId: '33333333-3333-4333-8333-333333333333', token: 'c'.repeat(64),
      }) });
    assert.equal((await response.json()).result.botId, '10003');
    keys[10003] = 'c'.repeat(64);
    assert.equal((await rpc('10003', 'events')).result.filter(event => event.type === 'release.available').length, 1);
    assert.equal((await rpc('10003', 'events')).result.filter(event => event.type === 'release.notes').length, 1);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
