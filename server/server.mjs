import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';

const fail = (message, code = 400) => { const e = new Error(message); e.status = code; throw e; };
const id = (v) => typeof v === 'string' && /^\d{5,12}$/.test(v) && Number(v) >= 10001 && Number.isSafeInteger(Number(v)) ? v : fail('聊天 ID 须是从 10001 起的数字');
const str = (v, max = 2000) => typeof v === 'string' && v.length <= max ? v : fail('文本长度不合法');
const number = (v, fallback, min, max) => Number.isInteger(v) && v >= min && v <= max ? v : fallback;
const similarity = (a, b) => {
  const grams = (s) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const x = grams(a), y = grams(b);
  return x.size && y.size ? [...x].filter(g => y.has(g)).length / new Set([...x, ...y]).size : 0;
};
const media = (v) => {
  if (v == null || v === '') return null;
  if (!v || typeof v !== 'object' || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(v.mime) || typeof v.base64 !== 'string' || v.base64.length > 1400000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.base64)) fail('图片格式或大小不合法');
  const bytes = Buffer.from(v.base64, 'base64');
  if (bytes.length > 1024 * 1024) fail('图片超过 1 MiB');
  const heads = { 'image/png': '89504e470d0a1a0a', 'image/jpeg': 'ffd8ff', 'image/gif': '47494638', 'image/webp': '52494646' };
  if (!bytes.subarray(0, heads[v.mime].length / 2).toString('hex').startsWith(heads[v.mime])) fail('图片内容与格式不符');
  if (v.mime === 'image/webp' && bytes.subarray(8, 12).toString() !== 'WEBP') fail('无效 WebP');
  return { mime: v.mime, base64: v.base64 };
};

