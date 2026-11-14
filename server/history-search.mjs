const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const PAGE_SIZE = 20, SCAN_SIZE = 2000, CONTEXT_SIZE = 8;

// Dates in the UI are Beijing calendar days, inclusive at both ends.
function day(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('日期格式须为 YYYY-MM-DD');
  const ms = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(ms) || new Date(ms + 8 * 3600000).toISOString().slice(0, 10) !== value) fail('日期无效');
  return ms;
}

export class HistorySearch {
  constructor(store, actions, view) { Object.assign(this, { store, actions, view }); }
  scope(actor, args) {
    // The exact same checks as reading/quoting an original message. Never trust a cursor as permission.
    const c = this.actions.context(actor, args.kind, args.target);
    return c.kind === 'owner'
      ? { where: "collection='ownerMessages' AND owner=?", params: [c.target] }
      : { where: "collection='messages' AND scope=?", params: [c.kind === 'group' ? `group:${c.target}` : `private:${[actor,c.target].sort().join(':')}`] };
  }
  message(row) { return { ...this.view(JSON.parse(row.data)), cursor: row.rowid }; }
  search(actor, args) {
    const { where, params } = this.scope(actor, args);
    if (args.query != null && typeof args.query !== 'string') fail('搜索关键词须为文字');
    const query = (args.query ?? '').trim();
    if (query.length > 100) fail('搜索关键词最多 100 字');
    const start = day(args.startDate), end = day(args.endDate);
    if (!query && start === null && end === null) fail('请填写关键词或选择日期');
    if (start !== null && end !== null && start > end) fail('开始日期不能晚于结束日期');
    const before = args.before ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(before) || before < 1) fail('消息游标不合法');
    const dates = `${start === null ? '' : ' AND at>=?'}${end === null ? '' : ' AND at<?'}`;
    const dateParams = [...(start === null ? [] : [new Date(start).toISOString()]), ...(end === null ? [] : [new Date(end + 86400000).toISOString()])];
    // Scan a bounded indexed conversation window. A rare/no-match query cannot block the relay
    // with a full-database scan. nextBefore advances even when this window has no matches.
    const rows = this.store.statement(`SELECT rowid,
      (json_extract(data,'$.recalled') IS NOT 1 AND
       instr(lower(coalesce(json_extract(data,'$.text'), '') || coalesce(json_extract(data,'$.emoji'), '')),lower(?))>0) AS matched
      FROM documents WHERE ${where} AND rowid<?${dates} ORDER BY rowid DESC LIMIT ?`)
      .all(query, ...params, before, ...dateParams, SCAN_SIZE);
    const matches = rows.filter(row => row.matched), page = matches.slice(0, PAGE_SIZE);
    const nextBefore = matches.length > PAGE_SIZE ? page.at(-1).rowid : rows.length === SCAN_SIZE ? rows.at(-1).rowid : null;
    return { messages: page.map(row => {
      const {image,quote,...message}=this.message(this.store.statement(`SELECT rowid,data FROM documents WHERE ${where} AND rowid=?`).get(...params, row.rowid));
      return {...message,hasImage:Boolean(image)};
    }), nextBefore };
  }
  context(actor, args) {
    const { where, params } = this.scope(actor, args);
    const { m } = this.actions.get(actor, args);
    const anchor = this.store.statement(`SELECT rowid,data FROM documents WHERE ${where} AND key=?`).get(...params, m.id);
    const older = this.store.statement(`SELECT rowid,data FROM documents WHERE ${where} AND rowid<? ORDER BY rowid DESC LIMIT ?`).all(...params, anchor.rowid, CONTEXT_SIZE + 1);
    const newer = this.store.statement(`SELECT rowid,data FROM documents WHERE ${where} AND rowid>? ORDER BY rowid ASC LIMIT ?`).all(...params, anchor.rowid, CONTEXT_SIZE + 1);
    return { messages: [...older.slice(0, CONTEXT_SIZE).reverse(), anchor, ...newer.slice(0, CONTEXT_SIZE)].map(row => this.message(row)),
      anchorId: m.id, hasOlder: older.length > CONTEXT_SIZE, hasNewer: newer.length > CONTEXT_SIZE };
  }
}
