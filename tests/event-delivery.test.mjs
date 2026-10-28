import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StarpostStorage } from '../server/storage.mjs';

test('未确认事件按收件人保留，超额或过期时给出缺口，确认后清理且跨重启保存', () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-delivery-'));
  const dbFile = join(dir, 'data.sqlite');
  const now = Date.parse('2026-10-28T12:00:00Z');
  let store = new StarpostStorage({ dbFile });
  try {
    store.transaction(() => {
      store.emit(['10001'], 'message', { text: '甲的未读' }, new Date(now).toISOString());
      for (let i = 0; i < 6; i++) store.emit(['10002'], 'message', { text: `乙的第${i}条` }, new Date(now).toISOString());
    });
    assert.equal(store.events('10001', 0).length, 1);
    assert.equal(store.events('10002', 0).length, 6);
    assert.equal(store.pruneEvents(now, 72 * 60 * 60 * 1000, 3), 3);
    assert.equal(store.events('10001', 0)[0].data.text, '甲的未读');
    const remaining = store.events('10002', 0);
    assert.deepEqual(remaining.map(event => event.type), ['delivery.gap', 'message', 'message', 'message']);
    assert.equal(remaining[0].seq, 4);
    assert.equal(remaining[0].data.droppedCount, 3);
    store.close(); store = new StarpostStorage({ dbFile });
    assert.equal(store.events('10002', 0)[0].type, 'delivery.gap');
    store.transaction(() => store.ackEvents('10002', 4));
    assert.deepEqual(store.events('10002', 4).map(event => event.type), ['message', 'message', 'message']);
    store.transaction(() => store.ackEvents('10002', 7));
    assert.equal(store.events('10002', 7).length, 0);
    assert.equal(store.events('10001', 0).length, 1);
    store.transaction(() => store.emit(['10001'], 'poke', { from: '10002' }, new Date(now - 4 * 86400000).toISOString()));
    assert.equal(store.pruneEvents(now), 1);
    assert.deepEqual(store.events('10001', 1).map(event => event.type), ['delivery.gap']);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
