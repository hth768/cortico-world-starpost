import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StarpostStorage } from '../server/storage.mjs';
import { createStarpostServer } from '../server/server.mjs';
import { generateInvitations, importInvitations, invitationStatus, revokeInvitations } from '../server/invitations.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const manifestFor = codes => ({ version: 1, batchId: randomUUID(), label: 'test', createdAt: new Date().toISOString(), hashes: codes.map(hash) });
const codes = ['first-test-code-'.padEnd(40, 'a'), 'second-test-code-'.padEnd(40, 'b')];
const installA = '11111111-1111-4111-8111-111111111111', installB = '22222222-2222-4222-8222-222222222222';

test('生成 100 个独立注册码及 CSV，导入文件和数据库不含明文，重复导入不重置使用状态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-codes-'));
  const store = new StarpostStorage({ dbFile: join(dir, 'data.sqlite') });
  try {
    const result = generateInvitations({ count: 100, outputPrefix: join(dir, 'codes') });
    const values = readFileSync(result.files.text, 'utf8').trim().split('\n');
    assert.equal(values.length, 100); assert.equal(new Set(values).size, 100);
    assert.ok(values.every(code => /^SPT-[a-f0-9]{48}$/.test(code)));
    assert.equal(readFileSync(result.files.csv, 'utf8').trim().split('\r\n').length, 101);
    const manifest = JSON.parse(readFileSync(result.files.manifest, 'utf8'));
    assert.deepEqual(manifest.hashes, values.map(hash));
    assert.ok(values.every(code => !JSON.stringify(manifest).includes(code)));
    assert.equal(importInvitations(store, manifest).imported, 100);
    assert.deepEqual(invitationStatus(store, result.batchId), { total: 100, unused: 100, used: 0, revoked: 0 });
    const first = store.get('registrationCodes', hash(values[0]));
    store.transaction(() => store.put('registrationCodes', hash(values[0]), { ...first, usedBy: '10002', usedAt: new Date().toISOString() }));
    assert.equal(importInvitations(store, manifest).imported, 0);
    assert.equal(invitationStatus(store, result.batchId).used, 1);
    assert.equal(store.get('registrationCodes', hash(values[0])).usedBy, '10002');
    const raw = JSON.stringify(store.entries('registrationCodes'));
    assert.ok(values.every(code => !raw.includes(code)));
    assert.throws(() => generateInvitations({ outputPrefix: join(dir, 'codes') }), /已存在/);
    assert.equal(readFileSync(result.files.text, 'utf8').trim().split('\n')[0], values[0]);
    revokeInvitations(store, result.batchId);
    importInvitations(store, manifest);
    assert.equal(invitationStatus(store, result.batchId).revoked, 100);
    assert.equal(invitationStatus(store, result.batchId).unused, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('并发抢同一码只有一个账号成功，同一安装可重试，重启后仍不能复用，原管理员码继续有效', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-code-race-')), file = join(dir, 'data.json');
  const keys = { 10001: 'a'.repeat(32) }, registrationSecret = 'legacy-'.padEnd(40, 'x'), manifest = manifestFor(codes);
  let app = createStarpostServer({ file, keys, registrationSecret, port: 0 });
  let base;
  const register = async (code, installationId, token) => {
    const response = await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, installationId, token }) });
    return { status: response.status, ...await response.json() };
  };
  try {
    importInvitations(app.store, manifest); await app.listen(); base = `http://127.0.0.1:${app.server.address().port}`;
    const attempts = [{ installationId: installA, token: 'b'.repeat(64) }, { installationId: installB, token: 'c'.repeat(64) }];
    const results = await Promise.all(attempts.map(value => register(codes[0], value.installationId, value.token)));
    assert.equal(results.filter(value => value.ok).length, 1); assert.equal(results.filter(value => value.status === 403).length, 1);
    const winner = attempts[results.findIndex(value => value.ok)], loser = attempts[results.findIndex(value => !value.ok)];
    assert.equal((await register(codes[0], winner.installationId, winner.token)).result.botId, '10002');
    assert.equal((await register(codes[0], winner.installationId, 'd'.repeat(64))).status, 409);
    // An already registered account does not consume a second unused code.
    assert.equal((await register(codes[1], winner.installationId, winner.token)).result.botId, '10002');
    assert.equal(invitationStatus(app.store).unused, 1);
    await app.close(); app = createStarpostServer({ file, keys, registrationSecret, port: 0 }); await app.listen(); base = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await register(codes[0], loser.installationId, loser.token)).status, 403);
    assert.equal((await register(codes[0], winner.installationId, winner.token)).result.botId, '10002');
    assert.equal((await register(codes[1], loser.installationId, loser.token)).result.botId, '10003');
    const third = await register(registrationSecret, '33333333-3333-4333-8333-333333333333', 'd'.repeat(64));
    assert.equal(third.result.botId, '10004');
    const value = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-starpost-id': '10002', authorization: 'Bearer ' + winner.token }, body: JSON.stringify({ action: 'snapshot' }) });
    assert.equal((await value.json()).ok, true);
    assert.deepEqual(invitationStatus(app.store), { total: 2, unused: 0, used: 2, revoked: 0 });
    revokeInvitations(app.store, manifest.batchId);
    assert.equal((await register(codes[0], winner.installationId, winner.token)).status, 403);
    const stillAuthenticated = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-starpost-id': '10002', authorization: 'Bearer ' + winner.token }, body: JSON.stringify({ action: 'snapshot' }) });
    assert.equal((await stillAuthenticated.json()).ok, true);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('核销失败时账号、ID 序号和注册码一起回滚', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-code-rollback-'));
  const app = createStarpostServer({ file: join(dir, 'data.json'), keys: { 10001: 'a'.repeat(32) }, port: 0 });
  try {
    importInvitations(app.store, manifestFor(codes)); await app.listen();
    const register = async () => {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: codes[0], installationId: installA, token: 'b'.repeat(64) }) });
      return response.json();
    };
    const put = app.store.put;
    app.store.put = function(collection, key, data) { if (collection === 'registrationCodes' && data.usedBy) throw new Error('storage failure'); return put.call(this, collection, key, data); };
    assert.equal((await register()).ok, false);
    app.store.put = put;
    assert.equal(app.store.count('accounts'), 0); assert.equal(app.store.get('meta', 'nextBotId'), 10002);
    assert.equal(invitationStatus(app.store).unused, 2);
    assert.equal((await register()).result.botId, '10002');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('仅使用独立注册码也可启动；批次冲突不会留下部分导入记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-codes-only-')), dbFile = join(dir, 'data.sqlite');
  const store = new StarpostStorage({ dbFile });
  const first = manifestFor(codes);
  try {
    importInvitations(store, first);
    assert.throws(() => importInvitations(store, { ...manifestFor(['new-code-'.padEnd(40, 'n')]), hashes: [hash('new-code-'.padEnd(40, 'n')), first.hashes[0]] }), /冲突/);
    assert.equal(store.count('registrationCodes'), 2);
    assert.throws(() => importInvitations(store, { ...first, hashes: [first.hashes[0], first.hashes[0]] }), /不合法/);
  } finally { store.close(); }
  const app = createStarpostServer({ dbFile, file: join(dir, 'unused.json'), port: 0 });
  try {
    await app.listen();
    const result = await fetch(`http://127.0.0.1:${app.server.address().port}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: codes[0], installationId: installA, token: 'b'.repeat(64) }) });
    assert.equal((await result.json()).result.botId, '10001');
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