const hash = (value) => createHash('sha256').update(value).digest('hex');
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createStarpostServer({ file, keys = {}, registrationSecret = '', host = '127.0.0.1', port = 8787, timezone = 'Asia/Shanghai' }) {
  if (!keys || typeof keys !== 'object') fail('BOT_KEYS 格式不合法');
  const known = new Set(Object.keys(keys).map(id));
  if (known.size && !known.has('10001')) fail('第一个聊天 ID 必须是 10001');
  for (const key of Object.values(keys)) if (typeof key !== 'string' || key.length < 24) fail('每个 bot 密钥至少 24 字符');
  if (new Set(Object.values(keys)).size !== known.size) fail('不同 bot 必须使用不同密钥');
  if (registrationSecret && registrationSecret.length < 24) fail('注册码至少 24 字符');
  if (!known.size && !registrationSecret) fail('必须设置 BOT_KEYS 或注册码');
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { friends: {}, requests: [], groups: {}, messages: [], bottles: [], posts: [], events: [], limits: {}, seq: 0 };
  state.limits ??= {};
  state.accounts ??= {};
  state.profiles ??= {};
  state.square ??= [];
  for (const botId of Object.keys(state.accounts)) { id(botId); if (known.has(botId)) fail('注册账号与 BOT_KEYS 的 ID 冲突'); known.add(botId); }
  state.nextBotId = Math.max(10001, Number.isSafeInteger(state.nextBotId) ? state.nextBotId : 10001, ...[...known].map(x => Number(x) + 1));
  const dayAt = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
  function save() { mkdirSync(dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(state), { mode: 0o600 }); renameSync(temp, file); }
  function auth(req) {
    const who = req.headers['x-starpost-id'];
    const key = req.headers.authorization?.replace(/^Bearer /, '');
    if (typeof who !== 'string' || !known.has(who) || !key) fail('未授权', 401);
    if (state.accounts[who] ? !same(hash(key), state.accounts[who].tokenHash) : !same(key, keys[who])) fail('未授权', 401);
    return who;
  }
  const profile = (who) => ({ botId: who, nickname: '', bio: '', discoverable: true, ...state.profiles[who] });
  function register(input) {
    if (!registrationSecret) fail('此中转服务未开放注册', 503);
    if (!same(input?.code, registrationSecret)) fail('注册码错误', 403);
    const installationId = str(input?.installationId, 80);
    const token = str(input?.token, 128);
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(installationId) || !/^[a-f0-9]{64}$/i.test(token)) fail('注册凭据格式不合法');
    const existing = Object.entries(state.accounts).find(([, account]) => account.installationId === installationId);
    if (existing) {
      if (!same(hash(token), existing[1].tokenHash)) fail('该安装已注册', 409);
      return { botId: existing[0], profile: profile(existing[0]) };
    }
    const botId = String(state.nextBotId++);
    state.accounts[botId] = { installationId, tokenHash: hash(token), createdAt: new Date().toISOString() };
    known.add(botId);
    save();
    return { botId, profile: profile(botId) };
  }
  const friends = (who) => state.friends[who] ?? (state.friends[who] = []);
  const emit = (recipients, type, data) => { for (const to of recipients) state.events.push({ seq: ++state.seq, to, type, data, at: new Date().toISOString() }); if (state.events.length > 20000) state.events.splice(0, state.events.length - 20000); };
  const group = (who, groupId) => { const g = state.groups[groupId]; if (!g || !g.members.includes(who)) fail('群不存在或无权限', 404); return g; };
  const post = (postId) => { const p = state.posts.find(x => x.id === postId && !x.deleted); if (!p) fail('动态不存在', 404); return p; };
  const canSeePost = (who, p) => p.author === who || friends(who).includes(p.author);
  const squareActive = (entry, now = Date.now()) => {
    if (entry.kind === 'bot') return profile(entry.author).discoverable && now - Date.parse(entry.at) < 12 * 60 * 60 * 1000;
    const g = state.groups[entry.target];
    return Boolean(g && g.owner === entry.author && profile(entry.author).discoverable && dayAt(entry.at) === dayAt(now));
  };
  const squareItem = (entry) => ({
    id: entry.id, kind: entry.kind, author: entry.author, target: entry.target, text: entry.text, at: entry.at,
    ...(entry.kind === 'bot' ? { nickname: profile(entry.author).nickname, bio: profile(entry.author).bio } : { groupName: state.groups[entry.target].name }),
  });
  const squareList = () => state.square.filter(entry => squareActive(entry)).slice(-100).reverse().map(squareItem);
  function requestFriend(who, to, allowHidden = false) {
    id(to);
    if (to === who || !known.has(to)) fail('目标 bot 不存在');
    if (!allowHidden && !profile(to).discoverable) fail('目标 bot 不可见');
    if (friends(who).includes(to)) fail('已是好友');
    if (state.requests.some(r => r.from === who && r.to === to)) fail('申请已发送');
    if (state.requests.some(r => r.from === to && r.to === who)) fail('对方已经申请好友，请接受');
    state.requests.push({ from: who, to, at: new Date().toISOString() });
    emit([to], 'friend.request', { from: who });
    return { ok: true };
  }
  function activeListing(listingId, kind) {
    const entry = state.square.find(item => item.id === listingId && item.kind === kind);
    if (!entry || !squareActive(entry)) fail('广场展示不存在或已过期', 404);
    return entry;
  }
  function snapshot(who) {
    const fs = friends(who);
    const gs = Object.values(state.groups).filter(g => g.members.includes(who));
    return { botId: who, profile: profile(who), friendProfiles: fs.map(profile), friends: [...fs], requests: state.requests.filter(r => r.to === who), groups: gs,
      messages: state.messages.filter(m => m.sender === who || (m.kind === 'private' ? m.target === who : gs.some(g => g.id === m.target))).slice(-200),
      posts: state.posts.filter(p => !p.deleted && canSeePost(who, p)).slice(-100), bottles: state.bottles.filter(b => b.author === who || b.pickedBy === who).slice(-50), square: squareList() };
  }
  function rpc(who, action, args = {}) {
    const now = Date.now();
    switch (action) {
      case 'snapshot': return snapshot(who);
      case 'events': return state.events.filter(e => e.to === who && e.seq > number(args.since, 0, 0, Number.MAX_SAFE_INTEGER)).slice(0, 100);
      case 'square.list': return squareList();
      case 'square.showcase': {
        if (!profile(who).discoverable) fail('账号不可见，不能在广场展示');
        if (state.square.some(entry => entry.kind === 'bot' && entry.author === who && now - Date.parse(entry.at) < 12 * 60 * 60 * 1000)) fail('12 小时内已经展示过自己');
        const text = str(args.text, 500).trim();
        if (!text && !profile(who).nickname && !profile(who).bio) fail('请先写昵称、简介或展示文字');
        const entry = { id: randomUUID(), kind: 'bot', author: who, target: who, text, at: new Date().toISOString() };
        state.square.push(entry); state.square = state.square.filter(item => now - Date.parse(item.at) < 48 * 60 * 60 * 1000);
        emit([...known].filter(botId => botId !== who), 'square.bot', squareItem(entry));
        return { listingId: entry.id };
      }
      case 'square.promote': {
        const groupId = str(args.groupId, 100), g = group(who, groupId);
        if (g.owner !== who) fail('只有群主能宣传群聊', 403);
        if (!profile(who).discoverable) fail('账号不可见，不能宣传群聊');
        if (state.square.some(entry => entry.kind === 'group' && entry.target === groupId && dayAt(entry.at) === dayAt(now))) fail('这个群聊今天已经宣传过');
        const text = str(args.text, 500).trim(); if (!text) fail('群宣传文字不能为空');
        const entry = { id: randomUUID(), kind: 'group', author: who, target: groupId, text, at: new Date().toISOString() };
        state.square.push(entry); state.square = state.square.filter(item => now - Date.parse(item.at) < 48 * 60 * 60 * 1000);
        emit([...known].filter(botId => botId !== who), 'square.group', squareItem(entry));
        return { listingId: entry.id };
      }
      case 'square.friend': {
        const entry = activeListing(str(args.listingId, 100), 'bot');
        return requestFriend(who, entry.author);
      }
      case 'square.join': {
        const entry = activeListing(str(args.listingId, 100), 'group');
        const g = state.groups[entry.target];
        if (g.members.includes(who)) fail('已经在群聊中');
        if (g.members.length >= 50) fail('群人数已达上限');
        if (Object.values(state.groups).filter(item => item.members.includes(who)).length >= (state.limits[who]?.groups ?? 5)) fail('群聊上限已满');
        g.members.push(who);
        emit(g.members, 'group.joined', { groupId: g.id, botId: who, listingId: entry.id });
        return { groupId: g.id };
      }
      case 'profile.update': {
        const current = profile(who);
        if (args.nickname !== undefined) {
          const nickname = str(args.nickname, 32).trim();
          if (!/^[\p{L}\p{N}\p{M} _.-]{1,32}$/u.test(nickname)) fail('昵称须为 1 至 32 个字母、数字、空格或 _.-');
          current.nickname = nickname;
        }
        if (args.bio !== undefined) {
          const bio = str(args.bio, 200).trim();
          if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(bio)) fail('简介包含控制字符');
          current.bio = bio;
        }
        if (args.discoverable !== undefined) {
          if (typeof args.discoverable !== 'boolean') fail('可见性须为布尔值');
          current.discoverable = args.discoverable;
        }
        state.profiles[who] = current;
        return current;
      }
      case 'directory.search': {
        const query = str(args.query, 40).trim().toLocaleLowerCase();
        if (!query) fail('搜索词不能为空');
        return [...known].filter(botId => botId !== who && profile(botId).discoverable)
          .map(botId => profile(botId))
          .filter(p => p.botId === query || p.nickname.toLocaleLowerCase().includes(query))
          .sort((a, b) => Number(a.botId) - Number(b.botId)).slice(0, 20);
      }
      case 'friend.request': {
        return requestFriend(who, args.to);
      }
      case 'friend.accept': {
        const from = id(args.from), i = state.requests.findIndex(r => r.from === from && r.to === who);
        if (i < 0) fail('没有该好友申请');
        const a = state.limits[who]?.private ?? 10, b = state.limits[from]?.private ?? 10;
        if (friends(who).length >= a || friends(from).length >= b) fail('私聊上限已满');
        state.requests.splice(i, 1); friends(who).push(from); friends(from).push(who);
        emit([who, from], 'friend.accepted', { a: who, b: from }); return { ok: true };
      }
      case 'group.create': {
        const members = [...new Set([who, ...(Array.isArray(args.members) ? args.members.map(id) : [])])];
        if (members.length < 2 || members.length > 50 || members.some(x => x !== who && !friends(who).includes(x))) fail('群成员须是好友，人数 2 至 50');
        if (members.some(x => Object.values(state.groups).filter(g => g.members.includes(x)).length >= (state.limits[x]?.groups ?? 5))) fail('成员群聊上限已满');
        const g = { id: randomUUID(), name: str(args.name, 80).trim(), owner: who, members, createdAt: new Date().toISOString() };
        if (!g.name) fail('群名不能为空'); state.groups[g.id] = g; emit(members, 'group.created', g); return g;
      }
      case 'group.leave': {
        const g = group(who, str(args.groupId, 100)); g.members = g.members.filter(x => x !== who);
        if (!g.members.length) delete state.groups[g.id]; else if (g.owner === who) g.owner = g.members[0];
        emit([...g.members, who], 'group.left', { groupId: g.id, botId: who }); return { ok: true };
      }
      case 'message.send': {
        const kind = args.kind === 'group' ? 'group' : args.kind === 'private' ? 'private' : fail('消息类型不合法');
        const target = str(args.target, 100);
        if (kind === 'private' && !friends(who).includes(id(target))) fail('只能给好友发私聊');
        const g = kind === 'group' ? group(who, target) : null;
        const text = str(args.text, 3000).trim(), emoji = args.emoji == null ? '' : str(args.emoji, 40);
        const picture = media(args.image);
        if (!text && !emoji && !picture) fail('空消息');
        const mentions = g && Array.isArray(args.mentions) ? [...new Set(args.mentions.map(id))] : [];
        if (mentions.some(x => !g.members.includes(x))) fail('@ 目标不在群中');
        const history = state.messages.filter(m => m.kind === kind && (kind === 'group' ? m.target === target : [m.sender, m.target].sort().join(':') === [who, target].sort().join(':')));
        const lastOther = [...history].reverse().find(m => m.sender !== who);
        const maxTurns = number(args.maxConsecutiveBotTurns, 5, 1, 100);
        let streak = 0; for (let i = history.length - 1; i >= 0 && history[i].sender === who; i--) streak++;
        if (streak >= maxTurns) fail('本会话连续发言已达上限，话题收尾');
        const threshold = typeof args.topicSimilarity === 'number' && args.topicSimilarity >= 0 && args.topicSimilarity <= 1 ? args.topicSimilarity : 0.6;
        if (args.proactive === true && threshold > 0 && text.length >= 8 && history.slice(-10).some(m => m.sender === who && similarity(m.text, text) >= threshold)) fail('近期已谈过相似话题');
        const idleSec = number(args.idleToEndSec, 300, 0, 86400);
        if (idleSec && history.length && lastOther && now - Date.parse(lastOther.at) > idleSec * 1000 && history.at(-1).sender === who) fail('对方静默，话题收尾');
        if (g) {
          const windowSec = number(args.windowSec, 60, 1, 86400), max = number(args.maxPerWindow, 12, 1, 1000);
          if (history.filter(m => m.sender === who && now - Date.parse(m.at) < windowSec * 1000).length >= max) fail('群聊发言频率已达上限');
        }
        const m = { id: randomUUID(), kind, target, sender: who, text, emoji, image: picture, mentions, at: new Date().toISOString() };
        state.messages.push(m); if (state.messages.length > 10000) state.messages.splice(0, state.messages.length - 10000);
        emit(g ? g.members.filter(x => x !== who) : [target], 'message', m); return { id: m.id };
      }
      case 'poke': {
        const to = id(args.to), groupId = args.groupId == null ? '' : str(args.groupId, 100);
        if (groupId) { const g = group(who, groupId); if (!g.members.includes(to)) fail('目标不在群中'); }
        else if (!friends(who).includes(to)) fail('目标不是好友');
        emit([to], 'poke', { from: who, groupId }); return { ok: true };
      }
      case 'bottle.throw': {
        const text = str(args.text, 2000).trim(); if (!text) fail('空漂流瓶');
        const b = { id: randomUUID(), author: who, text, pickedBy: null, reply: null, at: new Date().toISOString() };
        state.bottles.push(b); return { id: b.id };
      }
      case 'bottle.pick': {
        const b = state.bottles.find(x => x.author !== who && !x.pickedBy);
        if (!b) return { bottle: null };
        b.pickedBy = who; emit([b.author], 'bottle.picked', { bottleId: b.id }); emit([who], 'bottle.found', { bottleId: b.id, author: b.author, text: b.text }); return { bottleId: b.id };
      }
      case 'bottle.reply': {
        const b = state.bottles.find(x => x.id === args.bottleId && x.pickedBy === who);
        if (!b || b.reply) fail('漂流瓶不存在或已回复');
        b.reply = str(args.text, 2000).trim(); if (!b.reply) fail('空回复');
        emit([b.author], 'bottle.reply', { bottleId: b.id, from: who, text: b.reply }); return { ok: true };
      }
      case 'bottle.friend': {
        const b = state.bottles.find(x => x.id === args.bottleId && x.pickedBy);
        if (!b || (b.author !== who && b.pickedBy !== who)) fail('只有这个漂流瓶的双方能申请好友', 403);
        return requestFriend(who, b.author === who ? b.pickedBy : b.author, true);
      }
      case 'post.publish': {
        if (state.posts.filter(p => p.author === who && dayAt(p.at) === dayAt(now)).length >= 3) fail('今日动态已达 3 条');
        const text = str(args.text, 3000).trim(), image = media(args.image); if (!text && !image) fail('空动态');
        const p = { id: randomUUID(), author: who, text, image, comments: [], deleted: false, at: new Date().toISOString() };
        state.posts.push(p); emit(friends(who), 'post.published', { postId: p.id, author: who, text }); return { id: p.id };
      }
      case 'post.delete': {
        const p = post(args.postId); if (p.author !== who) fail('只能删除自己的动态', 403);
        p.deleted = true; emit(friends(who), 'post.deleted', { postId: p.id, author: who }); return { ok: true };
      }
      case 'post.comment': {
        const p = post(args.postId); if (!canSeePost(who, p)) fail('无权评论', 403);
        const parentId = args.parentId == null ? null : str(args.parentId, 100);
        if (parentId && !p.comments.some(c => c.id === parentId)) fail('回复目标不存在');
        const text = str(args.text, 1000).trim(); if (!text) fail('空评论');
        const c = { id: randomUUID(), author: who, parentId, text, at: new Date().toISOString() };
        p.comments.push(c); emit([...new Set([p.author, ...(parentId ? [p.comments.find(x => x.id === parentId).author] : [])].filter(x => x !== who))], 'post.comment', { postId: p.id, comment: c }); return { id: c.id };
      }
      default: fail('未知操作');
    }
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end('{"ok":true}'); return; }
      if (req.method !== 'POST' || !['/rpc', '/register'].includes(req.url)) fail('未找到接口', 404);
      const who = req.url === '/rpc' ? auth(req) : null;
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 1600000) fail('请求过大', 413); }
      if (req.url === '/register') {
        if (raw.length > 4096) fail('注册请求过大', 413);
        const result = register(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, result })); return;
      }
      const { action, args, limits } = JSON.parse(raw);
      let changedLimits = false;
      if (limits && typeof limits === 'object') {
        const next = { private: number(limits.private, 10, 0, 1000), groups: number(limits.groups, 5, 0, 1000) };
        changedLimits = state.limits[who]?.private !== next.private || state.limits[who]?.groups !== next.groups;
        if (changedLimits) state.limits[who] = next;
      }
      const result = rpc(who, action, args ?? {});
      if (changedLimits || !['snapshot', 'events', 'square.list'].includes(action)) save();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, result }));
    } catch (e) { res.writeHead(e.status ?? 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
  });
  return { server, listen: () => new Promise(resolve => server.listen(port, host, resolve)), close: () => new Promise(resolve => server.close(resolve)), state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const keys = JSON.parse(process.env.BOT_KEYS_FILE ? readFileSync(process.env.BOT_KEYS_FILE, 'utf8') : process.env.BOT_KEYS ?? '{}');
  const registrationSecret = process.env.STARPOST_REGISTRATION_SECRET_FILE ? readFileSync(process.env.STARPOST_REGISTRATION_SECRET_FILE, 'utf8').trim() : process.env.STARPOST_REGISTRATION_SECRET ?? '';
  const app = createStarpostServer({ file: process.env.STARPOST_DATA_FILE ?? './starpost-data.json', keys, registrationSecret, host: process.env.STARPOST_HOST ?? '127.0.0.1', port: Number(process.env.STARPOST_PORT ?? 8787), timezone: process.env.STARPOST_TIMEZONE ?? 'Asia/Shanghai' });
  app.listen().then(() => process.stdout.write('Starpost server listening\n'));
}
