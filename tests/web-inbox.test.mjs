import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';

test('主动查收只列可访问会话，按消息游标去重；网页 Cookie 只获手机端权限', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-web-inbox-'));
  const keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32), 10003: 'c'.repeat(32) };
  const app = createStarpostServer({ file: join(dir, 'data.json'), keys, port: 0 });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body, headers = {}) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { response, body: await response.json() };
  };
  const rpc = (who, action, args = {}) => post('/rpc', { action, args }, { authorization: `Bearer ${keys[who]}`, 'x-starpost-id': who });
  try {
    await rpc('10001', 'friend.request', { to: '10002' });
    await rpc('10002', 'friend.accept', { from: '10001' });
    assert.equal((await rpc('10001', 'message.send', { kind: 'private', target: '10002', text: '测试查收' })).body.ok, true);
    const peek = (await rpc('10002', 'inbox.peek', { after: {} })).body.result;
    assert.equal(peek.conversations.length, 1);
    assert.equal(peek.conversations[0].unread, 1);
    assert.equal(peek.conversations[0].target, '10001');
    const cursor = peek.conversations[0].latestCursor;
    assert.equal((await rpc('10002', 'inbox.peek', { after: { 'private:10001:10002': cursor } })).body.result.conversations.length, 0);
    assert.equal((await rpc('10003', 'inbox.peek', { after: {} })).body.result.conversations.length, 0);
    assert.equal((await rpc('10002', 'chat.history', { kind: 'private', target: '10001', after: 0 })).body.result.messages[0].text, '测试查收');
    const login = await post('/web/login', { botId: '10002', credential: keys[10002] }, { origin: base });
    assert.equal(login.response.status, 200);
    assert.equal(login.body.result.botId, '10002');
    assert.equal(login.body.result.accessToken, undefined);
    const cookie = login.response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
    const session = cookie.split(';')[0];
    const browser = (action, args = {}, origin = base) => post('/web/rpc', { action, args }, { origin, cookie: session });
    assert.equal((await browser('overview')).body.result.botId, '10002');
    assert.equal((await browser('owner.address', { address: '主人' })).body.result.address, '主人');
    assert.equal((await browser('overview')).body.result.ownerAddress, '主人');
    assert.equal((await browser('message.send', { kind: 'private', target: '10001', text: '越权' })).response.status, 403);
    assert.equal((await browser('overview', {}, 'https://evil.example')).response.status, 403);
    assert.equal((await browser('logout')).body.result.loggedOut, true);
    assert.equal((await browser('overview')).response.status, 401);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
