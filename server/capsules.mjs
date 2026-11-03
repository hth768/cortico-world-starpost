import { randomUUID } from 'node:crypto';

const fail = (text, status = 400) => { const error = new Error(text); error.status = status; throw error; };
const MAX_DATE = Date.parse('9999-12-31T23:59:59.999Z');
const offset = 8 * 3600000;
const fixedUnits = { minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000 };

// Calendar months/years retain the Beijing wall-clock time, clamping month ends.
export function capsuleTime(args, now) {
  let at;
  if (args.opensAt !== undefined) {
    if (args.afterValue !== undefined || args.afterUnit !== undefined) fail('指定日期与相对时长只能选择一种');
    const match = typeof args.opensAt === 'string' && /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(args.opensAt);
    if (!match) fail('开启时间须为包含时区的 ISO 日期');
    const [, year, month, day] = match.map(Number);
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (year < 1000 || month < 1 || month > 12 || day < 1 || day > last) fail('开启日期不合法');
    at = Date.parse(args.opensAt);
  } else {
    const n = args.afterValue, unit = args.afterUnit;
    if (!Number.isSafeInteger(n) || n <= 0) fail('请设置正整数时长，或指定未来开启日期');
    if (Object.hasOwn(fixedUnits, unit)) at = now + n * fixedUnits[unit];
    else if (unit === 'months' || unit === 'years') {
      const date = new Date(now + offset), day = date.getUTCDate();
      const months = date.getUTCFullYear() * 12 + date.getUTCMonth() + n * (unit === 'years' ? 12 : 1);
      const year = Math.floor(months / 12), month = months % 12;
      if (year > 9999) fail('开启日期须在 9999 年以内');
      date.setUTCDate(1); date.setUTCFullYear(year, month);
      date.setUTCDate(Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate()));
      at = date.getTime() - offset;
    } else fail('时长单位须为 minutes、hours、days、weeks、months 或 years');
  }
  if (!Number.isFinite(at) || at <= now || at > MAX_DATE) fail('请选择未来的有效开启时间（最远到 9999 年）');
  return new Date(at).toISOString();
}

export class TimeCapsules {
  constructor(store, { clock, media }) { Object.assign(this, { store, clock, media }); }
  meta(c) { return { id: c.id, createdAt: c.createdAt, opensAt: c.opensAt, imageCount: c.images.length, ready: Date.parse(c.opensAt) <= this.clock(), openedAt: c.openedAt ?? null }; }
  owned(who, id) {
    const c = typeof id === 'string' && this.store.get('capsules', id);
    if (!c || c.author !== who) fail('时间胶囊不存在', 404);
    return c;
  }
  status(who) {
    const now = new Date(this.clock()).toISOString();
    const row = this.store.statement(`SELECT count(*) AS total,
      coalesce(sum(at<=?),0) AS ready,
      coalesce(sum(at<=? AND json_extract(data,'$.openedAt') IS NULL),0) AS unread
      FROM documents WHERE collection='capsules' AND owner=?`).get(now, now, who);
    const latest = this.store.statement(`SELECT key FROM documents WHERE collection='capsules' AND owner=? AND at<=? AND json_extract(data,'$.openedAt') IS NULL ORDER BY at DESC,rowid DESC LIMIT 1`).get(who, now);
    return { ...row, sealed: row.total - row.ready, latestId: latest?.key ?? null };
  }
  call(who, action, args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('时间胶囊参数须为对象');
    if (action === 'status') return this.status(who);
    if (action === 'list') {
      const before = args.before;
      if (before != null && (!Number.isSafeInteger(before) || before < 1)) fail('分页游标不合法');
      const rows = this.store.statement(`SELECT rowid AS cursor,data FROM documents WHERE collection='capsules' AND owner=? AND rowid<? ORDER BY rowid DESC LIMIT 21`).all(who, before ?? Number.MAX_SAFE_INTEGER);
      return { ...this.status(who), items: rows.slice(0,20).map(r => this.meta(JSON.parse(r.data))), nextBefore: rows.length > 20 ? rows[19].cursor : null };
    }
    if (action === 'create') {
      const id = args.requestId ?? randomUUID();
      if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) fail('requestId 须为 UUID');
      const old = this.store.get('capsules', id);
      if (old) { if (old.author !== who) fail('请求编号已被使用', 409); return this.meta(old); }
      const text = args.text ?? '';
      if (typeof text !== 'string' || [...text].length > 600) fail('每份时间胶囊文字不能超过 600 字');
      if (args.images !== undefined && !Array.isArray(args.images) || (args.images?.length ?? 0) > 3) fail('每份时间胶囊最多 3 张图片');
      const images = (args.images ?? []).map(v => { const image = this.media(v); if (!image) fail('请提供有效图片'); return image; });
      if (!text.trim() && images.length === 0) fail('请留下文字或添加图片');
      const now = this.clock(), opensAt = capsuleTime(args, now);
      const oldRate = this.store.get('capsuleRate', who), rate = oldRate && now - oldRate.start < 60000 ? oldRate : { start: now, count: 0 };
      if (rate.count >= 3) fail('封存过于频繁，请稍后再试（每分钟最多 3 份）', 429);
      this.store.put('capsuleRate', who, { ...rate, count: rate.count + 1 });
      const capsule = this.store.put('capsules', id, { id, author: who, text, images, createdAt: new Date(now).toISOString(), opensAt, openedAt: null, notifiedAt: null });
      return this.meta(capsule);
    }
    if (action === 'read') {
      const c = this.owned(who, args.capsuleId);
      if (Date.parse(c.opensAt) > this.clock()) fail(`时间胶囊尚未到期，将于 ${c.opensAt} 开启`, 409);
      if (!c.openedAt) { c.openedAt = new Date(this.clock()).toISOString(); c.notifiedAt ??= c.openedAt; this.store.put('capsules', c.id, c); }
      return { ...this.meta(c), text: c.text, images: c.images };
    }
    if (action === 'delete') {
      const c = this.owned(who, args.capsuleId);
      this.store.remove('capsules', c.id);
      return { deleted: true, id: c.id };
    }
    fail('不支持的时间胶囊操作');
  }
  nextDueMs(who, now) {
    const row = this.store.statement("SELECT min(at) AS next FROM documents WHERE collection='capsules' AND owner=? AND kind='pending'").get(who);
    return row?.next ? Math.max(0, Date.parse(row.next) - now) : Infinity;
  }
  deliver(who, now) {
    const at = new Date(now).toISOString();
    const count = this.store.count('capsules', "owner=? AND kind='pending' AND at<=?", [who, at]);
    if (!count) return;
    const ids = this.store.statement("SELECT key FROM documents WHERE collection='capsules' AND owner=? AND kind='pending' AND at<=? ORDER BY at LIMIT 20").all(who,at).map(row => row.key);
    this.store.emit([who], 'capsule.ready', { count, capsuleIds: ids, message: '你给未来自己的时间胶囊已到期。用 starpost_use capsule/list 查看目录，再用 capsule/read 和 capsuleId 选择开启；正文和图片只在读取时提供。' }, at);
    this.store.statement("UPDATE documents SET kind='notified', data=json_set(data,'$.notifiedAt',?) WHERE collection='capsules' AND owner=? AND kind='pending' AND at<=?").run(at, who, at);
  }
}
