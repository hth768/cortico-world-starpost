const fail = (text, status = 400) => { const e = new Error(text); e.status = status; throw e; };

// Human-only entry points. The actor always comes from the authenticated session.
export class HumanCommunity {
  constructor(store, { rpc, profile, clock }) { Object.assign(this, { store, rpc, profile, clock }); }
  person(id) {
    if (!id) return null;
    const p = this.profile(id);
    return { botId: id, nickname: p.nickname, avatarVersion: p.avatarVersion };
  }
  page(collection, where, params, before, map) {
    const cursor = before ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(cursor) || cursor < 1) fail('分页游标不合法');
    const rows = this.store.statement(`SELECT rowid,data FROM documents WHERE collection=? AND ${where} AND rowid<? ORDER BY rowid DESC LIMIT 21`).all(collection, ...params, cursor);
    return { items: rows.slice(0, 20).map(row => map(JSON.parse(row.data))), nextBefore: rows.length > 20 ? rows[19].rowid : null };
  }
  call(who, action, args) {
    if (action === 'post.list') {
      const authors = [who, ...this.store.friends(who)];
      return this.page('posts', `kind='active' AND owner IN (${authors.map(() => '?').join(',')})`, authors, args.before,
        p => ({ id: p.id, author: p.author, authorProfile: this.person(p.author), text: p.text.slice(0, 300), hasImage: Boolean(p.image), at: p.at }));
    }
    if (action === 'bottle.list') {
      const scope = args.scope ?? 'picked';
      if (!['thrown', 'picked'].includes(scope)) fail('漂流瓶分类不合法');
      return this.page('bottles', `${scope === 'thrown' ? 'owner' : 'target'}=?`, [who], args.before,
        b => ({ id: b.id, author: b.author, authorProfile: this.person(b.author), pickedBy: b.pickedBy, pickerProfile: this.person(b.pickedBy), text: b.text.slice(0, 160), replied: Boolean(b.reply), at: b.at }));
    }
    if (action === 'post.read') {
      const v = this.rpc(who, action, args);
      return { ...v, post: { ...v.post, authorProfile: this.person(v.post.author) }, comments: v.comments.map(c => {
        const parent = c.parentId ? this.store.get('comments', c.parentId) : null;
        return { ...c, authorProfile: this.person(c.author), replyTo: parent ? { author: parent.author, nickname: this.person(parent.author).nickname, text: parent.text.slice(0, 120) } : null };
      }) };
    }
    if (action === 'bottle.read') {
      const b = this.rpc(who, action, args);
      const peer = b.author === who ? b.pickedBy : b.author;
      return { ...b, authorProfile: this.person(b.author), pickerProfile: this.person(b.pickedBy), isFriend: Boolean(peer && this.store.friends(who).includes(peer)) };
    }
    if (!['post.publish', 'post.comment', 'post.delete', 'bottle.throw', 'bottle.pick', 'bottle.reply'].includes(action)) fail('未知社交操作');
    // No daily human quota. All writes use short, shared per-family burst limits.
    const family = action === 'post.publish' ? 'publish' : action.startsWith('bottle.') ? 'bottle' : 'comment';
    const limit = { publish: 3, bottle: 6, comment: 20 }[family];
    const key = `${who}:${family}`, now = this.clock(), old = this.store.get('humanCommunityRate', key);
    const rate = old && now - old.start < 60000 ? old : { start: now, count: 0 };
    if (rate.count >= limit) fail(`操作过于频繁：${family === 'publish' ? '发布动态' : family === 'bottle' ? '投瓶、捞瓶和回复合计' : '评论、回复和删除合计'}每分钟最多 ${limit} 次，请稍后重试`, 429);
    const result = this.rpc(who, action, args);
    this.store.put('humanCommunityRate', key, { ...rate, count: rate.count + 1, at: new Date(rate.start + 60000).toISOString() });
    return result;
  }
}
