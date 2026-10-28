import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createStarpostServer } from '../server/server.mjs';
import { StarpostStorage } from '../server/storage.mjs';
import { backupStarpost } from '../server/backup.mjs';

const imageBytes = Buffer.alloc(256 * 1024, 0x5a);
Buffer.from('89504e470d0a1a0a', 'hex').copy(imageBytes);
const image = { mime: 'image/png', base64: imageBytes.toString('base64') };

function client(app, keys) {
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return async (who, action, args = {}, limits) => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${keys[who]}`, 'x-starpost-id': who }, body: JSON.stringify({ action, args, limits }) });
    return { status: response.status, ...await response.json() };
  };
}

test('旧 JSON 完整迁移、图片去重、事件游标和身份跨重启保留，旧文件不再重写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-migrate-')), file = join(dir, 'data.json');
  const token = 'b'.repeat(64), keys = { 10001: 'a'.repeat(32) }, now = new Date().toISOString();
  const old = {
    accounts: { 10002: { installationId: '11111111-1111-4111-8111-111111111111', tokenHash: createHash('sha256').update(token).digest('hex'), createdAt: now } },
    profiles: { 10002: { nickname: '旧昵称', bio: '旧简介', discoverable: false } },
    friends: { 10001: ['10002'], 10002: ['10001'] }, requests: [], limits: { 10002: { private: 10, groups: 5 } },
    groups: { oldgroup: { id: 'oldgroup', owner: '10001', name: '原来的群', members: ['10001', '10002'], createdAt: now } },
    messages: [{ id: 'oldmessage', kind: 'group', target: 'oldgroup', sender: '10001', text: '旧消息', image, at: now }],
    posts: [{ id: 'oldpost', author: '10001', text: '旧动态', image, deleted: false, at: now, comments: [{ id: 'oldcomment', author: '10002', parentId: null, text: '旧评论', at: now }] }],
    bottles: [{ id: 'oldbottle', author: '10001', text: '旧瓶子', pickedBy: '10002', reply: '旧回复', at: now }],
    square: [{ id: 'oldlisting', kind: 'group', author: '10001', target: 'oldgroup', text: '旧宣传', at: now }],
    events: [{ seq: 42, to: '10002', type: 'message', at: now, data: { id: 'oldmessage', image, text: '旧消息' } }], seq: 60, nextBotId: 10003,
  };
  const original = JSON.stringify(old); writeFileSync(file, original);
  let app = createStarpostServer({ file, keys, registrationSecret: 'invite-'.padEnd(40, 'x'), port: 0 });
  try {
    await app.listen(); let rpc = client(app, { ...keys, 10002: token });
    const snapshot = (await rpc('10002', 'snapshot')).result;
    assert.equal(snapshot.profile.nickname, '旧昵称'); assert.equal(snapshot.profile.discoverable, false);
    assert.deepEqual(snapshot.friends, ['10001']); assert.equal(snapshot.groups[0].name, '原来的群');
    assert.deepEqual(snapshot.messages[0].image, image); assert.deepEqual(snapshot.posts[0].image, image);
    assert.equal(snapshot.posts[0].comments[0].text, '旧评论'); assert.equal(snapshot.bottles[0].reply, '旧回复');
    assert.equal(snapshot.square[0].id, 'oldlisting');
    assert.equal((await rpc('10002', 'events', { since: 41 })).result[0].seq, 42);
    assert.equal((await rpc('10001', 'poke', { to: '10002' })).ok, true);
    assert.equal((await rpc('10002', 'events', { since: 60 })).result[0].seq, 61);
    assert.equal((await rpc('10002', 'message.send', { kind: 'private', target: '10001', text: '', image })).ok, true);
    assert.equal(readdirSync(app.store.mediaDir).length, 1);
    assert.deepEqual(readFileSync(join(app.store.mediaDir, readdirSync(app.store.mediaDir)[0])), imageBytes);
    assert.equal(app.store.statement("SELECT count(*) AS n FROM documents WHERE data LIKE '%base64%'").get().n, 0);
    assert.equal(app.store.statement("SELECT count(*) AS n FROM events WHERE data LIKE '%base64%'").get().n, 0);
    assert.equal(readFileSync(file, 'utf8'), original);
    await app.close();
    // A stale old JSON must never overwrite the database on the next boot.
    writeFileSync(file, '{stale-invalid-json');
    app = createStarpostServer({ file, keys, registrationSecret: 'invite-'.padEnd(40, 'x'), port: 0 });
    await app.listen(); rpc = client(app, { ...keys, 10002: token });
    assert.equal((await rpc('10002', 'snapshot')).result.messages.length, 2);
    assert.equal(app.store.statement('PRAGMA integrity_check').get().integrity_check, 'ok');
    const registration = await fetch(`http://127.0.0.1:${app.server.address().port}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'invite-'.padEnd(40, 'x'), installationId: '22222222-2222-4222-8222-222222222222', token: 'c'.repeat(64) }) });
    assert.equal((await registration.json()).result.botId, '10003');
    assert.equal((await fetch(`http://127.0.0.1:${app.server.address().port}/media/${readdirSync(app.store.mediaDir)[0]}`)).status, 404);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('失败操作整体回滚：好友关系、请求、限额和通知不会部分提交', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-rollback-')), keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32) };
  const app = createStarpostServer({ file: join(dir, 'data.json'), keys, port: 0 });
  try {
    await app.listen(); const rpc = client(app, keys);
    await rpc('10001', 'friend.request', { to: '10002' });
    const emit = app.store.emit;
    app.store.emit = () => { throw new Error('injected storage failure'); };
    assert.equal((await rpc('10002', 'friend.accept', { from: '10001' }, { private: 20, groups: 20 })).ok, false);
    app.store.emit = emit;
    assert.deepEqual((await rpc('10002', 'snapshot')).result.friends, []);
    assert.equal(app.store.get('requests', '10001:10002').from, '10001');
    assert.equal(app.store.get('limits', '10002'), undefined);
    assert.equal((await rpc('10002', 'friend.accept', { from: '10001' })).ok, true);
    assert.deepEqual((await rpc('10001', 'snapshot')).result.friends, ['10002']);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('中断的迁移会回滚，修正旧文件后可以安全重试', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-migration-retry-')), legacyFile = join(dir, 'data.json'), dbFile = join(dir, 'data.sqlite');
  const account = { installationId: 'duplicate', tokenHash: 'hash', createdAt: new Date().toISOString() };
  writeFileSync(legacyFile, JSON.stringify({ accounts: { 10001: account, 10002: account } }));
  try {
    assert.throws(() => new StarpostStorage({ dbFile, legacyFile }), /UNIQUE/);
    writeFileSync(legacyFile, JSON.stringify({ accounts: { 10001: account } }));
    const store = new StarpostStorage({ dbFile, legacyFile });
    try { assert.equal(store.count('accounts'), 1); assert.equal(store.get('meta', 'schema'), 1); }
    finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('在线备份包含一致的数据库和图片，可在新目录恢复', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-backup-'));
  const store = new StarpostStorage({ dbFile: join(dir, 'live', 'data.sqlite') });
  let restored;
  try {
    store.transaction(() => {
      store.befriend('10001', '10002');
      store.put('messages', 'm1', { id: 'm1', sender: '10001', target: '10002', kind: 'private', image, at: new Date().toISOString() });
      store.emit(['10002'], 'message', { id: 'm1', image });
    });
    const output = join(dir, 'snapshot');
    await backupStarpost(store.dbFile, store.mediaDir, output);
    assert.equal(JSON.parse(readFileSync(join(output, 'backup.json'), 'utf8')).format, 1);
    await assert.rejects(backupStarpost(store.dbFile, store.mediaDir, output), /已存在/);
    restored = new StarpostStorage({ dbFile: join(output, 'data.sqlite') });
    assert.deepEqual(restored.friends('10001'), ['10002']);
    assert.deepEqual(restored.hydrate(restored.messages('10002'))[0].image, image);
    assert.deepEqual(restored.hydrate(restored.events('10002', 0))[0].data.image, image);
    assert.equal(restored.statement('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(readdirSync(restored.mediaDir).length, 1);
  } finally { restored?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('回滚移除新写入的图片，保留已提交记录引用的图片', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-media-rollback-'));
  const store = new StarpostStorage({ dbFile: join(dir, 'data.sqlite') });
  try {
    assert.throws(() => store.transaction(() => { store.put('posts', 'bad', { id: 'bad', image }); throw new Error('abort'); }), /abort/);
    assert.equal(store.get('posts', 'bad'), undefined); assert.deepEqual(readdirSync(store.mediaDir), []);
    store.transaction(() => store.put('posts', 'good', { id: 'good', image }));
    assert.throws(() => store.transaction(() => { store.put('posts', 'bad2', { id: 'bad2', image }); throw new Error('abort'); }), /abort/);
    assert.deepEqual(store.hydrate(store.get('posts', 'good')).image, image);
    assert.equal(readdirSync(store.mediaDir).length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('历史数据增加后仍按权限和时间读取有界窗口，群聊与私聊不会重复或串号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-history-'));
  const store = new StarpostStorage({ dbFile: join(dir, 'data.sqlite') }), messages = [], posts = [], bottles = [];
  try {
    store.transaction(() => {
      store.saveGroup({ id: 'visible', owner: '10001', members: ['10001', '10002'] });
      store.saveGroup({ id: 'hidden', owner: '10003', members: ['10003', '10004'] });
      for (let i = 0; i < 1200; i++) {
        const kind = i % 3 ? 'private' : 'group';
        const sender = i % 5 ? '10001' : '10002';
        const target = kind === 'group' ? (i % 2 ? 'hidden' : 'visible') : (i % 2 ? '10002' : '10004');
        const message = { id: `m${i}`, sender, target, kind, text: String(i), at: new Date(1700000000000 + i).toISOString() };
        messages.push(message); store.put('messages', message.id, message);
        const post = { id: `p${i}`, author: i % 2 ? '10003' : '10001', deleted: i % 7 === 0, at: message.at };
        posts.push(post); store.put('posts', post.id, post);
        const bottle = { id: `b${i}`, author: sender, pickedBy: i % 2 ? '10002' : '10004', at: message.at };
        bottles.push(bottle); store.put('bottles', bottle.id, bottle);
      }
    });
    const visible = messages.filter(m => m.sender === '10002' || (m.kind === 'private' ? m.target === '10002' : m.target === 'visible')).slice(-200);
    assert.deepEqual(store.messages('10002'), visible);
    assert.deepEqual(store.posts(['10001', '10002']), posts.filter(p => p.author === '10001' && !p.deleted).slice(-100));
    assert.deepEqual(store.bottles('10002'), bottles.filter(b => b.author === '10002' || b.pickedBy === '10002').slice(-50));
    assert.equal(store.count('messages'), 1200);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
