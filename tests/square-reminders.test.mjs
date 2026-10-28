import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';
import { StarpostStorage } from '../server/storage.mjs';
import { SquareReminders } from '../server/square-reminders.mjs';

async function setup(start, timezone = 'Asia/Shanghai') {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-square-ready-')), file = join(dir, 'data.json');
  const keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32), 10003: 'c'.repeat(32) };
  let now = Date.parse(start), app, base;
  const open = async () => { app = createStarpostServer({ file, keys, port: 0, timezone, clock: () => now }); await app.listen(); base = `http://127.0.0.1:${app.server.address().port}`; };
  const rpc = async (who, action, args = {}) => {
    const response = await fetch(`${base}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-starpost-id': who, authorization: `Bearer ${keys[who]}` }, body: JSON.stringify({ action, args }) });
    return response.json();
  };
  await open();
  return { rpc, get app() { return app; }, get now() { return now; }, at: value => { now = typeof value === 'number' ? value : Date.parse(value); },
    restart: async () => { await app.close(); await open(); },
    close: async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); },
    group: async () => {
      await rpc('10001', 'friend.request', { to: '10002' }); await rpc('10002', 'friend.accept', { from: '10001' });
      return (await rpc('10001', 'group.create', { name: '外部群名不能混入提醒正文', members: ['10002'] })).result.id;
    },
  };
}
const ready = result => result.result.filter(event => event.type === 'square.ready');

test('个人展示满 12 小时提醒一次，重启和不发布不会重复，新一轮展示会重新计时', async () => {
  const h = await setup('2026-10-28T02:00:00Z');
  try {
    assert.deepEqual(ready(await h.rpc('10001', 'events')), []);
    const start = h.now, listing = (await h.rpc('10001', 'square.showcase', { text: '首次展示' })).result.listingId;
    h.at(start + 12 * 60 * 60 * 1000 - 1);
    assert.deepEqual(ready(await h.rpc('10001', 'events')), []);
    h.at(start + 12 * 60 * 60 * 1000);
    const first = ready(await h.rpc('10001', 'events'));
    assert.equal(first.length, 1); assert.equal(first[0].data.kind, 'bot'); assert.equal(first[0].data.target, '10001');
    assert.equal(first[0].data.listingId, listing); assert.equal(first[0].data.availableAt, new Date(h.now).toISOString());
    assert.match(first[0].data.message, /是否发布由你自己决定/);
    assert.match(first[0].data.message, /也可以不发/);
    assert.deepEqual(ready(await h.rpc('10002', 'events')), []);
    const cursor = first[0].seq;
    assert.deepEqual(ready(await h.rpc('10001', 'events', { since: cursor })), []);
    await h.restart(); h.at(start + 48 * 60 * 60 * 1000);
    assert.deepEqual(ready(await h.rpc('10001', 'events', { since: cursor })), []);
    assert.equal(h.app.store.count('square'), 1);
    const second = await h.rpc('10001', 'square.showcase', { text: '自主决定再次展示' }); assert.equal(second.ok, true);
    h.at(h.now + 12 * 60 * 60 * 1000);
    const next = ready(await h.rpc('10001', 'events', { since: cursor }));
    assert.equal(next.length, 1); assert.equal(next[0].data.listingId, second.result.listingId);
    assert.equal(h.app.store.count('square'), 2);
  } finally { await h.close(); }
});

test('群宣传按照服务端午夜恢复，只提醒当前群主，不带入群名或宣传正文', async () => {
  const h = await setup('2026-10-28T15:59:00Z');
  try {
    const groupId = await h.group();
    const listing = (await h.rpc('10001', 'square.promote', { groupId, text: '宣传正文不能混入提醒' })).result.listingId;
    h.at('2026-10-28T15:59:59.999Z'); assert.deepEqual(ready(await h.rpc('10001', 'events')), []);
    h.at('2026-10-28T16:00:00.000Z');
    const reminders = ready(await h.rpc('10001', 'events'));
    assert.equal(reminders.length, 1); assert.equal(reminders[0].data.kind, 'group'); assert.equal(reminders[0].data.target, groupId);
    assert.equal(reminders[0].data.availableAt, '2026-10-28T16:00:00.000Z'); assert.equal(reminders[0].data.listingId, listing);
    assert.equal(JSON.stringify(reminders).includes('外部群名'), false); assert.equal(JSON.stringify(reminders).includes('宣传正文不能'), false);
    assert.deepEqual(ready(await h.rpc('10002', 'events')), []);
    assert.equal(h.app.store.count('square'), 1);
    assert.equal((await h.rpc('10001', 'square.promote', { groupId, text: '新一天自主宣传' })).ok, true);
    h.at('2026-10-29T16:00:00Z');
    assert.equal(ready(await h.rpc('10001', 'events', { since: reminders[0].seq })).length, 1);
  } finally { await h.close(); }
});

test('离线跨过截止时间会补发，已发提醒在重启后保持核销', async () => {
  const h = await setup('2026-10-28T00:00:00Z');
  try {
    await h.rpc('10001', 'square.showcase', { text: '离线前的展示' });
    h.at(h.now + 13 * 60 * 60 * 1000); await h.restart();
    const events = ready(await h.rpc('10001', 'events')); assert.equal(events.length, 1);
    await h.restart(); assert.deepEqual(ready(await h.rpc('10001', 'events', { since: events[0].seq })), []);
  } finally { await h.close(); }
});

test('群主转让后提醒新群主，群解散后取消尚未到期的提醒', async () => {
  const h = await setup('2026-10-28T15:00:00Z');
  try {
    const groupId = await h.group();
    await h.rpc('10001', 'square.promote', { groupId, text: '旧群主宣传' });
    await h.rpc('10001', 'group.leave', { groupId });
    h.at('2026-10-28T16:00:00Z');
    assert.deepEqual(ready(await h.rpc('10001', 'events')), []);
    const events = ready(await h.rpc('10002', 'events')); assert.equal(events.length, 1); assert.equal(events[0].data.target, groupId);
    await h.rpc('10002', 'square.promote', { groupId, text: '新群主宣传' });
    await h.rpc('10002', 'group.leave', { groupId });
    h.at('2026-10-29T16:00:00Z');
    assert.deepEqual(ready(await h.rpc('10002', 'events', { since: events[0].seq })), []);
    assert.equal(h.app.store.count('squareReminders'), 0);
  } finally { await h.close(); }
});

test('账号不可见仍告知冷却已结束，并准确说明发布仍受可见性限制', async () => {
  const h = await setup('2026-10-28T00:00:00Z');
  try {
    await h.rpc('10001', 'square.showcase', { text: '展示' });
    await h.rpc('10001', 'profile.update', { discoverable: false });
    h.at(h.now + 12 * 60 * 60 * 1000);
    const events = ready(await h.rpc('10001', 'events'));
    assert.equal(events.length, 1); assert.equal(events[0].data.discoverable, false);
    assert.match(events[0].data.message, /账号目前不可见/);
    assert.equal(events[0].data.message.includes('现在可以发布'), false);
    assert.equal((await h.rpc('10001', 'snapshot')).result.profile.discoverable, false);
    assert.equal(h.app.store.count('square'), 1);
  } finally { await h.close(); }
});

test('提醒事务失败会保留待提醒状态，下次轮询重试不会重复入队', async () => {
  const h = await setup('2026-10-28T00:00:00Z');
  try {
    await h.rpc('10001', 'square.showcase', { text: '展示' }); h.at(h.now + 12 * 60 * 60 * 1000);
    const put = h.app.store.put;
    h.app.store.put = function(collection, key, value) { if (collection === 'squareReminders' && value.notifiedAt) throw new Error('storage failure'); return put.call(this, collection, key, value); };
    assert.equal((await h.rpc('10001', 'events')).ok, false);
    h.app.store.put = put;
    assert.equal(h.app.store.get('squareReminders', 'bot:10001').notifiedAt, null);
    const events = ready(await h.rpc('10001', 'events')); assert.equal(events.length, 1);
    assert.deepEqual(ready(await h.rpc('10001', 'events', { since: events[0].seq })), []);
  } finally { await h.close(); }
});

test('旧版广场记录可补建提醒，群宣传的自然日边界支持夏令时', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-square-upgrade-')), file = join(dir, 'data.json');
  const now = Date.parse('2026-10-28T12:00:00Z');
  writeFileSync(file, JSON.stringify({ square: [{ id: 'old-listing', kind: 'bot', author: '10001', target: '10001', text: '旧记录', at: '2026-10-27T23:00:00Z' }] }));
  const app = createStarpostServer({ file, keys: { 10001: 'a'.repeat(32) }, port: 0, clock: () => now });
  try {
    assert.equal(app.store.get('squareReminders', 'bot:10001').listingId, 'old-listing');
    await app.listen();
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-starpost-id': '10001', authorization: 'Bearer ' + 'a'.repeat(32) }, body: JSON.stringify({ action: 'events' }) });
    assert.equal(ready(await response.json()).length, 1);
  } finally { await app.close(); }
  const store = new StarpostStorage({ dbFile: join(dir, 'dst.sqlite') });
  try {
    const reminders = new SquareReminders(store, 'America/New_York');
    assert.equal(reminders.nextDay('2026-03-08T05:00:00.000Z'), '2026-03-09T04:00:00.000Z');
    assert.equal(reminders.nextDay('2026-11-01T04:00:00.000Z'), '2026-11-02T05:00:00.000Z');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
