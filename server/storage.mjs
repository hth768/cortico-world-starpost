import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

// SQL stores small records and image references. Immutable image bytes live outside SQLite.
export class StarpostStorage {
  constructor({ dbFile, legacyFile, mediaDir }) {
    this.dbFile = resolve(dbFile);
    this.mediaDir = resolve(mediaDir ?? join(dirname(this.dbFile), 'media'));
    mkdirSync(dirname(this.dbFile), { recursive: true, mode: 0o700 });
    mkdirSync(this.mediaDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.dbFile);
    this.statements = new Map();
    try {
      chmodSync(this.dbFile, 0o600);
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA busy_timeout=5000;
        PRAGMA cache_size=-8192;
        CREATE TABLE IF NOT EXISTS documents (
          collection TEXT NOT NULL, key TEXT NOT NULL,
          owner TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL DEFAULT '', scope TEXT NOT NULL DEFAULT '', at TEXT NOT NULL DEFAULT '',
          data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(collection, key)
        );
        CREATE INDEX IF NOT EXISTS documents_owner ON documents(collection, owner, at);
        CREATE INDEX IF NOT EXISTS documents_target ON documents(collection, target, kind);
        CREATE INDEX IF NOT EXISTS documents_scope ON documents(collection, scope, at);
        CREATE INDEX IF NOT EXISTS documents_kind ON documents(collection, kind, at);
        CREATE INDEX IF NOT EXISTS documents_time ON documents(collection, at);
        CREATE INDEX IF NOT EXISTS documents_order ON documents(collection);
        CREATE INDEX IF NOT EXISTS documents_owner_order ON documents(collection, owner);
        CREATE INDEX IF NOT EXISTS documents_target_order ON documents(collection, target);
        CREATE INDEX IF NOT EXISTS documents_scope_order ON documents(collection, scope);
        CREATE INDEX IF NOT EXISTS posts_owner_active ON documents(owner, kind) WHERE collection='posts';
        CREATE INDEX IF NOT EXISTS games_status_deadline ON documents(collection, kind, at) WHERE collection='games';
        CREATE UNIQUE INDEX IF NOT EXISTS accounts_installation ON documents(target) WHERE collection='accounts';
        CREATE TABLE IF NOT EXISTS friendships (bot_id TEXT NOT NULL, friend_id TEXT NOT NULL, PRIMARY KEY(bot_id, friend_id));
        CREATE TABLE IF NOT EXISTS members (group_id TEXT NOT NULL, bot_id TEXT NOT NULL, PRIMARY KEY(group_id, bot_id));
        CREATE INDEX IF NOT EXISTS members_bot ON members(bot_id, group_id);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, type TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
        CREATE INDEX IF NOT EXISTS events_recipient ON events(recipient, seq);
        CREATE INDEX IF NOT EXISTS events_at ON events(at);
        CREATE TABLE IF NOT EXISTS event_delivery (
          recipient TEXT PRIMARY KEY,
          ack_seq INTEGER NOT NULL DEFAULT 0,
          dropped_through INTEGER NOT NULL DEFAULT 0,
          dropped_count INTEGER NOT NULL DEFAULT 0
        );
      `);
      const version = this.get('meta', 'schema');
      if (version !== undefined && version !== 1) throw new Error(`不支持的星邮数据库版本：${version}`);
      if (version === undefined) {
        this.transaction(() => {
          if (legacyFile && existsSync(legacyFile)) this.importLegacy(JSON.parse(readFileSync(legacyFile, 'utf8')));
          this.put('meta', 'schema', 1);
          this.put('meta', 'legacyImport', { file: legacyFile ? resolve(legacyFile) : null, at: new Date().toISOString() });
        });
      }
    } catch (error) { this.db.close(); throw error; }
  }

  statement(sql) {
    if (!this.statements.has(sql)) this.statements.set(sql, this.db.prepare(sql));
    return this.statements.get(sql);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    this.pendingMedia = [];
    this.pendingRecipients = new Set();
    let committing = false;
    try {
      const result = fn(); committing = true; this.db.exec('COMMIT');
      if (this.pendingRecipients.size) {
        try { this.onEmit?.([...this.pendingRecipients]); } catch { /* Long polls still wake at their deadline. */ }
      }
      return result;
    }
    catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* SQLite can already have rolled back after an I/O error. */ }
      // Leave files in place after an ambiguous COMMIT failure; a spare file is safer than a broken reference.
      if (!committing) for (const path of this.pendingMedia) { try { unlinkSync(path); } catch {} }
      throw error;
    } finally { this.pendingMedia = undefined; this.pendingRecipients = undefined; }
  }
  get(collection, key) {
    const row = this.statement('SELECT data FROM documents WHERE collection=? AND key=?').get(collection, String(key));
    return row ? JSON.parse(row.data) : undefined;
  }
  put(collection, key, value) {
    const data = this.externalize(value);
    const indexes = this.indexes(collection, data);
    this.statement(`INSERT INTO documents(collection,key,owner,target,kind,scope,at,data) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(collection,key) DO UPDATE SET owner=excluded.owner,target=excluded.target,kind=excluded.kind,scope=excluded.scope,at=excluded.at,data=excluded.data`)
      .run(collection, String(key), ...indexes, JSON.stringify(data));
    return data;
  }
  indexes(collection, value) {
    const v = value && typeof value === 'object' ? value : {};
    let owner = v.author ?? '', target = v.target ?? '', kind = v.kind ?? '', scope = '';
    let at = v.at ?? v.createdAt ?? '';
    if (collection === 'accounts') target = v.installationId;
    if (collection === 'requests') { owner = v.from; target = v.to; }
    if (collection === 'groups') owner = v.owner;
    if (collection === 'messages') { owner = v.sender; scope = v.kind === 'group' ? `group:${v.target}` : `private:${[v.sender, v.target].sort().join(':')}`; }
    if (collection === 'bottles') target = v.pickedBy ?? '';
    if (collection === 'posts') kind = v.deleted ? 'deleted' : 'active';
    if (collection === 'comments') target = v.postId;
    if (collection === 'registrationCodes') owner = v.batchId;
    if (collection === 'squareReminders') { owner = v.owner; kind = v.notifiedAt ? 'notified' : 'pending'; at = v.availableAt; }
    if (collection === 'games') { owner = v.creator; kind = v.status; at = v.deadlineAt ?? v.scheduledAt; }
    if (collection === 'gameMessages') { owner = v.sender; target = v.to ?? ''; kind = v.channel; scope = v.gameId; }
    if (collection === 'gameAccess' || collection === 'gameParticipation') { owner = v.owner; target = v.gameId ?? ''; }
    if (collection === 'spectatorUsage') owner = v.sender;
    if (collection === 'deferredChat') target = v.recipient;
    if (collection === 'mobileSessions') owner = v.owner;
    if (collection === 'ownerMessages') { owner = v.botId; kind = v.direction; }
    return [owner, target, kind, scope, at];
  }
  remove(collection, key) { this.statement('DELETE FROM documents WHERE collection=? AND key=?').run(collection, String(key)); }
  // where clauses are fixed SQL fragments supplied only by this module and server code.
  list(collection, where = '1', args = [], { limit = 100, reverse = false } = {}) {
    return this.statement(`SELECT data FROM documents WHERE collection=? AND (${where}) ORDER BY rowid ${reverse ? 'DESC' : 'ASC'} LIMIT ?`)
      .all(collection, ...args, limit).map(row => JSON.parse(row.data));
  }
  entries(collection) { return this.statement('SELECT key,data FROM documents WHERE collection=? ORDER BY rowid').all(collection).map(row => [row.key, JSON.parse(row.data)]); }
  count(collection, where = '1', args = []) { return this.statement(`SELECT count(*) AS n FROM documents WHERE collection=? AND (${where})`).get(collection, ...args).n; }
  friends(who) { return this.statement('SELECT friend_id FROM friendships WHERE bot_id=? ORDER BY rowid').all(who).map(row => row.friend_id); }
  befriend(a, b) {
    const add = this.statement('INSERT OR IGNORE INTO friendships(bot_id,friend_id) VALUES(?,?)');
    add.run(a, b); add.run(b, a);
  }
  saveGroup(group) {
    this.put('groups', group.id, group);
    this.statement('DELETE FROM members WHERE group_id=?').run(group.id);
    const add = this.statement('INSERT INTO members(group_id,bot_id) VALUES(?,?)');
    for (const who of group.members) add.run(group.id, who);
  }
  removeGroup(id) { this.remove('groups', id); this.statement('DELETE FROM members WHERE group_id=?').run(id); }
  groups(who) {
    return this.statement(`SELECT d.data FROM members m JOIN documents d ON d.collection='groups' AND d.key=m.group_id WHERE m.bot_id=? ORDER BY d.rowid`)
      .all(who).map(row => JSON.parse(row.data));
  }
  groupCount(who) { return this.statement('SELECT count(*) AS n FROM members WHERE bot_id=?').get(who).n; }
  messages(who) {
    const rows = this.statement("SELECT rowid,data FROM documents WHERE collection='messages' AND owner=? ORDER BY rowid DESC LIMIT 200").all(who);
    rows.push(...this.statement("SELECT rowid,data FROM documents WHERE collection='messages' AND kind='private' AND target=? ORDER BY rowid DESC LIMIT 200").all(who));
    for (const { group_id } of this.statement('SELECT group_id FROM members WHERE bot_id=?').all(who)) {
      rows.push(...this.statement("SELECT rowid,data FROM documents WHERE collection='messages' AND kind='group' AND target=? ORDER BY rowid DESC LIMIT 200").all(group_id));
    }
    return [...new Map(rows.map(row => [row.rowid, row])).values()].sort((a, b) => b.rowid - a.rowid).slice(0, 200).reverse().map(row => JSON.parse(row.data));
  }
  posts(authors) {
    const rows = [];
    for (const author of authors) rows.push(...this.statement("SELECT rowid,data FROM documents WHERE collection='posts' AND owner=? AND kind='active' ORDER BY rowid DESC LIMIT 100").all(author));
    return rows.sort((a, b) => b.rowid - a.rowid).slice(0, 100).reverse().map(row => JSON.parse(row.data));
  }
  bottles(who) {
    const rows = this.statement("SELECT rowid,data FROM documents WHERE collection='bottles' AND owner=? ORDER BY rowid DESC LIMIT 50").all(who);
    rows.push(...this.statement("SELECT rowid,data FROM documents WHERE collection='bottles' AND target=? ORDER BY rowid DESC LIMIT 50").all(who));
    return [...new Map(rows.map(row => [row.rowid, row])).values()].sort((a, b) => b.rowid - a.rowid).slice(0, 50).reverse().map(row => JSON.parse(row.data));
  }
  emit(recipients, type, data, at = new Date().toISOString()) {
    const insert = this.statement('INSERT INTO events(recipient,type,at,data) VALUES(?,?,?,?)');
    const json = JSON.stringify(this.externalize(data));
    for (const who of recipients) insert.run(who, type, at, json);
    if (this.pendingRecipients) for (const who of recipients) this.pendingRecipients.add(who);
    else this.onEmit?.(recipients);
  }
  deliveryState(who) {
    return this.statement('SELECT ack_seq,dropped_through,dropped_count FROM event_delivery WHERE recipient=?').get(who)
      ?? { ack_seq: 0, dropped_through: 0, dropped_count: 0 };
  }
  needsAck(who, since) { return since > this.deliveryState(who).ack_seq; }
  ackEvents(who, since) {
    if (!Number.isSafeInteger(since) || since < 0) throw new Error('事件游标不合法');
    if (!this.needsAck(who, since)) return false;
    this.statement('INSERT INTO event_delivery(recipient,ack_seq) VALUES(?,?) ON CONFLICT(recipient) DO UPDATE SET ack_seq=max(ack_seq,excluded.ack_seq)').run(who, since);
    this.statement('DELETE FROM events WHERE recipient=? AND seq<=?').run(who, since);
    return true;
  }
  markDropped(who, through, count) {
    this.statement(`INSERT INTO event_delivery(recipient,dropped_through,dropped_count) VALUES(?,?,?)
      ON CONFLICT(recipient) DO UPDATE SET dropped_through=max(dropped_through,excluded.dropped_through),
      dropped_count=dropped_count+excluded.dropped_count`).run(who, through, count);
  }
  pruneEvents(now = Date.now(), maxAgeMs = 72 * 60 * 60 * 1000, perRecipientLimit = 50000) {
    const cutoff = new Date(now - maxAgeMs).toISOString();
    return this.transaction(() => {
      let removed = 0;
      for (const row of this.statement('SELECT recipient,max(seq) AS through,count(*) AS n FROM events WHERE at<? GROUP BY recipient').all(cutoff)) {
        this.markDropped(row.recipient, row.through, row.n);
        removed += row.n;
      }
      this.statement('DELETE FROM events WHERE at<?').run(cutoff);
      for (const { recipient } of this.statement('SELECT DISTINCT recipient FROM events').all()) {
        const floor = this.statement('SELECT seq FROM events WHERE recipient=? ORDER BY seq DESC LIMIT 1 OFFSET ?').get(recipient, perRecipientLimit - 1)?.seq;
        if (floor === undefined) continue;
        const drop = this.statement('SELECT max(seq) AS through,count(*) AS n FROM events WHERE recipient=? AND seq<?').get(recipient, floor);
        if (!drop.n) continue;
        this.markDropped(recipient, drop.through, drop.n);
        this.statement('DELETE FROM events WHERE recipient=? AND seq<?').run(recipient, floor);
        removed += drop.n;
      }
      return removed;
    });
  }
  events(who, since) {
    const rows = this.statement('SELECT seq,type,at,data FROM events WHERE recipient=? AND seq>? ORDER BY seq LIMIT 100')
      .all(who, since).map(row => ({ seq: row.seq, to: who, type: row.type, at: row.at, data: JSON.parse(row.data) }));
    const state = this.deliveryState(who);
    if (state.dropped_through > since) {
      rows.push({ seq: state.dropped_through, to: who, type: 'delivery.gap', at: new Date().toISOString(),
        data: { droppedThrough: state.dropped_through, droppedCount: state.dropped_count } });
      rows.sort((a, b) => a.seq - b.seq);
    }
    return rows.slice(0, 100);
  }
  externalize(value) {
    if (!value || typeof value !== 'object') return value;
    if (typeof value.base64 === 'string' && extensions[value.mime]) {
      const bytes = Buffer.from(value.base64, 'base64');
      const mediaId = createHash('sha256').update(bytes).digest('hex');
      const path = this.mediaPath({ mediaId, mime: value.mime });
      if (!existsSync(path)) {
        const temp = join(this.mediaDir, `.${randomUUID()}.tmp`);
        try {
          writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx', flush: true });
          renameSync(temp, path);
          this.pendingMedia?.push(path);
        } finally { if (existsSync(temp)) unlinkSync(temp); }
      }
      return { mime: value.mime, mediaId };
    }
    return Array.isArray(value) ? value.map(item => this.externalize(item)) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.externalize(item)]));
  }
  mediaPath(image) {
    if (!/^[a-f0-9]{64}$/.test(image.mediaId) || !extensions[image.mime]) throw new Error('无效图片引用');
    return join(this.mediaDir, `${image.mediaId}.${extensions[image.mime]}`);
  }
  hydrate(value, cache = new Map(), mediaRefs = false) {
    if (!value || typeof value !== 'object') return value;
    if (value.mediaId !== undefined) {
      if (mediaRefs) { this.mediaPath(value); return { mime: value.mime, mediaId: value.mediaId }; }
      const path = this.mediaPath(value);
      if (!cache.has(path)) cache.set(path, readFileSync(path).toString('base64'));
      return { mime: value.mime, base64: cache.get(path) };
    }
    return Array.isArray(value) ? value.map(item => this.hydrate(item, cache, mediaRefs))
      : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.hydrate(item, cache, mediaRefs)]));
  }
  importLegacy(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('旧数据格式不合法');
    for (const collection of ['accounts', 'profiles', 'limits']) {
      for (const [key, value] of Object.entries(state[collection] ?? {})) this.put(collection, key, value);
    }
    for (const [who, peers] of Object.entries(state.friends ?? {})) for (const peer of peers) this.befriend(who, peer);
    for (const request of state.requests ?? []) this.put('requests', `${request.from}:${request.to}`, request);
    for (const group of Object.values(state.groups ?? {})) this.saveGroup(group);
    for (const collection of ['messages', 'bottles', 'square']) for (const item of state[collection] ?? []) this.put(collection, item.id, item);
    for (const post of state.posts ?? []) {
      const { comments = [], ...data } = post;
      this.put('posts', post.id, data);
      for (const comment of comments) this.put('comments', comment.id, { ...comment, postId: post.id });
    }
    const insert = this.statement('INSERT INTO events(seq,recipient,type,at,data) VALUES(?,?,?,?,?)');
    for (const event of state.events ?? []) insert.run(event.seq, event.to, event.type, event.at, JSON.stringify(this.externalize(event.data)));
    // Preserve cursors even if the old event queue is empty or has been pruned.
    const high = Math.max(state.seq ?? 0, ...[0, ...(state.events ?? []).map(event => event.seq)]);
    if (high > 0) {
      if (!this.statement("SELECT 1 FROM sqlite_sequence WHERE name='events'").get()) this.statement("INSERT INTO sqlite_sequence(name,seq) VALUES('events',?)").run(high);
      else this.statement("UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name='events'").run(high);
    }
    this.put('meta', 'nextBotId', state.nextBotId ?? 10001);
  }
  close() { this.db.close(); }
}
