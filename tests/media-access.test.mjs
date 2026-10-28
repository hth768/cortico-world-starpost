import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';
import { STARPOST_DEFAULTS } from '../src/config.ts';
import { StarpostWorld } from '../src/world.ts';

test('新版事件只发图片引用，下载按收件人鉴权；旧客户端和聊天历史仍可见图片', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-media-'));
  const keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32), 10003: 'c'.repeat(32) };
  const app = createStarpostServer({ file: join(dir, 'data.json'), keys, port: 0 });
  await app.listen(); app.store.befriend('10001', '10002');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = who => ({ 'x-starpost-id': who, authorization: `Bearer ${keys[who]}` });
  const rpc = async (who, action, args = {}) => (await fetch(`${base}/rpc`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers(who) },
    body: JSON.stringify({ action, args }) })).json();
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=', 'base64');
  const image = { mime: 'image/png', base64: bytes.toString('base64') };
  try {
    assert.equal((await rpc('10001', 'message.send', { kind: 'private', target: '10002', text: '一张图', image })).ok, true);
    const refEvent = (await rpc('10002', 'events', { mediaRefs: true })).result.find(event => event.type === 'message');
    assert.match(refEvent.data.image.mediaId, /^[a-f0-9]{64}$/);
    assert.equal(refEvent.data.image.base64, undefined);
    const url = `${base}/media/${refEvent.seq}`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: headers('10003') })).status, 404);
    const world = new StarpostWorld({ ...structuredClone(STARPOST_DEFAULTS), enabled: true, botId: '10002', serverUrl: base },
      dir, dir, dir, 'Asia/Shanghai', () => keys[10002]);
    const botEvents = [];
    await world.start({ modelFacts: { accepts: () => false }, pushEvent: async event => {
      botEvents.push(event); return { cursor: botEvents.length };
    } });
    assert.equal(botEvents.find(event => event.type === 'starpost.message')?.blobs, undefined);
    assert.equal((await (await fetch(`${base}/metrics`)).json()).mediaBytes, 0);
    await world.stop();
    const allowed = await fetch(url, { headers: headers('10002') });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), bytes);
    const legacy = (await rpc('10002', 'events')).result.find(event => event.type === 'message');
    assert.deepEqual(legacy.data.image, image);
    assert.equal((await rpc('10002', 'events', { since: refEvent.seq })).result.length, 0);
    assert.equal((await fetch(url, { headers: headers('10002') })).status, 404);
    const history = (await rpc('10002', 'chat.history', { kind: 'private', target: '10001' })).result;
    assert.deepEqual(history.messages[0].image, image);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
