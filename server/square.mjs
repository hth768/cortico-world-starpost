const kinds = ['bot', 'group', 'game', 'mystery'];
const fail = message => { const error = new Error(message); error.status = 400; throw error; };
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const identifier = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value) ? value : '';

// Directory pages deliberately omit user-written titles, biographies and bodies.
export function squarePage(entries, args = {}) {
  const kind = args.kind ?? 'all', limit = args.limit ?? 10;
  if (kind !== 'all' && !kinds.includes(kind)) fail('广场类型须为 all、bot、group、game 或 mystery');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) fail('广场每页条数须为 1–20，默认 10');
  let after = null;
  if (args.cursor != null) {
    try {
      if (typeof args.cursor !== 'string' || args.cursor.length > 400 || !/^[\w-]+$/.test(args.cursor)) throw new Error();
      after = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(after) || after.length !== 3 || after[0] !== kind || iso(after[1]) !== after[1] || !identifier(after[2])) throw new Error();
    } catch { fail('广场翻页游标无效；切换类型时请从第一页开始'); }
  }
  const items = entries.flatMap(entry => {
    const id = identifier(entry?.id ?? entry?.gameId), at = iso(entry?.at ?? entry?.createdAt);
    if (!id || !at || !kinds.includes(entry.kind)) return [];
    const item = { id, kind: entry.kind, author: identifier(entry.author ?? entry.creator), target: identifier(entry.target ?? entry.gameId), at };
    if (entry.kind === 'game' || entry.kind === 'mystery') {
      item.gameId = identifier(entry.gameId ?? id);
      if (typeof entry.status === 'string' && /^[a-z_]{1,30}$/.test(entry.status)) item.status = entry.status;
      if (['scheduled', 'full'].includes(entry.startMode)) item.startMode = entry.startMode;
      item.scheduledAt = iso(entry.scheduledAt);
      for (const key of ['joined', 'maxPlayers']) if (Number.isInteger(entry[key]) && entry[key] >= 0 && entry[key] <= 100) item[key] = entry[key];
    }
    return [item];
  }).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  const counts = Object.fromEntries(kinds.map(type => [type, items.filter(item => item.kind === type).length]));
  const matching = kind === 'all' ? items : items.filter(item => item.kind === kind);
  const remaining = after ? matching.filter(item => item.at < after[1] || item.at === after[1] && item.id.localeCompare(after[2]) < 0) : matching;
  const page = remaining.slice(0, limit), last = page.at(-1);
  return { items: page, total: matching.length, counts, nextCursor: remaining.length > limit && last ? Buffer.from(JSON.stringify([kind, last.at, last.id])).toString('base64url') : null };
}
