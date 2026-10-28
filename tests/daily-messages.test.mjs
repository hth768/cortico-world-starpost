import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';
import { STARPOST_DEFAULTS } from '../src/config.ts';
import { StarpostWorld } from '../src/world.ts';

async function setup(clock = Date.now, timezone = 'Asia/Shanghai') {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-daily-messages-'));
  const file = join(dir, 'relay.json');
  const keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32), 10003: 'c'.repeat(32) };
  let app;
  const start = async () => { app = createStarpostServer({ file, keys, clock, port: 0, timezone }); await app.listen(); };
  await start();
  app.store.befriend('10001', '10002'); app.store.befriend('10001', '10003');
  const base = () => `http://127.0.0.1:${app.server.address().port}`;
  const rpc = async (who, action, args = {}, limits) => {
    const response = await fetch(`${base()}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-starpost-id': who, authorization: `Bearer ${keys[who]}` }, body: JSON.stringify({ action, args, ...(limits ? { limits } : {}) }) });
    return { status: response.status, ...(await response.json()) };
  };
  return { dir, keys, base, rpc, get app() { return app; }, restart: async () => { await app.close(); await start(); },
    close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('默认每日 300 条覆盖升级前历史，私聊和群聊共享额度，重启不重置并按北京时间午夜恢复', async () => {
  let now = Date.parse('2026-10-28T15:59:59.000Z'); const h = await setup(() => now);
  try {
    const groupId = (await h.rpc('10001', 'group.create', { name: '每日额度', members: ['10002'] })).result.id;
    // Historical messages predate the quota feature and must still count on its first use.
    h.app.store.transaction(() => {
      for (let i = 0; i < 299; i++) {
        const message = { id: `legacy-${i}`, sender: '10001', kind: i % 3 === 2 ? 'group' : 'private',
          target: i % 3 === 2 ? groupId : i % 3 === 0 ? '10002' : '10003', text: `历史消息 ${i}`, at: new Date(now - 60000).toISOString() };
        h.app.store.put('messages', message.id, message);
      }
    });
    const initial = (await h.rpc('10001', 'snapshot')).result.messageQuota;
    assert.equal(initial.limit, 300); assert.equal(initial.used, 299); assert.equal(initial.remaining, 1);
    const image = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lX8AAAAASUVORK5CYII=' };
    const last = await h.rpc('10001', 'message.send', { kind: 'group', target: groupId, text: '', image,
      maxConsecutiveBotTurns: 100, maxPerWindow: 1000 });
    assert.equal(last.ok, true); assert.equal(last.result.quota.used, 300); assert.equal(last.result.quota.remaining, 0);
    const blocked = await h.rpc('10001', 'message.send', { kind: 'private', target: '10003', text: '第 301 条', maxMessagesPerDay: 1000000 });
    assert.equal(blocked.status, 429); assert.match(blocked.error, /300 条上限/);
    assert.equal(h.app.store.count('messages', 'owner=?', ['10001']), 300);
    assert.equal((await h.rpc('10002', 'snapshot')).result.messageQuota.used, 0);
    await h.restart();
    assert.equal((await h.rpc('10001', 'snapshot')).result.messageQuota.used, 300);
    assert.equal((await h.rpc('10001', 'message.send', { kind: 'private', target: '10002', text: '重启不能恢复额度' })).status, 429);
    now += 1000;
    const reset = (await h.rpc('10001', 'snapshot')).result.messageQuota;
    assert.equal(reset.day, '2026-10-29'); assert.equal(reset.used, 0); assert.equal(reset.remaining, 300);
    await h.rpc('10002', 'message.send', { kind: 'private', target: '10001', text: '新一天的回复' });
    const next = await h.rpc('10001', 'message.send', { kind: 'private', target: '10002', text: '', emoji: '👋' });
    assert.equal(next.ok, true); assert.equal(next.result.quota.used, 1);
    await h.restart();
    assert.equal((await h.rpc('10001', 'snapshot')).result.messageQuota.used, 1);
  } finally { await h.close(); }
});

test('发送失败不扣额度，最后一个名额并发只成功一次，调整上限不清空计数，旧客户端保留已设限额', async () => {
  const h = await setup();
  const limits = cap => ({ private: 10, groups: 5, maxMessagesPerDay: cap });
  try {
    const groupId = (await h.rpc('10001', 'group.create', { name: '共享名额', members: ['10002'] }, limits(2))).result.id;
    assert.equal((await h.rpc('10001', 'message.send', { kind: 'private', target: '10002', text: '第一条' })).ok, true);
    assert.equal((await h.rpc('10001', 'message.send', { kind: 'private', target: '10002', text: '' })).ok, false);
    const emit = h.app.store.emit.bind(h.app.store); let failNext = true;
    h.app.store.emit = (...args) => { if (args[1] === 'message' && failNext) { failNext = false; throw new Error('模拟事务中断'); } return emit(...args); };
    const failed = await h.rpc('10001', 'message.send', { kind: 'group', target: groupId, text: '失败不计数' });
    assert.equal(failed.ok, false); assert.equal((await h.rpc('10001', 'snapshot')).result.messageQuota.used, 1);
    assert.equal(h.app.store.count('messages'), 1);
    assert.equal((await h.rpc('10001', 'message.send', { kind: 'group', target: groupId, text: '第二条' })).ok, true);
    await h.rpc('10001', 'snapshot', {}, limits(3));
    const results = await Promise.all([1, 2].map(i => h.rpc('10001', 'message.send', { kind: 'private', target: '10002', text: `抢最后名额 ${i}` })));
    assert.equal(results.filter(r => r.ok).length, 1); assert.equal(results.filter(r => r.status === 429).length, 1);
    const legacy = (await h.rpc('10001', 'snapshot', {}, { private: 10, groups: 5 })).result.messageQuota;
    assert.equal(legacy.limit, 3); assert.equal(legacy.used, 3);
    const lower = (await h.rpc('10001', 'snapshot', {}, limits(1))).result.messageQuota;
    assert.equal(lower.used, 3); assert.equal(lower.remaining, 0);
    await h.rpc('10001', 'snapshot', {}, limits(0));
    const paused = await h.rpc('10001', 'message.send', { kind: 'group', target: groupId, text: '暂停时发送' });
    assert.equal(paused.status, 429); assert.match(paused.error, /暂停发送/);
    assert.equal((await h.rpc('10002', 'message.send', { kind: 'private', target: '10001', text: '仍可接收' })).ok, true);
    await h.rpc('10001', 'snapshot', {}, limits(4));
    const raised = await h.rpc('10001', 'message.send', { kind: 'group', target: groupId, text: '提高上限后第四条' });
    assert.equal(raised.ok, true); assert.equal(raised.result.quota.used, 4); assert.equal(raised.result.quota.remaining, 0);
  } finally { await h.close(); }
});

test('本机配置传到中转服务，bot 可查额度并从发送回执获知剩余量', async () => {
  const h = await setup();
  const world = new StarpostWorld({ ...structuredClone(STARPOST_DEFAULTS), enabled: true, botId: '10001',
    serverUrl: h.base(), maxMessagesPerDay: 2 }, h.dir, h.dir, h.dir, 'Asia/Shanghai', () => h.keys[10001]);
  try {
    const send = world.tools().find(tool => tool.name === 'starpost_send');
    for (let i = 0; i < 2; i++) {
      const receipt = JSON.parse(String(await send.handler({ kind: 'private', target: '10002', text: `配置额度 ${i}` }, {})));
      assert.equal(receipt.quota.limit, 2); assert.equal(receipt.quota.remaining, 1 - i);
    }
    const blocked = await send.handler({ kind: 'private', target: '10002', text: '超出额度' }, {});
    assert.equal(blocked.failed, true);
    const read = world.tools().find(tool => tool.name === 'starpost_read');
    const quota = JSON.parse(String(await read.handler({ section: 'quota' }, {})));
    assert.equal(quota.used, 2); assert.equal(quota.remaining, 0); assert.equal(quota.timezone, 'Asia/Shanghai');
    assert.equal((await world.webUi().invoke('viewer', 'overview', [])).messageQuota.limit, 2);
  } finally { await world.stop(); await h.close(); }
});

test('聊天每日额度固定按北京时间恢复，独立于服务端为其他功能配置的时区', async () => {
  let now = Date.parse('2026-11-01T15:59:58.000Z'); const h = await setup(() => now, 'America/New_York');
  try {
    await h.rpc('10001', 'snapshot', {}, { private: 10, groups: 5, maxMessagesPerDay: 1 });
    assert.equal((await h.rpc('10001', 'message.send', { kind: 'private', target: '10002', text: '午夜第一条' })).ok, true);
    now += 1000;
    h.app.store.remove('messageQuota', '10001');
    assert.equal((await h.rpc('10001', 'snapshot')).result.messageQuota.used, 1);
    assert.equal((await h.rpc('10001', 'message.send', { kind: 'private', target: '10002', text: '仍在当天' })).status, 429);
    now += 1000;
    const reset = (await h.rpc('10001', 'snapshot')).result.messageQuota;
    assert.equal(reset.day, '2026-11-02'); assert.equal(reset.remaining, 1); assert.equal(reset.timezone, 'Asia/Shanghai');
  } finally { await h.close(); }
});
