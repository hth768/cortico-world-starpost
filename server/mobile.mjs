import { createHash, randomBytes, randomUUID } from 'node:crypto';
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const short = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value.trim() : fail('文字格式或长度不合法');
export class MobileAccess {
  constructor(store, { login, fingerprint, snapshot, history, rpc, games, image, ownerControl, clock = Date.now }) {
    Object.assign(this, { store, login, fingerprint, snapshot, history, rpc, games, image, ownerControl, clock });
    this.attempts = new Map();
  }
  signIn(input, remote) {
    const now = this.clock();
    if (this.attempts.size > 2048) for (const [key, value] of this.attempts) if (now - value.at > 60000) this.attempts.delete(key);
    const old = this.attempts.get(remote), state = old && now - old.at < 60000 ? old : { at: now, count: 0 };
    if (++state.count > 5) fail('登录尝试过多，请一分钟后重试', 429);
    this.attempts.set(remote, state);
    if (!/^\d{5,12}$/.test(input?.botId ?? '') || typeof input?.credential !== 'string') fail('请填写 ID 和凭据');
    const identity = this.login({ identifier: input.botId, token: input.credential });
    const token = randomBytes(32).toString('hex'), expiresAt = now + 14 * 86400000;
    for (const row of this.store.statement("SELECT key,data FROM documents WHERE collection='mobileSessions'").all()) {
      if (JSON.parse(row.data).expiresAt <= now) this.store.remove('mobileSessions', row.key);
    }
    const sessions = this.store.list('mobileSessions', 'owner=?', [identity.botId], { limit: -1 });
    for (const session of sessions.slice(0, Math.max(0, sessions.length - 4))) this.store.remove('mobileSessions', session.key);
    const key = digest(token);
    this.store.put('mobileSessions', key, { key, owner: identity.botId, expiresAt, credentialHash: this.fingerprint(identity.botId), at: new Date(now).toISOString() });
    return { botId: identity.botId, accessToken: token, expiresAt, address: this.store.get('mobileProfile', identity.botId)?.address ?? '' };
  }
  authenticate(header) {
    const token = header?.replace(/^Bearer /, '');
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail('请重新验证凭据', 401);
    const session = this.store.get('mobileSessions', digest(token));
    if (!session || session.expiresAt <= this.clock() || session.credentialHash !== this.fingerprint(session.owner)) fail('手机登录已过期，请重新验证凭据', 401);
    return session;
  }
  ownerHistory(who, before) {
    const cursor = before == null ? Number.MAX_SAFE_INTEGER : before;
    if (!Number.isSafeInteger(cursor) || cursor < 1) fail('游标无效');
    const rows = this.store.statement("SELECT rowid,data FROM documents WHERE collection='ownerMessages' AND owner=? AND rowid<? ORDER BY rowid DESC LIMIT 9").all(who, cursor);
    const page = rows.slice(0, 8).reverse();
    return { messages: page.map(row => ({ ...JSON.parse(row.data), cursor: row.rowid })), nextBefore: rows.length > 8 ? page[0].rowid : null };
  }
  send(who, direction, args) {
    const text = short(args?.text ?? '', 3000), image = this.image(args?.image);
    if (!text && !image) fail('不能发送空消息');
    const address = this.store.get('mobileProfile', who)?.address;
    if (direction === 'human' && !address) fail('首次发送前请填写桌宠对你的称呼');
    const recent = this.store.count('ownerMessages', 'owner=? AND kind=? AND at>?', [who, direction, new Date(this.clock() - 60000).toISOString()]);
    if (recent >= 12) fail('人机频道每分钟最多发送 12 条', 429);
    const prefix = direction === 'human' ? `以下消息为${address}通过星邮向你发送的消息` : '';
    const message = { id: randomUUID(), botId: who, direction, address: address ?? '', text,
      prefix, image, at: new Date(this.clock()).toISOString() };
    const saved = this.store.put('ownerMessages', message.id, message);
    if (direction === 'human') this.store.emit([who], 'owner.message', saved, message.at);
    return { id: message.id };
  }
  call(session, action, args = {}) {
    const who = session.owner;
    switch (action) {
      case 'teen.status': return this.ownerControl(who,'status',args);
      case 'teen.set': return this.ownerControl(who,'set',args);
      case 'teen.decide': return this.ownerControl(who,'decide',args);
      case 'teen.leave': return this.ownerControl(who,'leave',args);
      case 'teen.removeFriend': return this.ownerControl(who,'removeFriend',args);
      case 'overview': {
        const value = this.snapshot(who, true);
        return { ...value, posts: value.posts.map(post => ({ id: post.id, author: post.author, text: post.text.slice(0, 160), image: Boolean(post.image), at: post.at })) };
      }
      case 'history': {
        const page = this.history(who, args), messages = page.messages.slice(-8);
        return { messages, nextBefore: page.messages.length > 8 ? messages[0].cursor : page.nextBefore };
      }
      case 'post': return this.rpc(who, 'post.read', args);
      case 'square': return this.rpc(who, 'square.list');
      case 'games': {
        const own = this.games.list(who).filter(item => {
          const game = this.games.get(item.gameId);
          return game.participants.includes(who) || game.judgeBotId === who || game.status === 'scheduled' && game.joined.includes(who);
        });
        const entries = [...own, ...this.games.publicListings()];
        return [...new Map(entries.map(item => [item.gameId, item])).values()];
      }
      case 'game': {
        const game = this.games.get(args.gameId);
        const own = game.participants.includes(who) || game.judgeBotId === who || game.status === 'scheduled' && game.joined.includes(who);
        if (!own && !(game.public && game.published)) fail('对局无权查看', 403);
        const before = args.before ?? Number.MAX_SAFE_INTEGER;
        if (!Number.isSafeInteger(before) || before < 1) fail('游标无效');
        const rows = this.store.statement("SELECT rowid,data FROM documents WHERE collection='gameMessages' AND scope=? AND rowid<? ORDER BY rowid DESC LIMIT 51").all(game.id, before);
        const page = rows.slice(0, 50).reverse();
        return { game: { ...this.games.summary(game, who), alive: game.alive, day: game.day }, messages: page.map(row => ({ ...JSON.parse(row.data), cursor: row.rowid })), nextBefore: rows.length > 50 ? page[0].rowid : null };
      }
      case 'owner.history': return this.ownerHistory(who, args.before);
      case 'owner.address': {
        const address = short(args.address, 32);
        if (!/^[\p{L}\p{N}\p{M} _.-]{1,32}$/u.test(address)) fail('称呼须为 1–32 个字母、汉字、数字、空格或 _.-');
        this.store.put('mobileProfile', who, { address }); return { address };
      }
      case 'owner.send': return this.send(who, 'human', args);
      case 'logout': this.store.remove('mobileSessions', session.key); return { loggedOut: true };
      default: fail('手机端只允许读取内容和联系自己的 bot', 403);
    }
  }
}
