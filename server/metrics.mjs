import { performance } from 'node:perf_hooks';
import { statfsSync } from 'node:fs';

export class RelayMetrics {
  constructor() {
    this.startedAt = Date.now();
    this.requests = 0;
    this.statuses = {};
    this.actions = {};
    this.recent = [];
    this.mediaBytes = 0;
  }
  now() { return performance.now(); }
  record(action, status, started) {
    this.requests++;
    this.statuses[status] = (this.statuses[status] ?? 0) + 1;
    this.actions[action] = (this.actions[action] ?? 0) + 1;
    this.recent.push({ at: Date.now(), durationMs: performance.now() - started, status });
    if (this.recent.length > 10000) this.recent.splice(0, 1000);
  }
  snapshot(store, waiters = 0) {
    const cutoff = Date.now() - 60000;
    const recent = this.recent.filter(item => item.at >= cutoff);
    const latencies = recent.map(item => item.durationMs).sort((a, b) => a - b);
    const percentile = fraction => latencies.length
      ? Number(latencies[Math.min(latencies.length - 1, Math.floor((latencies.length - 1) * fraction))].toFixed(1)) : null;
    const queue = store.statement('SELECT count(*) AS count,min(at) AS oldest FROM events').get();
    const delivery = store.statement('SELECT coalesce(sum(dropped_count),0) AS dropped FROM event_delivery').get();
    const disk = statfsSync(store.dbFile);
    const total = disk.blocks * disk.bsize, free = disk.bavail * disk.bsize;
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      requests: this.requests,
      requestsLastMinute: recent.length,
      errorsLastMinute: recent.filter(item => item.status >= 500).length,
      p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99),
      statuses: this.statuses, actions: this.actions,
      pendingEvents: queue.count, oldestPendingAt: queue.oldest,
      droppedEvents: delivery.dropped, waitingPolls: waiters,
      mediaBytes: this.mediaBytes,
      diskUsedPercent: Math.round(100 * (1 - free / total)), diskFreeBytes: free,
      lastMaintenance: store.get('meta', 'lastMaintenance') ?? null,
      rssBytes: process.memoryUsage().rss,
    };
  }
}
