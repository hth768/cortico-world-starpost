import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';

test('bot 权限、消息限速、漂流瓶和动态配额跨重启保持', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-'));
  const keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32), 10003: 'c'.repeat(32) };
  let app = createStarpostServer({ file: join(dir, 'data.json'), keys, port: 0 });
  await app.listen();
  let base = `http://127.0.0.1:${app.server.address().port}`;
  async function rpc(who, action, args = {}, limits = { private: 10, groups: 5 }, key = keys[who]) {
    const r = await fetch(`${base}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'x-starpost-id': who, 'content-type': 'application/json' }, body: JSON.stringify({ action, args, limits }) });
    return { status: r.status, ...(await r.json()) };
  }
  try {
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true });
    assert.equal((await rpc('10001', 'message.send', { kind: 'private', target: '10002', text: 'hi' })).ok, false);
    assert.equal((await rpc('10001', 'snapshot', {}, undefined, 'wrong')).status, 401);
    assert.equal((await rpc('10001', 'friend.request', { to: '10002' })).ok, true);
    assert.equal((await rpc('10002', 'friend.accept', { from: '10001' })).ok, true);
    assert.equal((await rpc('10001', 'profile.update', { nickname: '星鱼' })).ok, true);
    assert.equal((await rpc('10001', 'message.send', { kind: 'private', target: '10002', text: '先说', maxConsecutiveBotTurns: 1 })).ok, true);
    assert.equal((await rpc('10001', 'profile.update', { nickname: '月猫' })).ok, true);
    assert.equal((await rpc('10001', 'message.send', { kind: 'private', target: '10002', text: '连说', maxConsecutiveBotTurns: 1 })).ok, false);
    assert.equal((await rpc('10002', 'message.send', { kind: 'private', target: '10001', text: '接话', maxConsecutiveBotTurns: 1 })).ok, true);
    assert.equal((await rpc('10001', 'message.send', { kind: 'private', target: '10002', text: '再说', maxConsecutiveBotTurns: 1 })).ok, true);
    assert.equal((await rpc('10001', 'message.send', { kind: 'private', target: '10002', text: '今晚一起看星星呀', proactive: true })).ok, true);
    assert.equal((await rpc('10001', 'message.send', { kind: 'private', target: '10002', text: '今晚一起看星星呀', proactive: true })).ok, false);
    assert.equal((await rpc('10001', 'friend.request', { to: '10003' })).ok, true);
    assert.equal((await rpc('10003', 'friend.accept', { from: '10001' }, { private: 0, groups: 5 })).ok, false);
    const g = (await rpc('10001', 'group.create', { name: '夜航', members: ['10002'] })).result;
    assert.ok(g.id);
    assert.equal((await rpc('10003', 'message.send', { kind: 'group', target: g.id, text: 'x' })).status, 404);
    assert.equal((await rpc('10001', 'message.send', { kind: 'group', target: g.id, text: 'hi', mentions: ['10002'], maxPerWindow: 1 })).ok, true);
    assert.equal((await rpc('10001', 'message.send', { kind: 'group', target: g.id, text: 'again', maxPerWindow: 1 })).ok, false);
    const received = (await rpc('10002', 'events')).result;
    assert.ok(received.some(e => e.type === 'message' && e.data.mentions.includes('10002')));
    const privateMessage = received.find(e => e.type === 'message' && e.data.text === '先说');
    assert.equal(privateMessage.data.sender, '10001');
    assert.equal(privateMessage.data.senderNickname, '星鱼');
    assert.equal(privateMessage.data.target, '10002');
    const groupMessage = received.find(e => e.type === 'message' && e.data.kind === 'group');
    assert.equal(groupMessage.data.sender, '10001');
    assert.equal(groupMessage.data.senderNickname, '月猫');
    assert.equal(groupMessage.data.target, g.id);
    assert.equal((await rpc('10002', 'snapshot')).result.messages.find(m => m.text === '先说').senderNickname, '星鱼');
    assert.equal((await rpc('10001', 'snapshot')).result.messages.find(m => m.text === '接话').senderNickname, '');
    app.store.emit(['10002'], 'message', { kind: 'private', target: '10002', sender: '10001', text: '旧格式' });
    assert.equal((await rpc('10002', 'events')).result.find(e => e.data.text === '旧格式').data.senderNickname, '月猫');
    assert.equal((await rpc('10001', 'poke', { to: '10002' })).ok, true);
    const bottle = (await rpc('10001', 'bottle.throw', { text: '你好，海' })).result;
    assert.equal((await rpc('10001', 'bottle.pick')).result.bottle, null);
    assert.equal((await rpc('10002', 'bottle.pick')).result.bottleId, bottle.id);
    assert.ok((await rpc('10002', 'events')).result.some(e => e.type === 'bottle.found' && e.data.text === '你好，海'));
    assert.equal((await rpc('10002', 'bottle.reply', { bottleId: bottle.id, text: '你好' })).ok, true);
    const p = (await rpc('10001', 'post.publish', { text: '今天的事' })).result;
    assert.equal((await rpc('10002', 'post.comment', { postId: p.id, text: '真好' })).ok, true);
    assert.equal((await rpc('10003', 'snapshot')).result.posts.length, 0);
    await rpc('10001', 'post.publish', { text: '第二条' }); await rpc('10001', 'post.publish', { text: '第三条' });
    assert.equal((await rpc('10001', 'post.publish', { text: '第四条' })).ok, false);
    await app.close(); app = createStarpostServer({ file: join(dir, 'data.json'), keys, port: 0 }); await app.listen(); base = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await rpc('10001', 'snapshot')).result.posts.length, 3);
    assert.equal((await rpc('10001', 'post.delete', { postId: p.id })).ok, true);
    assert.equal((await rpc('10002', 'snapshot')).result.posts.length, 2);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('注册码分配连续 ID，资料可见性和搜索跨重启保持', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-register-'));
  const file = join(dir, 'data.json');
  const keys = { 10001: 'a'.repeat(32) };
  const registrationSecret = 'invite-'.padEnd(40, 'x');
  let app = createStarpostServer({ file, keys, registrationSecret, port: 0 });
  await app.listen();
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const register = async (installationId, token, code = registrationSecret) => {
    const response = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, installationId, token }) });
    return { status: response.status, ...(await response.json()) };
  };
  const rpc = async (who, key, action, args = {}) => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-starpost-id': who }, body: JSON.stringify({ action, args }) });
    return { status: response.status, ...(await response.json()) };
  };
  const firstInstall = '11111111-1111-4111-8111-111111111111';
  const secondInstall = '22222222-2222-4222-8222-222222222222';
  const firstToken = 'b'.repeat(64), secondToken = 'c'.repeat(64);
  try {
    assert.equal((await register(firstInstall, firstToken, 'wrong')).status, 403);
    assert.equal((await register(firstInstall, firstToken)).result.botId, '10002');
    assert.equal((await register(firstInstall, firstToken)).result.botId, '10002');
    assert.equal((await register(firstInstall, secondToken)).status, 409);
    assert.equal((await register(secondInstall, secondToken)).result.botId, '10003');
    assert.equal((await rpc('10002', firstToken, 'profile.update', { nickname: '小星', bio: '喜欢星空', discoverable: true })).result.nickname, '小星');
    assert.equal((await rpc('10002', firstToken, 'profile.update', { nickname: '<script>' })).ok, false);
    assert.deepEqual((await rpc('10001', keys[10001], 'directory.search', { query: '小星' })).result.map(p => p.botId), ['10002']);
    assert.deepEqual((await rpc('10001', keys[10001], 'directory.search', { query: '10003' })).result.map(p => p.botId), ['10003']);
    await rpc('10002', firstToken, 'profile.update', { discoverable: false });
    assert.deepEqual((await rpc('10001', keys[10001], 'directory.search', { query: '10002' })).result, []);
    assert.equal((await rpc('10001', keys[10001], 'friend.request', { to: '10002' })).ok, false);
    assert.equal((await rpc('10002', 'wrong', 'snapshot')).status, 401);
    await app.close(); app = createStarpostServer({ file, keys, registrationSecret, port: 0 }); await app.listen();
    base = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await rpc('10002', firstToken, 'snapshot')).result.profile.bio, '喜欢星空');
    assert.equal((await register(firstInstall, firstToken)).result.botId, '10002');
    const third = await register('33333333-3333-4333-8333-333333333333', 'd'.repeat(64));
    assert.equal(third.result.botId, '10004');
    assert.equal(JSON.stringify(app.store.entries('accounts')).includes(firstToken), false);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('广场展示配额、凭展示入群与漂流瓶好友申请', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-square-'));
  const file = join(dir, 'data.json');
  const keys = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [String(10001 + i), String.fromCharCode(97 + i).repeat(32)]));
  let app = createStarpostServer({ file, keys, port: 0 }); await app.listen();
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const rpc = async (who, action, args = {}, limits) => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keys[who]}`, 'x-starpost-id': who }, body: JSON.stringify({ action, args, ...(limits ? { limits } : {}) }) });
    return { status: response.status, ...(await response.json()) };
  };
  try {
    await rpc('10001', 'profile.update', { nickname: '星鱼' });
    const showcase = (await rpc('10001', 'square.showcase', { text: '今晚来聊天' })).result.listingId;
    assert.ok(showcase);
    assert.equal((await rpc('10001', 'square.showcase', { text: '重复展示' })).ok, false);
    assert.equal((await rpc('10002', 'square.list')).result.find(item => item.id === showcase).text, '今晚来聊天');
    assert.ok((await rpc('10002', 'events')).result.some(event => event.type === 'square.bot' && event.data.id === showcase));
    assert.equal((await rpc('10003', 'square.friend', { listingId: showcase })).ok, true);
    assert.equal((await rpc('10001', 'friend.accept', { from: '10003' })).ok, true);
    await rpc('10001', 'profile.update', { discoverable: false });
    assert.equal((await rpc('10002', 'square.list')).result.some(item => item.id === showcase), false);
    assert.equal((await rpc('10004', 'square.friend', { listingId: showcase })).status, 404);
    assert.equal((await rpc('10001', 'square.showcase', { text: '隐藏展示' })).ok, false);
    const hiddenBottle = (await rpc('10001', 'bottle.throw', { text: '瓶中问候' })).result.id;
    assert.equal((await rpc('10004', 'bottle.pick')).result.bottleId, hiddenBottle);
    assert.equal((await rpc('10002', 'bottle.friend', { bottleId: hiddenBottle })).status, 403);
    assert.equal((await rpc('10004', 'bottle.friend', { bottleId: hiddenBottle })).ok, true);
    assert.equal((await rpc('10001', 'friend.accept', { from: '10004' })).ok, true);
    await rpc('10001', 'profile.update', { discoverable: true });
    await rpc('10001', 'friend.request', { to: '10002' }); await rpc('10002', 'friend.accept', { from: '10001' });
    const groupId = (await rpc('10001', 'group.create', { name: '夜航', members: ['10002'] })).result.id;
    assert.equal((await rpc('10002', 'square.promote', { groupId, text: '欢迎加入' })).status, 403);
    const promotion = (await rpc('10001', 'square.promote', { groupId, text: '欢迎加入' })).result.listingId;
    assert.equal((await rpc('10001', 'square.promote', { groupId, text: '重复宣传' })).ok, false);
    assert.equal((await rpc('10005', 'square.join', { listingId: promotion })).result.groupId, groupId);
    assert.ok((await rpc('10005', 'snapshot')).result.groups.some(group => group.id === groupId));
    await rpc('10004', 'snapshot', {}, { private: 10, groups: 0 });
    assert.equal((await rpc('10004', 'square.join', { listingId: promotion })).ok, false);
    const otherBottle = (await rpc('10003', 'bottle.throw', { text: '另一封信' })).result.id;
    assert.equal((await rpc('10004', 'bottle.pick')).result.bottleId, otherBottle);
    assert.equal((await rpc('10003', 'bottle.friend', { bottleId: otherBottle })).ok, true);
    assert.equal((await rpc('10004', 'friend.accept', { from: '10003' })).ok, true);
    await app.close(); app = createStarpostServer({ file, keys, port: 0 }); await app.listen(); base = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await rpc('10001', 'square.promote', { groupId, text: '重启后重复' })).ok, false);
    app.store.transaction(() => {
      const botListing = app.store.get('square', showcase), groupListing = app.store.get('square', promotion);
      botListing.at = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
      groupListing.at = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
      app.store.put('square', showcase, botListing); app.store.put('square', promotion, groupListing);
    });
    assert.equal((await rpc('10004', 'square.join', { listingId: promotion })).status, 404);
    assert.ok((await rpc('10001', 'square.showcase', { text: '新一轮展示' })).result.listingId);
    assert.ok((await rpc('10001', 'square.promote', { groupId, text: '新一天宣传' })).result.listingId);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
