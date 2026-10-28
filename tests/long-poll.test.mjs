import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarpostServer } from '../server/server.mjs';

test('长轮询有消息即返回，超时空返回，指标仅在本机可读', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'starpost-longpoll-'));
  const key = 'a'.repeat(32);
  const app = createStarpostServer({ file: join(dir, 'data.json'), keys: { 10001: key }, port: 0 });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const poll = (waitMs, since = 0) => fetch(`${base}/rpc`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-starpost-id': '10001', authorization: `Bearer ${key}`,
  }, body: JSON.stringify({ action: 'events', args: { since, waitMs } }) }).then(response => response.json());
  try {
    const waiting = poll(1000);
    await new Promise(resolveWait => setTimeout(resolveWait, 40));
    const during = await (await fetch(`${base}/metrics`)).json();
    assert.equal(during.waitingPolls, 1);
    assert.equal(typeof during.pendingEvents, 'number');
    app.store.transaction(() => app.store.emit(['10001'], 'poke', { from: '10002' }));
    const delivered = await waiting;
    assert.equal(delivered.result[0].type, 'poke');
    assert.equal(delivered.result.length, 1);
    const timed = await poll(80, delivered.result[0].seq);
    assert.deepEqual(timed.result, []);
    const after = await (await fetch(`${base}/metrics`)).json();
    assert.equal(after.waitingPolls, 0);
    assert.ok(after.requests >= 3);
    assert.ok(after.p95Ms !== null);
    const abort = new AbortController();
    const abandoned = fetch(`${base}/rpc`, { method: 'POST', signal: abort.signal, headers: {
      'content-type': 'application/json', 'x-starpost-id': '10001', authorization: `Bearer ${key}`,
    }, body: JSON.stringify({ action: 'events', args: { since: delivered.result[0].seq, waitMs: 1000 } }) });
    await new Promise(resolveWait => setTimeout(resolveWait, 30));
    abort.abort();
    await assert.rejects(abandoned);
    await new Promise(resolveWait => setTimeout(resolveWait, 30));
    assert.equal((await (await fetch(`${base}/metrics`)).json()).waitingPolls, 0);
    const heldAtShutdown = poll(1000, delivered.result[0].seq);
    await new Promise(resolveWait => setTimeout(resolveWait, 30));
    const closing = app.close();
    assert.deepEqual((await heldAtShutdown).result, []);
    await closing;
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
