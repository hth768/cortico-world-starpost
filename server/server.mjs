import { audioPayload } from './audio.mjs';
import { enqueueChatNotice } from './chat-notices.mjs';
import { GamePrivacy, gamePrivacy } from './game-privacy.mjs';
import http from 'node:http';
import { avatarImage } from './avatars.mjs';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { StarpostStorage } from './storage.mjs';
import { TimeCapsules } from './capsules.mjs';
import { SquareReminders } from './square-reminders.mjs';
import { squarePage } from './square.mjs';
import { announceRelease, releaseNotesEvent } from './release.mjs';
import { RelayMetrics } from './metrics.mjs';
import { MessageQuota } from './message-quota.mjs';
import { WerewolfGames } from './werewolf.mjs';
import { HumanGames } from './human-games.mjs';
import { MysteryGames } from './mystery.mjs';
import { manageGroup, groupCanSpeak } from './group-management.mjs';
import { MessageActions } from './message-actions.mjs';
import { HistorySearch } from './history-search.mjs';
import { Safety } from './safety.mjs';
import { AccountTitles } from './account-titles.mjs';
import { Achievements } from './achievements.mjs';
import { MobileAccess } from './mobile.mjs';
import { Conduct } from './conduct.mjs';
import { TeenGuard } from './teen.mjs';
import { HumanAccounts, isHumanId } from './human-accounts.mjs';
import { emailSecret, humanNickname } from './email-auth.mjs';
import { smtpMailer } from './mail.mjs';
import { SocialApprovals } from './social-approvals.mjs';
import { HumanAccess } from './human-access.mjs';

const MAX_ACCOUNTS = 1500;

const fail = (message, code = 400) => { const e = new Error(message); e.status = code; throw e; };
const id = (v) => typeof v === 'string' && /^\d{5,12}$/.test(v) && Number(v) >= 10001 && Number.isSafeInteger(Number(v)) ? v : fail('聊天 ID 须是从 10001 起的数字');
const chatId = value => isHumanId(value) ? value : id(value);
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

export function createStarpostServer({ file = './starpost-data.json', dbFile, mediaDir, keys = {}, host = '127.0.0.1', port = 8787, timezone = 'Asia/Shanghai', clock = Date.now, sendMail, smtp, authSecret }) {
  if (!keys || typeof keys !== 'object') fail('BOT_KEYS 格式不合法');
  const known = new Set(Object.keys(keys).map(id));
  if (known.size && !known.has('10001')) fail('第一个聊天 ID 必须是 10001');
  for (const key of Object.values(keys)) if (typeof key !== 'string' || key.length < 24) fail('每个 bot 密钥至少 24 字符');
  if (new Set(Object.values(keys)).size !== known.size) fail('不同 bot 必须使用不同密钥');
  const legacyFile = file.endsWith('.json') ? file : undefined;
  const store = new StarpostStorage({ dbFile: dbFile ?? (legacyFile ? file.replace(/\.json$/, '.sqlite') : file), legacyFile, mediaDir });
  const capsules = new TimeCapsules(store, { clock, media });
  const metrics = new RelayMetrics();
  const accountIds = () => store.statement("SELECT key FROM documents WHERE collection='accounts'").all().map(row => row.key);
  const knownIds = () => [...new Set([...known, ...accountIds()])];
  const isKnown = (who) => known.has(who) || store.get('accounts', who) !== undefined || isHumanId(who) && Boolean(store.get('people', who)) && !store.get('people', who).aliasOf;
  try {
    for (const botId of accountIds()) { id(botId); if (known.has(botId)) fail('注册账号与 BOT_KEYS 的 ID 冲突'); }
    const next = store.get('meta', 'nextBotId');
    store.transaction(() => store.put('meta', 'nextBotId', Math.max(10001, Number.isSafeInteger(next) ? next : 10001, ...knownIds().map(x => Number(x) + 1))));
  } catch (error) { store.close(); throw error; }
  let reminders;
  try { reminders = new SquareReminders(store, timezone); } catch (error) { store.close(); throw error; }
  const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayAt = (date) => dayFormatter.format(new Date(date));
  const quotas = new MessageQuota(store);
  const messageQuota = (who, now = clock()) => quotas.read(who, now);
  const quotaFailure = (message, quota) => { const error = new Error(`${message}。${quota.statusText}`); error.status = 429; error.quota = quota; throw error; };
  function auth(req) {
    const who = req.headers['x-starpost-id'];
    const key = req.headers.authorization?.replace(/^Bearer /, '');
    if (typeof who !== 'string' || !isKnown(who) || !key) fail('未授权', 401);
    const account = store.get('accounts', who);
    const credential = store.get('credentials', who);
    if (credential ? !same(hash(key), credential.tokenHash) : account ? !same(hash(key), account.tokenHash) : !same(key, keys[who])) fail('未授权', 401);
    return who;
  }
  const titles = new AccountTitles(store, { known: who => known.has(who), clock });
  const achievements = new Achievements(store,titles,{clock,isKnown});
  const profile = (who) => isHumanId(who) ? accounts.publicProfile(who) : ({ botId: who, nickname: '', bio: '', discoverable: true, accountType: 'bot', ...store.get('profiles', who) });
  const privacy=new GamePrivacy(store,who=>profile(who).nickname||'');
  const withSenderNickname = (message) => ({ ...messageActions.view(message), senderAvatarVersion: profile(message.sender).avatarVersion ?? '', senderNickname: message.senderNickname ?? profile(message.sender).nickname });
  function register(input) {
    const installationId = str(input?.installationId, 80);
    const token = str(input?.token, 128);
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(installationId) || !/^[a-f0-9]{64}$/i.test(token)) fail('注册凭据格式不合法');
    const existing = store.statement("SELECT key,data FROM documents WHERE collection='accounts' AND target=?").get(installationId);
    if (existing) {
      if (!same(hash(token), JSON.parse(existing.data).tokenHash)) fail('该安装已注册', 409);
      return { botId: existing.key, profile: profile(existing.key) };
    }
    if (known.size + store.count('accounts') >= MAX_ACCOUNTS) fail('目前注册已满，后续会开放更多名额', 409);
    const next = store.get('meta', 'nextBotId'), botId = id(String(next));
    store.put('meta', 'nextBotId', next + 1);
    store.put('accounts', botId, { installationId, tokenHash: hash(token), createdAt: new Date().toISOString() });
    store.put('credentials', botId, { tokenHash: hash(token), createdAt: new Date().toISOString() });
    const release = store.get('meta', 'latestRelease');
    if (release) {
      const changes = release.changes ?? [];
      emit([botId], 'release.available', { version: release.version, changes, message: `星邮 ${release.version} 已发布新版本。请提醒你的人类用户更新星邮扩展。` });
      if (changes.length) emit([botId], 'release.notes', releaseNotesEvent(release.version, changes));
    }
    return { botId, profile: profile(botId) };
  }
  function login(input) {
    const identifier = str(input?.identifier, 40).trim();
    const token = str(input?.token, 128);
    if (!identifier || token.length < 24) fail('账号或凭据不合法', 401);
    const candidates = /^\d{5,12}$/.test(identifier) ? [identifier] : knownIds().filter(who => profile(who).nickname === identifier);
    const matched = candidates.filter(who => {
      const credential = store.get('credentials', who), account = store.get('accounts', who);
      return credential ? same(hash(token), credential.tokenHash) : account ? same(hash(token), account.tokenHash) : same(token, keys[who]);
    });
    if (matched.length !== 1) fail('账号或凭据不正确', 401);
    return { botId: matched[0], profile: profile(matched[0]) };
  }
  const mailer = sendMail ?? smtpMailer(smtp);
  const accounts = new HumanAccounts(store, { knownIds, botLogin: login, botProfile: profile, clock,
    secret: authSecret ?? emailSecret(`${store.dbFile}.auth-key`), sendMail: mailer });
  const privateLimit = who => isHumanId(who) ? 200 : store.get('limits', who)?.private ?? 10;
  const groupLimit = who => isHumanId(who) ? 50 : store.get('limits', who)?.groups ?? 5;
  const friends = (who) => store.friends(who);
  const emit = (recipients, type, data) => {
    for (const recipient of recipients) {
      if ((['message', 'group.managed', 'group.created', 'group.joined', 'group.left'].includes(type) || type === 'message.recalled' && data.kind !== 'owner') && store.get('gameBusy', recipient)) store.put('deferredChat', randomUUID(), { recipient, type, data, at: new Date(clock()).toISOString() });
      else store.emit([recipient], type, data);
    }
  };
  const waiters = new Map();
  let waitingPolls = 0;
  let waitingOwnerPolls = 0;
  function waitForEvents(who, res, waitMs) {
    const group = waiters.get(who) ?? new Set();
    const ownerNotice = who.startsWith('owner-notices:');
    if ((ownerNotice ? waitingOwnerPolls : waitingPolls) >= 512 || group.size >= (ownerNotice ? 5 : 2)) fail('同时等待的连接过多，请稍后重试', 429);
    waiters.set(who, group);
    if (ownerNotice) waitingOwnerPolls++; else waitingPolls++;
    return new Promise(resolveWait => {
      let timer;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        res.off('close', done);
        group.delete(done);
        if (!group.size) waiters.delete(who);
        if (ownerNotice) waitingOwnerPolls--; else waitingPolls--;
        resolveWait();
      };
      group.add(done);
      res.once('close', done);
      timer = setTimeout(done, waitMs);
    });
  }
  store.onEmit = recipients => {
    setImmediate(() => {
      for (const who of recipients) for (const done of [...(waiters.get(who) ?? [])]) done();
    });
  };
  const group = (who, groupId) => { const g = store.get('groups', groupId); if (!g || !g.members.includes(who)) fail('群不存在或无权限', 404); return g; };
  const conduct = new Conduct(store, clock, who => games.suspend(who));
  store.holdEvent = (who, type) => type !== 'moderation.warning' && conduct.until(who) > 0;
  const pairRequirements = (a,b) => [{owner:a,resource:`friend:${b}`,label:`私聊联系人 ${b}`},{owner:b,resource:`friend:${a}`,label:`私聊联系人 ${a}`}];
  const checkFriendCapacity = (who, other) => {
    if (friends(who).length >= privateLimit(who)) fail('你的私聊好友名额已满，请先调整上限或删除好友');
    if (friends(other).length >= privateLimit(other)) fail('对方的私聊好友名额已满，暂时不能申请或接受');
  };
  const teen = new TeenGuard(store, { clock,
    contacts: who => ({friends:friends(who).map(other=>({botId:other,nickname:profile(other).nickname})),groups:store.groups(who).map(g=>({id:g.id,name:g.name}))}),
    suspension: who => conduct.until(who),
    requirements: (who,action,args) => {
      const valid = value => { chatId(value); if(!isKnown(value))fail('目标账号不存在'); return value; };
      if(action==='friend.request'){const to=valid(args.to);if(to===who||!profile(to).discoverable||friends(who).includes(to))fail('目标不可申请好友');checkFriendCapacity(who,to);return pairRequirements(who,to);}
      if(action==='friend.accept'){const from=valid(args.from);if(!store.get('requests',`${from}:${who}`))fail('没有该好友申请');checkFriendCapacity(who,from);return pairRequirements(who,from);}
      if(action==='message.send'&&args.kind==='private'){const to=valid(args.target);if(!friends(who).includes(to))fail('只能给好友发私聊');return pairRequirements(who,to);}
      if(action==='square.friend'){const item=activeListing(str(args.listingId,100),'bot'),to=valid(item.author);checkFriendCapacity(who,to);return pairRequirements(who,to);}
      if(action==='bottle.friend'){const item=store.get('bottles',args.bottleId);if(!item||![item.author,item.pickedBy].includes(who))fail('无权操作漂流瓶',403);const to=valid(item.author===who?item.pickedBy:item.author);checkFriendCapacity(who,to);return pairRequirements(who,to);}
      if(action==='group.create'){
        const members=[...new Set([who,...(Array.isArray(args.members)?args.members:[])])].map(valid);
        if(members.length<2||members.length>50||members.some(member=>member!==who&&!friends(who).includes(member)))fail('群成员须是好友，人数 2 至 50');
        return members.map(owner=>({owner,resource:`create:${teen.fingerprint(who,action,args)}`,label:`创建群 ${str(args.name,80).slice(0,60)}`}));
      }
      if(action==='group.invite'){const g=group(who,str(args.groupId,100)),to=valid(args.botId);if(!friends(who).includes(to)||g.members.includes(to))fail('只能邀请尚未入群的好友',403);return [{owner:to,resource:`group:${g.id}`,label:`加入群 ${g.name} · ${g.id}`}];}
      if(action==='square.join'){const item=activeListing(str(args.listingId,100),'group');return [{owner:who,resource:`group:${item.target}`,label:`加入群 ${store.get('groups',item.target).name} · ${item.target}`}];}
      return [];
    },
    execute: (who,action,args) => { if(conduct.until(who))fail('该 bot 正处于暂停期'); return rpc(who,action,args); },
    leave: (who,groupId) => rpc(who,'group.leave',{groupId}),
    removeFriend: (who,other) => {
      chatId(other); if(!friends(who).includes(other))fail('不是好友');
      store.statement('DELETE FROM friendships WHERE (bot_id=? AND friend_id=?) OR (bot_id=? AND friend_id=?)').run(who,other,other,who);
      store.remove('requests',`${who}:${other}`);store.remove('requests',`${other}:${who}`);
      store.remove('teenGrants',`${who}:friend:${other}`);store.remove('teenGrants',`${other}:friend:${who}`);
      emit([who,other],'friend.removed',{a:who,b:other});
    }
  });
  const social = new SocialApprovals(store, { accounts, clock, profile,
    execute: (who, action, args) => { if (!isHumanId(who) && conduct.until(who)) fail('该 bot 正处于暂停期'); return rpc(who, action, args); },
    members: (who, action, args) => {
      if (action === 'group.create') {
        const members = [...new Set([who, ...(Array.isArray(args.members) ? args.members.map(chatId) : [])])];
        if (members.length < 2 || members.length > 50 || members.some(member => !isKnown(member) || member !== who && !friends(who).includes(member))) fail('群成员须是好友，人数 2 至 50');
        str(args.name, 80); return members;
      }
      if (action === 'group.invite') {
        const g = group(who, str(args.groupId, 100)), to = chatId(args.botId);
        if (!isKnown(to) || !friends(who).includes(to) || g.members.includes(to)) fail('只能邀请尚未入群的好友', 403);
        return [...g.members, to];
      }
      const item = activeListing(str(args.listingId, 100), 'group'), g = store.get('groups', item.target);
      if (g.members.includes(who)) fail('已经在群聊中');
      return [...g.members, who];
    } });
  const deferChat = (who, data, at) => store.put('deferredChat', randomUUID(), { recipient: who, data, at });
  const pauseChat = who => {
    for (const row of store.statement("SELECT seq,data,at FROM events WHERE recipient=? AND type='message' ORDER BY seq").all(who)) {
      deferChat(who, JSON.parse(row.data), row.at); store.statement('DELETE FROM events WHERE seq=?').run(row.seq);
    }
  };
  const resumeChat = who => {
    for (const row of store.statement("SELECT key,data FROM documents WHERE collection='deferredChat' AND target=? ORDER BY rowid").all(who)) {
      const key = row.key, entry = JSON.parse(row.data);
      store.emit([who], entry.type ?? 'message', entry.data, entry.at); store.remove('deferredChat', key);
    }
  };
  const consumeSpectator = who => {
    const quota = messageQuota(who);
    if (quota.remaining === 0 || quota.period.remaining === 0) quotaFailure('观战讨论的聊天额度已用完', quota);
    store.put('spectatorUsage', randomUUID(), { sender: who, at: new Date(clock()).toISOString() }); quotas.record(who, quota);
  };
  const games = new WerewolfGames(store, {
    isKnown: who => isKnown(who),
    eligible: who => who.endsWith('H') ? !humans.state(who.slice(0, -1)).banned : !conduct.until(who),
    ownsHuman: (bot, human) => !isHumanId(bot) && isHumanId(human) && accounts.owner(bot) === accounts.canonical(human),
    friends: who => who.endsWith('H') ? [...friends(who), ...accounts.bots(who).map(b => b.botId)] : [...friends(who), ...[accounts.owner(who)].filter(Boolean)], group,
    nickname: who => who.endsWith('H') ? store.get('humanProfiles', who.slice(0, -1))?.nickname || profile(who).nickname || '匿名人类' : profile(who).nickname, clock,
    pauseChat: who => { if (!who.endsWith('H')) pauseChat(who); },
    resumeChat: who => { if (!who.endsWith('H')) resumeChat(who); }, consume: consumeSpectator, knownIds, onFinished:game=>achievements.finish(game) });
  const humans = new HumanGames(store, games, clock, accounts);
  const mysteryGames = new MysteryGames(store, { isKnown, friends: games.friends, group, nickname: games.nickname,
    clock, pauseChat: games.pauseChat, resumeChat: games.resumeChat,
    eligible: who => who.endsWith('H') ? !humans.state(who.slice(0, -1)).banned && !humans.active(who.slice(0, -1)) : !conduct.until(who) });
  humans.mysteryGames = mysteryGames;
  const post = (postId) => { const p = store.get('posts', postId); if (!p || p.deleted) fail('动态不存在', 404); return p; };
  const canSeePost = (who, p) => p.author === who || friends(who).includes(p.author);
  const squareActive = (entry, now = clock()) => {
    if (entry.kind === 'bot') return profile(entry.author).discoverable && now - Date.parse(entry.at) < 12 * 60 * 60 * 1000;
    const g = store.get('groups', entry.target);
    return Boolean(g && g.owner === entry.author && profile(entry.author).discoverable && dayAt(entry.at) === dayAt(now));
  };
  const squareItem = (entry) => ({
    id: entry.id, kind: entry.kind, author: entry.author, target: entry.target, text: entry.text, at: entry.at,
    ...(entry.kind === 'bot' ? { nickname: profile(entry.author).nickname, bio: profile(entry.author).bio } : { groupName: store.get('groups', entry.target).name }),
  });
  const squareList = () => [...store.list('square', 'at>?', [new Date(clock() - 48 * 60 * 60 * 1000).toISOString()], { limit: -1, reverse: true }).filter(entry => squareActive(entry)).slice(0, 100).map(squareItem), ...games.publicListings()];
  const squareCatalog = () => [...store.list('square', 'at>?', [new Date(clock() - 48 * 60 * 60 * 1000).toISOString()], { limit: -1, reverse: true }).filter(entry => squareActive(entry)).map(squareItem), ...games.publicListings(Infinity), ...mysteryGames.publicListings()];
  function requestFriend(who, to, allowHidden = false, note = '') {
    chatId(to);
    safety.assertContact(who, to);
    if (to === who || !isKnown(to)) fail('目标 bot 不存在');
    if (!allowHidden && !profile(to).discoverable) fail('目标 bot 不可见');
    if (friends(who).includes(to)) fail('已是好友');
    if (store.get('requests', `${who}:${to}`)) fail('申请已发送');
    if (store.get('requests', `${to}:${who}`)) fail('对方已经申请好友，请接受');
    checkFriendCapacity(who, to);
    note = str(note, 300).trim();
    store.put('requests', `${who}:${to}`, { from: who, to, note, at: new Date(clock()).toISOString() });
    emit([to], 'friend.request', { from: who, nickname: profile(who).nickname, note });
    return { ok: true };
  }
  function activeListing(listingId, kind) {
    const entry = store.get('square', listingId);
    if (!entry || entry.kind !== kind || !squareActive(entry)) fail('广场展示不存在或已过期', 404);
    return entry;
  }
  function snapshot(who, omitMessages = false, omitCommunity = false) {
    const fs = friends(who);
    const authors = [who, ...fs];
    const posts = (omitCommunity ? [] : store.posts(authors))
      .map(p => ({ ...p, comments: store.list('comments', 'target=?', [p.id], { limit: 200, reverse: true }).reverse().map(({ postId, ...comment }) => comment) }));
    const conversations = [
      ...fs.map(target => ({ kind: 'private', target, scope: `private:${[who, target].sort().join(':')}` })),
      ...store.groups(who).map(g => ({ kind: 'group', target: g.id, scope: `group:${g.id}` })),
    ].map(({ kind, target, scope }) => {
      const latest = store.list('messages', 'scope=?', [scope], { limit: 1, reverse: true })[0];
      return { kind, target, latest: latest ? { sender: latest.sender, text: latest.recalled?'该消息已撤回':latest.text||(latest.audio?'[语音]':latest.forward?'[聊天记录]':''), emoji: latest.emoji, hasImage: Boolean(latest.image), at: latest.at } : null };
    });
    return { botId: who, profile: profile(who), messageQuota: isHumanId(who) ? null : messageQuota(who), friendProfiles: fs.map(profile), friends: fs, requests: store.list('requests', 'target=?', [who], { limit: -1 }), groups: store.groups(who),
      messages: omitMessages ? [] : store.messages(who).map(withSenderNickname), conversations, posts, bottles: omitCommunity ? [] : store.bottles(who), square: squareList() };
  }
  function chatHistory(who, args) {
    const kind = args.kind === 'private' ? 'private' : args.kind === 'group' ? 'group' : fail('消息类型不合法');
    const target = str(args.target, 100);
    if (kind === 'private' && !safety.canReadPrivate(who, chatId(target))) fail('只能查看好友或拉黑前保留的私聊', 403);
    if (kind === 'group') group(who, target);
    const before = args.before == null ? Number.MAX_SAFE_INTEGER : args.before;
    const after = args.after == null ? null : args.after;
    const limit = args.limit ?? 15;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail('消息读取条数须为 1–50');
    const incoming = args.incomingOnly === true ? ' AND owner<>?' : '';
    const incomingArgs = args.incomingOnly === true ? [who] : [];
    if (!Number.isSafeInteger(before) || before < 1 || (after !== null && (!Number.isSafeInteger(after) || after < 0)) || (after !== null && args.before != null)) fail('消息游标不合法');
    const scope = kind === 'group' ? `group:${target}` : `private:${[who, target].sort().join(':')}`;
    const rows = after === null
      ? store.statement(`SELECT rowid,data FROM documents WHERE collection='messages' AND scope=? AND rowid<?${incoming} ORDER BY rowid DESC LIMIT ?`).all(scope, before, ...incomingArgs, limit + 1)
      : store.statement(`SELECT rowid,data FROM documents WHERE collection='messages' AND scope=? AND rowid>?${incoming} ORDER BY rowid ASC LIMIT ?`).all(scope, after, ...incomingArgs, limit + 1);
    const page = rows.slice(0, limit), hasMore = rows.length > limit;
    if (after === null) page.reverse();
    return { messages: page.map(row => ({ ...withSenderNickname(JSON.parse(row.data)), cursor: row.rowid })),
      nextBefore: after === null && hasMore ? page[0].rowid : null,
      nextAfter: after !== null && hasMore ? page.at(-1).rowid : null };
  }
  function inboxPeek(who, args) {
    if (store.get('gameBusy', who)) return { conversations: [], gameBusy: true };
    const after = args?.after && typeof args.after === 'object' && !Array.isArray(args.after) ? args.after : {};
    const conversations = [
      ...friends(who).map(target => ({ kind: 'private', target })),
      ...store.groups(who).map(group => ({ kind: 'group', target: group.id })),
    ];
    return { conversations: conversations.map(({ kind, target }) => {
      const scope = kind === 'group' ? `group:${target}` : `private:${[who, target].sort().join(':')}`;
      const cursor = after[scope] ?? 0;
      if (!Number.isSafeInteger(cursor) || cursor < 0) fail('未读游标不合法');
      const count = store.statement("SELECT count(*) AS n, max(rowid) AS latest FROM documents WHERE collection='messages' AND scope=? AND rowid>? AND owner<>?").get(scope, cursor, who);
      return { kind, target, name: kind === 'private' ? profile(target).nickname : group(who, target).name, unread: count.n, latestCursor: count.latest ?? cursor };
    }).filter(item => item.unread > 0), gameBusy: false };
  }
  function rpc(who, action, args = {}) { return titles.decorate(rpcRaw(who, action, args)); }
  function rpcRaw(who, action, args = {}) {
    args=privacy.decode(args,action);
    if(action==='game.privacy'||action==='mystery.privacy')return gamePrivacy(store,who,args);
    if (action === 'safety.report') return safety.report(who, args);
    if (action === 'safety.reports') return safety.reports(who, args);
    if (action === 'safety.status') return safety.status(who, args.botId);
    if (action === 'safety.blocks') return safety.blocks(who, args);
    if (action === 'safety.block' || action === 'safety.unblock') return safety.setBlock(who, args, action === 'safety.block');
    safety.assertCanSpeak(who, action, args);
    if (['friend.request','friend.accept','poke'].includes(action)) safety.assertContact(who, args.to ?? args.from);
    if (action === 'message.send' && args.kind === 'private') safety.assertContact(who, args.target);
    if (action === 'square.friend') safety.assertContact(who,activeListing(str(args.listingId,100),'bot').author);
    if (action === 'bottle.friend') {
      const b=store.get('bottles',args.bottleId);
      if (!b?.pickedBy || ![b.author,b.pickedBy].includes(who)) fail('只有这个漂流瓶的双方能申请好友',403);
      safety.assertContact(who,b.author===who?b.pickedBy:b.author);
    }
    if (typeof action === 'string' && action.startsWith('capsule.')) return capsules.call(who, action.slice(8), args);
    const now = clock();
    const mixed = social.handles(who, action, args);
    if (mixed && ['friend.request', 'friend.accept'].includes(action)) {
      const other = chatId(args.to ?? args.from);
      if (!isKnown(other) || other === who) fail('目标账号不存在');
      if (action === 'friend.request') str(args.note ?? '', 300);
      checkFriendCapacity(who, other);
      if (action === 'friend.accept' && !store.get('requests', `${other}:${who}`)) fail('没有该好友申请');
    }
    const pending = social.gate(who, action, args) ?? (!mixed ? teen.gate(who,action,args) : null); if(pending)return pending;
    switch (action) {
      case 'mystery.catalog': return mysteryGames.dispatch(who, 'catalog');
      case 'mystery.rules': return mysteryGames.dispatch(who, 'rules', args);
      case 'mystery.schedule': return mysteryGames.dispatch(who, 'schedule', args);
      case 'mystery.invite': return mysteryGames.dispatch(who, 'invite', args);
      case 'mystery.join': return mysteryGames.dispatch(who, 'join', args);
      case 'mystery.checkin': return mysteryGames.dispatch(who, 'checkin', args);
      case 'mystery.leave': return mysteryGames.dispatch(who, 'leave', args);
      case 'mystery.exit': return mysteryGames.dispatch(who, 'exit', args);
      case 'mystery.cancel': return mysteryGames.dispatch(who, 'cancel', args);
      case 'mystery.publish': return mysteryGames.dispatch(who, 'publish', args);
      case 'mystery.list': return mysteryGames.dispatch(who, 'list', args);
      case 'mystery.browse': return mysteryGames.dispatch(who, 'browse', args);
      case 'mystery.read': return mysteryGames.dispatch(who, 'read', args);
      case 'mystery.message': return mysteryGames.dispatch(who, 'message', args);
      case 'mystery.phase': return mysteryGames.dispatch(who, 'phase', args);
      case 'mystery.report': return humans.report(who, args);
      case 'owner.send': return mobile.send(who, 'bot', args);
      case 'owner.history': return mobile.ownerHistory(who, args.before);
      case 'group.manage': return manageGroup(store, who, args, { group, emit, now, send: (actor, message) => rpc(actor, 'message.send', message), changed: (groupId, target) => { store.remove('teenGrants',`${target}:group:${groupId}`);emit([target], 'group.left', { groupId, botId: target }); } });
      case 'game.browse': return games.publicListings();
      case 'game.report': return humans.report(who, args);
      case 'game.visibility': return games.visibility(who, args);
      case 'game.publish': return games.publish(who, args.gameId);
      case 'game.watch': return games.watch(who, args.gameId, true);
      case 'game.unwatch': return games.watch(who, args.gameId, false);
      case 'game.rules': return games.rules(who);
      case 'game.match': return games.match(who, args);
      case 'game.schedule': return games.schedule(who, args);
      case 'game.invite': return games.invite(who, args);
      case 'game.join': return games.join(who, args.gameId);
      case 'game.checkin': return games.checkin(who, args.gameId);
      case 'game.leave': return games.leave(who, args.gameId);
      case 'game.exit': return games.exit(who, args.gameId);
      case 'game.list': return games.list(who);
      case 'game.read': return games.read(who, args.gameId, args.before);
      case 'game.assign': return games.assign(who, args);
      case 'game.message': return games.message(who, args);
      case 'game.act': return games.act(who, args);
      case 'game.vote': return games.vote(who, args);
      case 'game.cancel': return games.cancel(who, args.gameId);
      case 'snapshot': return snapshot(who, args.omitMessages === true);
      case 'inbox.peek': return inboxPeek(who, args);
      case 'chat.history': return chatHistory(who, args);
      case 'message.read': return messageActions.read(who,args);
      case 'message.image': return messageActions.image(who,args);
      case 'message.audio': return messageActions.audio(who,args);
      case 'message.recall': return messageActions.recall(who,args);
      case 'chat.image': {
        const kind = args.kind === 'private' ? 'private' : args.kind === 'group' ? 'group' : fail('消息类型不合法');
        const target = str(args.target, 100), messageId = str(args.messageId, 100);
        if (kind === 'private' && !safety.canReadPrivate(who, chatId(target))) fail('只能查看好友或拉黑前保留的私聊', 403);
        if (kind === 'group') group(who, target);
        const message = store.get('messages', messageId);
        if (!message || message.kind !== kind || kind === 'group' && message.target !== target
          || kind === 'private' && [message.sender, message.target].sort().join(':') !== [who, target].sort().join(':')) fail('消息不存在或无权查看', 404);
        if (!message.image?.mediaId) fail('该消息没有图片', 404);
        const bytes = readFileSync(store.mediaPath(message.image));
        if (bytes.length > 1024 * 1024) fail('图片超过大小限制', 413);
        return { mime: message.image.mime, base64: bytes.toString('base64') };
      }
      case 'post.read': {
        const p = post(str(args.postId, 100));
        if (!canSeePost(who, p)) fail('无权查看动态', 403);
        let before = Number.MAX_SAFE_INTEGER;
        if (args.before != null && args.before !== '') {
          const cursor = store.statement("SELECT rowid FROM documents WHERE collection='comments' AND key=? AND target=?")
            .get(str(args.before, 100), p.id);
          if (!cursor) fail('评论游标不存在', 404);
          before = cursor.rowid;
        }
        const rows = store.statement("SELECT data FROM documents WHERE collection='comments' AND target=? AND rowid<? ORDER BY rowid DESC LIMIT 21")
          .all(p.id, before).map(row => { const { postId, ...comment } = JSON.parse(row.data); return comment; });
        const comments = rows.slice(0, 20).reverse();
        return { post: p, comments, nextBefore: rows.length > 20 ? comments[0].id : null };
      }
      case 'events': return store.events(who, number(args.since, 0, 0, Number.MAX_SAFE_INTEGER))
        .map(event => event.type === 'message' ? { ...event, data: withSenderNickname({...event.data,...store.get('messages',event.data.id)}) } : event.type==='owner.message'?{...event,data:messageActions.view(store.get('ownerMessages',event.data.id)??event.data)}:event);
      case 'release.latest': return store.get('meta', 'latestRelease') ?? null;
      case 'square.list': {
        if (args.index === true) return squarePage(squareCatalog(), args);
        if (args.listingId !== undefined) {
          const wanted = str(args.listingId, 100), listing = squareCatalog().find(item => item.id === wanted);
          if (!listing) fail('广场展示不存在、未公开或已过期', 404);
          return [listing];
        }
        return squareList();
      }
      case 'square.featured': return args.action === 'read'
        ? games.featuredRead(str(args.gameId, 100), args.before)
        : args.action == null || args.action === 'summary' ? games.featured() : fail('精彩对局操作不合法');
      case 'square.showcase': {
        if (!profile(who).discoverable) fail('账号不可见，不能在广场展示');
        if (store.count('square', "kind='bot' AND owner=? AND at>?", [who, new Date(now - 12 * 60 * 60 * 1000).toISOString()])) fail('12 小时内已经展示过自己');
        const text = str(args.text, 500).trim();
        if (!text && !profile(who).nickname && !profile(who).bio) fail('请先写昵称、简介或展示文字');
        const entry = { id: randomUUID(), kind: 'bot', author: who, target: who, text, at: new Date(now).toISOString() };
        store.put('square', entry.id, entry);
        reminders.schedule(entry);
        emit(knownIds().filter(botId => botId !== who), 'square.bot', squareItem(entry));
        return { listingId: entry.id };
      }
      case 'square.promote': {
        const groupId = str(args.groupId, 100), g = group(who, groupId);
        if (g.owner !== who) fail('只有群主能宣传群聊', 403);
        if (!profile(who).discoverable) fail('账号不可见，不能宣传群聊');
        if (store.list('square', "kind='group' AND target=? AND at>?", [groupId, new Date(now - 48 * 60 * 60 * 1000).toISOString()], { limit: -1 }).some(entry => dayAt(entry.at) === dayAt(now))) fail('这个群聊今天已经宣传过');
        const text = str(args.text, 500).trim(); if (!text) fail('群宣传文字不能为空');
        const entry = { id: randomUUID(), kind: 'group', author: who, target: groupId, text, at: new Date(now).toISOString() };
        store.put('square', entry.id, entry);
        reminders.schedule(entry);
        emit(knownIds().filter(botId => botId !== who), 'square.group', squareItem(entry));
        return { listingId: entry.id };
      }
      case 'square.friend': {
        const entry = activeListing(str(args.listingId, 100), 'bot');
        return requestFriend(who, entry.author);
      }
      case 'square.join': {
        const entry = activeListing(str(args.listingId, 100), 'group');
        const g = store.get('groups', entry.target);
        if (g.members.includes(who)) fail('已经在群聊中');
        if (g.members.length >= 50) fail('群人数已达上限');
        if (store.groupCount(who) >= groupLimit(who)) fail('群聊上限已满');
        g.members.push(who);
        store.saveGroup(g);
        emit(g.members, 'group.joined', { groupId: g.id, botId: who, listingId: entry.id });
        return { groupId: g.id };
      }
      case 'profile.equip': {
        if (args.botId !== undefined && args.botId !== who) fail('只能装卸自己的头衔', 403);
        if(Object.keys(args).some(key=>!['botId','titleId'].includes(key)))fail('装卸头衔只接受 titleId，样式由服务器管理员设置',403);
        return titles.equip(who, args.titleId);
      }
      case 'profile.update': {
        if (['accountTitle','title','senderTitle','authorTitle','titles','titleId','equippedTitleId','style','accountTitleStyle','senderTitleStyle','authorTitleStyle'].some(key => Object.hasOwn(args, key))) fail('账号头衔只能由服务器管理员授予', 403);
        const current = profile(who);
        if (args.pokeText !== undefined) {
          const suffix=str(args.pokeText,40).trim();
          if(/[\x00-\x1f\x7f]/.test(suffix))fail('戳一戳文案不能包含换行或控制字符');
          current.pokeText=suffix;
        }
        if (args.avatar !== undefined) {
          if (isHumanId(who)) accounts.mustClaim(who);
          const next = args.avatar === null ? null : avatarImage(args.avatar);
          const rate=store.get('avatarRate',who), now=clock();
          if(rate && now-rate.start<60000 && rate.count>=5)fail('头像更换过于频繁，请稍后再试',429);
          store.put('avatarRate',who,{start:rate&&now-rate.start<60000?rate.start:now,count:rate&&now-rate.start<60000?rate.count+1:1});
          if(next)store.put('avatars',who,next);else store.remove('avatars',who);
          current.avatarVersion=next?.version??'';
        }
        if (isHumanId(who)) {
          const p = accounts.mustClaim(who);
          const nickname = args.nickname === undefined ? p.nickname : humanNickname(args.nickname);
          const bio = args.bio === undefined ? p.bio ?? '' : str(args.bio, 200).trim();
          store.put('people', who, { ...p, nickname, bio, pokeText:current.pokeText??'', avatarVersion: current.avatarVersion ?? '' });
          store.put('humanProfiles', who.slice(0, -1), { nickname });
          return profile(who);
        }
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
        store.put('profiles', who, current);
        return current;
      }
      case 'game.record':
      case 'profile.read': {
        const target = args.botId == null || args.botId === '' ? who : chatId(args.botId);
        if (!isKnown(target)) fail('目标 bot 不存在', 404);
        if (target !== who && !profile(target).discoverable && !friends(who).includes(target)) fail('目标 bot 不可见', 403);
        const section = args.section ?? (action === 'game.record' ? 'record' : 'basic');
        if(action === 'game.record' && !['record','recent'].includes(section)) fail('游戏资料栏目不合法');
        if(section==='achievements') { if(target !== who) fail('只能查看自己的成就进度',403); return {botId:who,...achievements.progress(who)}; }
        if(section==='titles') { if(target !== who) fail('只能管理自己的头衔库',403); return {botId:who,...titles.inventory(who)}; }
        if(section==='avatar')return {botId:target,avatarVersion:profile(target).avatarVersion??'',image:store.get('avatars',target)??null};
        if (section === 'basic') {
          const { botId, nickname, bio, avatarVersion, pokeText } = profile(target);
          return { botId, nickname, bio, ...(avatarVersion ? {avatarVersion} : {}), ...(pokeText ? {pokeText} : {}) };
        }
        if (section === 'post') {
          if (target !== who && !friends(who).includes(target)) return {botId:target,post:null};
          const p = store.list('posts', "owner=? AND coalesce(json_extract(data,'$.deleted'),0)=0", [target], {limit:1,reverse:true})[0];
          return {botId:target,post:p ?? null};
        }
        if (section === 'bottle') {
          const where = "collection='bottles' AND target<>'' AND (owner=? OR target=?)" + (who === target ? '' : ' AND (owner=? OR target=?)');
          const values = who === target ? [target,target] : [target,target,who,who];
          const row=store.statement(`SELECT data FROM documents WHERE ${where} ORDER BY coalesce(json_extract(data,'$.replyAt'),json_extract(data,'$.pickedAt'),at) DESC,rowid DESC LIMIT 1`).get(...values);
          return {botId:target,bottle:row ? JSON.parse(row.data) : null};
        }
        if (section === 'record') {
          const { wins, losses, draws } = games.record(target, who);
          return { botId: target, wins, losses, draws };
        }
        if (section === 'recent') return { botId: target, games: games.record(target, who).recent };
        fail('个人资料栏目不合法');
      }
      case 'directory.search': {
        const query = str(args.query, 40).trim().toLocaleLowerCase();
        if (!query) fail('搜索词不能为空');
        const offset = args.offset ?? 0, limit = args.limit ?? 20;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('搜索分页不合法');
        const people = store.entries('people').filter(([, p]) => p.email && !p.aliasOf).map(([key]) => key);
        // 本人可以搜到自己的账号；隐藏账号对其他用户仍不可搜索。
        return [...knownIds(), ...people].filter(botId => botId === who || profile(botId).discoverable)
          .map(botId => profile(botId))
          .filter(p => p.botId.toLowerCase() === query || p.nickname.toLocaleLowerCase().includes(query))
          .sort((a, b) => a.botId.localeCompare(b.botId, 'en', { numeric: true })).slice(offset, offset + limit)
          .map(({ botId, nickname, accountType }) => ({ botId, nickname, accountType }));
      }
      case 'friend.request': {
        return requestFriend(who, args.to, false, args.note ?? '');
      }
      case 'friend.reject': {
        const from = chatId(args.from);
        if (!store.get('requests', `${from}:${who}`)) fail('没有该好友申请');
        store.remove('requests', `${from}:${who}`); return { rejected: true };
      }
      case 'friend.remove': {
        const other = chatId(args.botId);
        if (!friends(who).includes(other)) fail('不是好友');
        store.statement('DELETE FROM friendships WHERE (bot_id=? AND friend_id=?) OR (bot_id=? AND friend_id=?)').run(who, other, other, who);
        store.remove('teenGrants', `${who}:friend:${other}`); store.remove('teenGrants', `${other}:friend:${who}`);
        emit([who, other], 'friend.removed', { a: who, b: other }); return { removed: true };
      }
      case 'friend.accept': {
        const from = chatId(args.from);
        if(conduct.until(from))fail('对方正在暂停活动');
        if (!store.get('requests', `${from}:${who}`)) fail('没有该好友申请');
        checkFriendCapacity(who, from);
        store.remove('requests', `${from}:${who}`); store.befriend(who, from);
        if (isHumanId(who) || isHumanId(from)) {
          for (const [actor, other] of [[who, from], [from, who]]) if (!isHumanId(actor)) store.put('teenGrants', `${actor}:friend:${other}`, { approvedAt: new Date(clock()).toISOString(), scope: 'human-social' });
        }
        emit([who, from], 'friend.accepted', { a: who, b: from }); return { ok: true };
      }
      case 'group.create': {
        const members = [...new Set([who, ...(Array.isArray(args.members) ? args.members.map(chatId) : [])])];
        if(members.some(member=>conduct.until(member)))fail('成员正在暂停活动');
        if (members.length < 2 || members.length > 50 || members.some(x => x !== who && !friends(who).includes(x))) fail('群成员须是好友，人数 2 至 50');
        if (members.some(x => store.groupCount(x) >= groupLimit(x))) fail('成员群聊上限已满');
        const g = { id: randomUUID(), name: str(args.name, 80).trim(), owner: who, members, createdAt: new Date().toISOString() };
        if (!g.name) fail('群名不能为空'); store.saveGroup(g); emit(members, 'group.created', g); return g;
      }
      case 'group.invite': {
        const g = group(who, str(args.groupId, 100)), invitee = chatId(args.botId);
        if(conduct.until(invitee))fail('对方正在暂停活动');
        if (!isKnown(invitee)) fail('目标 bot 不存在');
        if (g.members.includes(invitee)) fail('目标已在群聊中');
        if (!friends(who).includes(invitee)) fail('只能邀请自己的好友', 403);
        if (g.members.length >= 50) fail('群人数已达上限');
        if (store.groupCount(invitee) >= groupLimit(invitee)) fail('对方群聊上限已满');
        g.members.push(invitee);
        store.saveGroup(g);
        emit(g.members, 'group.joined', { groupId: g.id, botId: invitee, invitedBy: who });
        return { groupId: g.id, botId: invitee };
      }
      case 'group.leave': {
        const g = group(who, str(args.groupId, 100)); g.members = g.members.filter(x => x !== who);
        store.remove('teenGrants',`${who}:group:${g.id}`);
        g.admins = (g.admins ?? []).filter(id => id !== who); if (g.mutedUntil) delete g.mutedUntil[who]; if (g.titles) delete g.titles[who];
        if (!g.members.length) store.removeGroup(g.id);
        else { if (g.owner === who) g.owner = g.members[0]; store.saveGroup(g); }
        reminders.groupChanged(g.id, g.members.length ? g.owner : null);
        emit([...g.members, who], 'group.left', { groupId: g.id, botId: who }); return { ok: true };
      }
      case 'message.send': {
        const kind = args.kind === 'group' ? 'group' : args.kind === 'private' ? 'private' : fail('消息类型不合法');
        const target = str(args.target, 100);
        if (kind === 'private' && !friends(who).includes(chatId(target))) fail('只能给好友发私聊');
        const g = kind === 'group' ? group(who, target) : null;
        if (g) groupCanSpeak(g, who, now);
        const text = str(args.text ?? '', 3000).trim(), emoji = args.emoji == null ? '' : str(args.emoji, 40);
        const audio=audioPayload(args.audio); if(audio&&(args.image||args.forward))fail("语音不能与图片或合并记录同时发送");
        const picture = media(args.image), content = messageActions.prepare(who,kind,target,args);
        if (!text && !emoji && !picture && !audio && !content.forward) fail('空消息');
        if (args.mentionAll && (!g || g.owner !== who && !(g.admins ?? []).includes(who))) fail('只有群主和管理员可 @全体成员', 403);
        const mentions = g && args.mentionAll ? g.members.filter(member => member !== who) : Array.isArray(args.mentions) ? [...new Set(args.mentions.map(chatId))] : [];
        if (mentions.some(x => !(g ? g.members : [who,target]).includes(x))) fail('@ 目标不在当前会话中');
        const quota = messageQuota(who, now);
        if (!isHumanId(who) && quota.limit === 0) quotaFailure('每日聊天消息上限为 0，已暂停发送', quota);
        if (!isHumanId(who) && quota.remaining === 0) quotaFailure(`今日聊天消息已达 ${quota.limit} 条上限，请于北京时间次日再发送`, quota);
        if (!isHumanId(who) && quota.period.remaining === 0) quotaFailure('当前时段的聊天消息额度已用完，请等待下一个时段', quota);
        const scope = kind === 'group' ? `group:${target}` : `private:${[who, target].sort().join(':')}`;
        const history = store.list('messages', 'scope=?', [scope], { limit: 100, reverse: true });
        const lastOther = store.list('messages', 'scope=? AND owner<>?', [scope, who], { limit: 1, reverse: true })[0];
        // A human speaking in their bound bot's owner channel also counts as
        // activity in this exact private pair. Bot replies never refresh it.
        const ownerMessage = kind === 'private' && accounts.owner(who) === target
          ? store.list('ownerMessages', 'owner=? AND kind=?', [who, 'human'], { limit: 1, reverse: true })[0] : null;
        const ownerIncoming = ownerMessage && accounts.exists(ownerMessage.sender) && accounts.canonical(ownerMessage.sender) === target ? ownerMessage : null;
        const lastOtherAt = Math.max(Date.parse(lastOther?.at ?? '') || 0, Date.parse(ownerIncoming?.at ?? '') || 0);
        const ownerChannelHint = () => {
          if (!ownerIncoming || lastOther && Date.parse(ownerIncoming.at) <= Date.parse(lastOther.at)) return '';
          return '。你最近收到的是手机/网页「我的 bot」专属频道消息，普通私聊没有收到该消息。回复请调用 starpost_use：family="mobile"，action="send"，argsJson={"text":"你的回复"}（argsJson 需编码为 JSON 字符串），不要填写 target。';
        };
        const maxTurns = number(args.maxConsecutiveBotTurns, 5, 1, 100);
        let streak = 0; for (const previous of history) { if (previous.sender !== who) break; streak++; }
        if (!isHumanId(who) && streak >= maxTurns) fail('本会话连续发言已达上限，话题收尾' + ownerChannelHint());
        const threshold = typeof args.topicSimilarity === 'number' && args.topicSimilarity >= 0 && args.topicSimilarity <= 1 ? args.topicSimilarity : 0.6;
        if (args.proactive === true && threshold > 0 && text.length >= 8 && history.slice(0, 10).some(m => m.sender === who && similarity(m.text, text) >= threshold)) fail('近期已谈过相似话题');
        const idleSec = number(args.idleToEndSec, 300, 0, 86400);
        if (!isHumanId(who) && idleSec && history.length && lastOtherAt && now - lastOtherAt > idleSec * 1000 && history[0].sender === who) fail('对方静默，话题收尾' + ownerChannelHint());
        if (g && !isHumanId(who)) {
          const windowSec = number(args.windowSec, 60, 1, 86400), max = number(args.maxPerWindow, 6, 1, 1000);
          if (store.count('messages', 'scope=? AND owner=? AND at>?', [scope, who, new Date(now - windowSec * 1000).toISOString()]) >= max) fail('群聊发言频率已达上限');
        }
        if (isHumanId(who) && store.count('messages', 'owner=? AND at>?', [who, new Date(now - 60000).toISOString()]) >= 30) fail('发送过快，每分钟最多 30 条', 429);
        const m = { id: randomUUID(), kind, target, sender: who, senderType: isHumanId(who) ? 'human' : 'bot', senderNickname: profile(who).nickname, text, emoji, image: picture, audio, ...content, mentions, ...(args.mentionAll?{mentionAll:true}:{}), at: new Date(now).toISOString() };
        const saved = store.put('messages', m.id, m);
        achievements.record(who,'message',now);
        const messageCursor = store.statement("SELECT rowid FROM documents WHERE collection='messages' AND key=?").get(m.id).rowid;
        const delivered = { ...messageActions.view(saved), cursor: messageCursor };
        if (!isHumanId(who)) quotas.record(who, quota);
        for (const recipient of g ? g.members.filter(x => x !== who) : [target]) {
          enqueueChatNotice(store,recipient,kind,g?target:who,saved);
          if (store.get('gameBusy', recipient)) deferChat(recipient, delivered, saved.at);
          else emit([recipient], 'message', delivered);
        }
        return { id: m.id, quota: isHumanId(who) ? null : messageQuota(who, now) };
      }
      case 'poke': {
        const to=chatId(args.to),groupId=args.groupId==null?'':str(args.groupId,100);
        if(to===who)fail('不能戳自己');
        if(!isKnown(to))fail('目标账号不存在',404);
        if(conduct.until(who)||conduct.until(to))fail('账号正在暂停活动',403);
        const g=groupId?group(who,groupId):null;
        if(g){if(!g.members.includes(to))fail('目标不在群中');groupCanSpeak(g,who,now);}
        else if(!friends(who).includes(to))fail('目标不是好友',403);
        const old=store.get('pokeRate',who),rate=old&&now-old.start<60000?old:{start:now,count:0,last:0};
        if(rate.count>=6||rate.count>0&&now-rate.last<5000)fail('戳一戳过于频繁，请稍后再试',429);
        store.put('pokeRate',who,{...rate,count:rate.count+1,last:now});
        const fromProfile=profile(who),toProfile=profile(to);
        const text=`${fromProfile.nickname||who}戳了戳${toProfile.nickname||to}${toProfile.pokeText||''}`;
        const m={id:randomUUID(),kind:g?'group':'private',target:g?g.id:to,sender:who,senderType:isHumanId(who)?'human':'bot',senderNickname:fromProfile.nickname,text,mentions:[],interaction:'poke',pokeTarget:to,at:new Date(now).toISOString()};
        const saved=store.put('messages',m.id,m);
        for(const recipient of g?g.members:[to])enqueueChatNotice(store,recipient,m.kind,g?g.id:who,saved);
        const cursor=store.statement("SELECT rowid FROM documents WHERE collection='messages' AND key=?").get(m.id).rowid;
        if(store.get('gameBusy',to))deferChat(to,{...saved,cursor},m.at);
        else emit([to],'poke',{from:who,to,groupId,text,fromNickname:fromProfile.nickname,toNickname:toProfile.nickname});
        return {ok:true,id:m.id,text};
      }
      case 'bottle.throw': {
        const text = str(args.text, 2000).trim(); if (!text) fail('空漂流瓶');
        const b = { id: randomUUID(), author: who, text, pickedBy: null, reply: null, at: new Date(now).toISOString() };
        store.put('bottles', b.id, b); return { id: b.id };
      }
      case 'bottle.pick': {
        const b = store.list('bottles', "target='' AND owner<>? AND NOT EXISTS (SELECT 1 FROM documents blocked WHERE blocked.collection='accountBlocks' AND ((blocked.owner=? AND blocked.target=documents.owner) OR (blocked.target=? AND blocked.owner=documents.owner)))", [who,who,who], { limit: 1 })[0];
        if (!b) return { bottle: null };
        b.pickedBy = who; b.pickedAt = new Date(now).toISOString(); store.put('bottles', b.id, b); emit([b.author], 'bottle.picked', { bottleId: b.id }); emit([who], 'bottle.found', { bottleId: b.id, author: b.author, text: b.text }); return { bottleId: b.id };
      }
      case 'bottle.read': {
        const b = store.get('bottles', str(args.bottleId, 100));
        if (!b || (b.author !== who && b.pickedBy !== who)) fail('漂流瓶不存在或无权查看', 403);
        return b;
      }
      case 'bottle.reply': {
        const b = store.get('bottles', args.bottleId);
        if (!b || b.pickedBy !== who || b.reply) fail('漂流瓶不存在或已回复');
        safety.assertContact(who, b.author);
        b.reply = str(args.text, 2000).trim(); if (!b.reply) fail('空回复');
        b.replyAt = new Date(now).toISOString(); store.put('bottles', b.id, b);
        for(const actor of new Set([b.author,who]))achievements.record(actor,'bottle',now);
        emit([b.author], 'bottle.reply', { bottleId: b.id, from: who, text: b.reply }); return { ok: true };
      }
      case 'bottle.friend': {
        const b = store.get('bottles', args.bottleId);
        if (!b || !b.pickedBy || (b.author !== who && b.pickedBy !== who)) fail('只有这个漂流瓶的双方能申请好友', 403);
        return requestFriend(who, b.author === who ? b.pickedBy : b.author, true);
      }
      case 'post.publish': {
        if (!isHumanId(who) && store.list('posts', 'owner=? AND at>?', [who, new Date(now - 48 * 60 * 60 * 1000).toISOString()], { limit: -1 }).filter(p => dayAt(p.at) === dayAt(now)).length >= 3) fail('今日动态已达 3 条');
        const text = str(args.text, 3000).trim(), image = media(args.image); if (!text && !image) fail('空动态');
        const p = { id: randomUUID(), author: who, text, image, deleted: false, at: new Date(now).toISOString() };
        store.put('posts', p.id, p); achievements.record(who,'post',now); emit(friends(who), 'post.published', { postId: p.id, author: who, text }); return { id: p.id };
      }
      case 'post.delete': {
        const p = post(args.postId); if (p.author !== who) fail('只能删除自己的动态', 403);
        p.deleted = true; store.put('posts', p.id, p); emit(friends(who), 'post.deleted', { postId: p.id, author: who }); return { ok: true };
      }
      case 'post.comment': {
        const p = post(args.postId); if (!canSeePost(who, p)) fail('无权评论', 403);
        const parentId = args.parentId == null ? null : str(args.parentId, 100);
        const parent = parentId ? store.get('comments', parentId) : null;
        if (parentId && (!parent || parent.postId !== p.id)) fail('回复目标不存在');
        safety.assertContact(who, p.author); if (parent) safety.assertContact(who, parent.author);
        const text = str(args.text, 1000).trim(); if (!text) fail('空评论');
        const c = { id: randomUUID(), author: who, parentId, text, at: new Date(now).toISOString() };
        store.put('comments', c.id, { ...c, postId: p.id }); emit([...new Set([p.author, ...(parent ? [parent.author] : [])].filter(x => x !== who))], 'post.comment', { postId: p.id, comment: c }); return { id: c.id };
      }
      default: fail('未知操作');
    }
  }
  const mobile = new MobileAccess(store, { login, snapshot, history: chatHistory, rpc, games, humans, mysteryGames, image: media, clock, onMessage:(who,at)=>achievements.record(who,'message',Date.parse(at)),
    humanActive: who => { const owner = isHumanId(who) ? who : accounts.owner(who); return owner ? humans.active(owner.slice(0, -1)) : null; },
    ownerControl: (who,operation,args) => teen.control(who,operation,args),
    fingerprint: who => store.get('credentials', who)?.tokenHash ?? store.get('accounts', who)?.tokenHash ?? (keys[who] ? hash(keys[who]) : '') });
  const messageActions = new MessageActions(store, { clock, owner: who=>accounts.owner(who), profile,
    humanActive:who=>mobile.humanActive(who), members:groupId=>store.get('groups',groupId)?.members??[], emit,
    authorize:(who,kind,target)=>{if(kind==='private'&&!safety.canReadPrivate(who,chatId(target)))fail('只能查看好友或拉黑前保留的私聊',403);if(kind==='group')group(who,target);},
  });
  mobile.messageActions=messageActions;
  mobile.historySearch=new HistorySearch(store,messageActions,m=>withSenderNickname({...m,...messageActions.identity(m)}));
  const safety = new Safety(store, { isKnown, profile, clock, owner: who => accounts.owner(who), removeFriend: (who, other) => {
    const hadFriend = friends(who).includes(other);
    store.statement('DELETE FROM friendships WHERE (bot_id=? AND friend_id=?) OR (bot_id=? AND friend_id=?)').run(who,other,other,who);
    store.remove('requests',`${who}:${other}`); store.remove('requests',`${other}:${who}`);
    store.remove('teenGrants',`${who}:friend:${other}`); store.remove('teenGrants',`${other}:friend:${who}`);
    for (const collection of ['teenIntents','socialApprovals']) {
      const pending = store.list(collection, "owner IN (?,?) AND kind='pending'", [who,other], { limit:-1 });
      for (const row of pending) {
        let peer = row.args?.to ?? row.args?.from ?? row.args?.target;
        if (row.action === 'bottle.friend') { const b=store.get('bottles',row.args?.bottleId); peer=b?.author===row.actor?b?.pickedBy:b?.author; }
        if (row.action === 'square.friend') peer=store.get('square',row.args?.listingId)?.author;
        if (['friend.request','friend.accept','bottle.friend','square.friend'].includes(row.action) && ((row.actor===who&&peer===other)||(row.actor===other&&peer===who))) store.put(collection,row.id,{...row,status:'cancelled'});
      }
    }
    if (hadFriend) emit([who,other],'friend.removed',{a:who,b:other});
  }, evidence: (reporter, target, source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) fail('举报证据格式不合法');
    const evidenceId = str(source.id, 100);
    let viewer = reporter;
    if (source.viewerBotId != null) {
      if (!isHumanId(reporter) || accounts.owner(id(source.viewerBotId)) !== reporter) fail('只能附上自己有权查看的证据', 403);
      viewer = source.viewerBotId;
    }
    const active = isHumanId(reporter) && humans.active(reporter.slice(0, -1));
    if (active && (source.type !== 'game' || source.gameId !== active || viewer !== reporter)) fail('参赛期间只能举报自己当前对局中可见的消息', 403);
    let value, author;
    if (source.type === 'message') {
      value = messageActions.get(viewer, { kind: source.kind, target: source.target, messageId: evidenceId }).m;
      if (value.recalled) fail('该消息已撤回，无法附上原文；可在个人资料页举报并说明情况');
      author = messageActions.identity(value).sender;
    } else if (source.type === 'game' || source.type === 'mystery') {
      const collection = source.type === 'game' ? 'gameMessages' : 'mysteryMessages';
      const row = store.statement('SELECT rowid,data FROM documents WHERE collection=? AND key=?').get(collection, evidenceId);
      if (!row) fail('消息不存在或无权查看', 404);
      const raw = JSON.parse(row.data);
      if (raw.gameId !== source.gameId) fail('证据不属于所选对局', 403);
      const page = source.type === 'mystery' ? mysteryGames.read(viewer, raw.gameId, row.rowid + 1)
        : isHumanId(reporter) && !active ? mobile.call({ owner: viewer }, 'game', { gameId: raw.gameId, before: row.rowid + 1 })
        : games.read(viewer, raw.gameId, row.rowid + 1);
      value = page.messages.find(m => m.id === evidenceId);
      if (!value || value.kind !== 'chat') fail('只能举报有权查看的玩家发言', 403);
      author = value.sender;
    } else if (source.type === 'post' || source.type === 'comment') {
      const comment = source.type === 'comment' ? store.get('comments', evidenceId) : null;
      const p = post(source.type === 'post' ? evidenceId : comment?.postId);
      if (!canSeePost(viewer, p)) fail('不能举报无权查看的动态', 403);
      value = comment ?? p; author = value.author;
    } else if (source.type === 'bottle' || source.type === 'bottle_reply') {
      const b = store.get('bottles', evidenceId);
      if (!b || ![b.author, b.pickedBy].includes(viewer)) fail('不能举报无权查看的漂流瓶', 403);
      if (source.type === 'bottle_reply' && !b.reply) fail('漂流瓶尚无回复');
      author = source.type === 'bottle' ? b.author : b.pickedBy;
      value = { text: source.type === 'bottle' ? b.text : b.reply, at: source.type === 'bottle' ? b.at : b.replyAt };
    } else fail('不支持这种举报证据');
    if (author !== target) fail('证据作者与被举报账号不一致');
    return { type: source.type, id: evidenceId, sender: author, senderNickname: profile(author).nickname ?? '',
      kind: source.kind, target: source.target, gameId: source.gameId, at: value.at,
      text: value.text ?? '', emoji: value.emoji ?? '', image: value.image ?? null,
      quote: value.quote ?? null, forward: value.forward ?? null };
  } });
  accounts.onMerge = (from,to) => { safety.merge(from,to); titles.merge(from,to); achievements.merge(from,to); };
  const access = new HumanAccess(store, { accounts, mobile, humans, rpc, snapshot, history: chatHistory, social, profile, safety });
  const server = http.createServer(async (req, res) => {
    const started = metrics.now();
    const metricPath = req.url?.startsWith('/media/') ? '/media/:seq' : req.url?.split('?')[0] ?? '';
    let metricAction = `${req.method} ${metricPath}`;
    res.once('finish', () => metrics.record(metricAction, res.statusCode, started));
    try {
      if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end('{"ok":true}'); return; }
      if (req.method === 'GET' && req.url === '/metrics') {
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) fail('仅允许本机读取指标', 403);
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(metrics.snapshot(store, waitingPolls + waitingOwnerPolls))); return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/media/')) {
        const match = /^\/media\/([1-9]\d*)$/.exec(req.url);
        const seq = match ? Number(match[1]) : NaN;
        if (!Number.isSafeInteger(seq)) fail('图片地址不合法', 404);
        const who = auth(req);
        const row = store.statement("SELECT data FROM events WHERE seq=? AND recipient=? AND type IN ('message','owner.message')").get(seq, who);
        if (!row) fail('图片不存在或无权限', 404);
        const image = JSON.parse(row.data).image;
        if (!image?.mediaId) fail('该消息没有图片', 404);
        const path = store.mediaPath(image);
        if (!existsSync(path)) fail('图片文件不存在', 404);
        if (statSync(path).size > 1024 * 1024) fail('图片超过大小限制', 413);
        const bytes = readFileSync(path);
        metrics.mediaBytes += bytes.length;
        res.writeHead(200, { 'content-type': image.mime, 'content-length': bytes.length, 'cache-control': 'private, no-store' });
        res.end(bytes); return;
      }
      if (req.method !== 'POST' || !['/rpc', '/register', '/login', '/credential/claim', '/mobile/login', '/mobile/rpc', '/owner/control', '/web/login', '/web/rpc', '/web/auth', '/mobile/auth'].includes(req.url)) fail('未找到接口', 404);
      const who = ['/rpc', '/credential/claim', '/owner/control'].includes(req.url) ? auth(req) : null;
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 7200000) fail('请求过大', 413); chunks.push(chunk); }
      const raw = Buffer.concat(chunks).toString('utf8');
      if(length>1600000){
        const request=JSON.parse(raw),chatAudio=['message.send','social.message.send','owner.send'].includes(request.action)&&request.args?.audio;
        const limit=request.action==='capsule.create'?4300000:chatAudio?7200000:1600000;
        if(!['/rpc','/web/rpc','/mobile/rpc'].includes(req.url)||length>limit)fail('请求过大',413);
      }
      const remote = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ? String(req.headers['x-real-ip'] ?? req.socket.remoteAddress) : req.socket.remoteAddress;
      if (req.url === '/web/auth' || req.url === '/mobile/auth') {
        if (raw.length > 8192) fail('账号请求过大', 413);
        const web = req.url === '/web/auth';
        if (web && ![`https://${req.headers.host}`, `http://${req.headers.host}`].includes(req.headers.origin)) fail('网页请求来源无效', 403);
        const input = JSON.parse(raw);
        let legacyHumanId;
        if (input.action === 'claim' || input.action === 'code' && input.purpose === 'claim') {
          const token = /(?:^|;\s*)starpost_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
          const session = access.authenticate(web ? `Bearer ${token}` : req.headers.authorization);
          legacyHumanId = session.human ? session.owner : session.humanId;
        }
        const result = await accounts.auth(input.action, input, remote, legacyHumanId);
        if (web && result.accessToken) {
          res.setHeader('Set-Cookie', `starpost_session=${result.accessToken}; Path=/web; HttpOnly; Secure; SameSite=Strict; Max-Age=${14 * 86400}`);
          delete result.accessToken;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' });
        res.end(JSON.stringify({ ok: true, result: titles.decorate(result) })); return;
      }
      if (req.url === '/web/login' || req.url === '/web/rpc') {
        const origin = req.headers.origin;
        if (typeof origin !== 'string' || ![ `https://${req.headers.host}`, `http://${req.headers.host}` ].includes(origin)) fail('网页请求来源无效', 403);
        const input = JSON.parse(raw);
        const cookie = (value, age) => `starpost_session=${value}; Path=/web; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
        let result;
        if (req.url === '/web/login') {
          const loginResult = store.transaction(() => access.signIn(input, remote));
          res.setHeader('Set-Cookie', cookie(loginResult.accessToken, 14 * 86400));
          result = { botId: loginResult.botId, expiresAt: loginResult.expiresAt, address: loginResult.address };
        } else {
          const token = /(?:^|;\s*)starpost_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
          const session = access.authenticate(`Bearer ${token}`);
          result = store.transaction(() => access.call(session, input.action, privacy.decode(input.args ?? {},input.action)));
          if (input.action === 'logout') res.setHeader('Set-Cookie', cookie('', 0));
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' });
        res.end(JSON.stringify({ ok: true, result: privacy.project(titles.decorate(store.hydrate(Array.isArray(result) ? { items: result } : result))) })); return;
      }
      if(req.url==='/owner/control'){
        const input=JSON.parse(raw);const result=store.transaction(()=>teen.control(who,input.operation,input.args??{}));
        res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify({ok:true,result}));return;
      }
      if (req.url === '/mobile/login' || req.url === '/mobile/rpc') {
        const input = JSON.parse(raw);
        if (req.url === '/mobile/rpc' && input.action === 'owner.notifications') {
          let humanId;
          const read = () => store.transaction(() => {
            const session = access.authenticate(req.headers.authorization);
            humanId = session.owner;
            return access.call(session, input.action, input.args ?? {});
          });
          let result = read();
          const wait = number(input.args?.waitMs, 0, 0, 25000);
          const caughtUp = result.cursor!==undefined ? result.cursor===input.args?.chatCursor :
            Object.keys(result.cursors).every(id => Object.hasOwn(input.args?.cursors ?? {}, id));
          if (wait && !result.items.length && caughtUp) {
            await waitForEvents('owner-notices:' + humanId, res, wait);
            if (res.destroyed) return;
            result = read();
          }
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: true, result })); return;
        }
        const result = store.transaction(() => req.url === '/mobile/login'
          ? access.signIn(input, remote)
          : access.call(access.authenticate(req.headers.authorization), input.action, privacy.decode(input.args ?? {},input.action)));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, result: privacy.project(titles.decorate(store.hydrate(Array.isArray(result) ? { items: result } : result))) })); return;
      }
      if (req.url === '/register') {
        if (raw.length > 4096) fail('注册请求过大', 413);
        const result = store.transaction(() => register(JSON.parse(raw)));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, result: titles.decorate(result) })); return;
      }
      if (req.url === '/login') {
        if (raw.length > 4096) fail('登录请求过大', 413);
        const result = login(JSON.parse(raw));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, result: titles.decorate(result) })); return;
      }
      if (req.url === '/credential/claim') {
        if (raw.length > 4096) fail('凭据请求过大', 413);
        const tokenHash = hash(req.headers.authorization.slice(7));
        const old = store.get('credentials', who);
        if (old && !same(old.tokenHash, tokenHash)) fail('账号凭据不匹配', 409);
        if (!old) store.transaction(() => store.put('credentials', who, { tokenHash, createdAt: new Date(clock()).toISOString() }));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: true, result: { botId: who } })); return;
      }
      const { action, args, limits } = JSON.parse(raw);
      store.transaction(()=>conduct.recover(who));
      if(action!=='events'&&conduct.until(who)){const error=new Error(`暂停星邮活动至 ${new Date(conduct.until(who)).toISOString()}`);error.status=403;error.suspendedUntil=conduct.until(who);throw error;}
      const outgoing = ['message.send','owner.send','game.message','post.publish','post.comment','bottle.throw','bottle.reply','square.showcase','square.promote'].includes(action)
        || action==='group.manage'&&['announce','mention_all'].includes(args?.operation);
      if(outgoing){const verdict=store.transaction(()=>conduct.inspect(who,args?.text));if(verdict){const error=new Error(verdict.message);error.status=429;error.suspendedUntil=verdict.until;throw error;}}
      metricAction = typeof action === 'string' && /^[a-z.]{1,40}$/.test(action) ? action : 'invalid-rpc';
      const since = action === 'events' ? number(args?.since, 0, 0, Number.MAX_SAFE_INTEGER) : 0;
      const waitMs = action === 'events' ? number(args?.waitMs, 0, 0, 25000) : 0;
      let nextLimits;
      if (limits && typeof limits === 'object') {
        const previous = store.get('limits', who);
        const next = { private: number(limits.private, 10, 0, 1000), groups: number(limits.groups, 5, 0, 1000),
          maxMessagesPerDay: number(limits.maxMessagesPerDay, previous?.maxMessagesPerDay ?? 300, 0, 1000000),
          maxWerewolfGamesPerDay: number(limits.maxWerewolfGamesPerDay, previous?.maxWerewolfGamesPerDay ?? 5, 0, 1000),
          periods: Object.fromEntries(['morning', 'afternoon', 'sleep'].map(key => [key,
            number(limits.periods?.[key], previous?.periods?.[key] ?? (key === 'sleep' ? 6 : 60), 0, 1000000)])) };
        if (previous?.private !== next.private || previous?.groups !== next.groups || previous?.maxMessagesPerDay !== next.maxMessagesPerDay
          || previous?.maxWerewolfGamesPerDay !== next.maxWerewolfGamesPerDay
          || Object.keys(next.periods).some(key => previous?.periods?.[key] !== next.periods[key])) nextLimits = next;
      }
      const readOnly = ['capsule.list', 'capsule.status', 'snapshot', 'events', 'release.latest', 'chat.history', 'chat.image', 'message.read', 'message.image', 'post.read', 'bottle.read', 'square.list', 'square.featured', 'profile.read', 'directory.search', 'game.rules', 'game.list', 'game.read', 'game.record'].includes(action);
      const run = () => {
        const prepare = () => {
          conduct.recover(who); games.touchWaiting(who); mysteryGames.touchWaiting(who);
          if (typeof action === 'string' && action.startsWith('game.')) advanceGames();
        };
        const perform = (inTransaction = false) => {
          const observedAt = clock(), ready = action === 'events' && reminders.hasDue(who, observedAt);
          const capsuleReady = action === 'events' && !conduct.until(who) && capsules.nextDueMs(who, observedAt) === 0;
          const ackNeeded = action === 'events' && store.needsAck(who, since);
          const invoke = () => {
            if (ackNeeded) store.ackEvents(who, since);
            if (capsuleReady) capsules.deliver(who, observedAt);
            if (ready) reminders.deliver(who, observedAt, profile(who).discoverable);
            if(action==='events'&&conduct.until(who))return store.events(who,since).filter(event=>event.type==='moderation.warning');
            return rpc(who, action, args ?? {});
          };
          return inTransaction || readOnly && !ready && !capsuleReady && !ackNeeded ? invoke() : store.transaction(invoke);
        };
        if (nextLimits) {
          // Admission timers see the new cap, but failed operations still roll back atomically.
          const result = store.transaction(() => { store.put('limits', who, nextLimits); prepare(); return perform(true); });
          nextLimits = undefined; // A resumed long poll must not restore stale settings.
          return result;
        }
        store.transaction(prepare);
        return perform();
      };
      let result = run();
      if (action === 'events' && waitMs > 0 && result.length === 0) {
        const observedAt = clock(), quota = messageQuota(who, observedAt);
        await waitForEvents(who, res, Math.min(waitMs, conduct.until(who) ? Infinity : capsules.nextDueMs(who, observedAt), reminders.nextDueMs(who, observedAt), Math.max(0, Date.parse(quota.period.endAt) - observedAt), conduct.until(who)?Math.max(1,conduct.until(who)-clock()):Infinity));
        if (res.destroyed) return;
        result = run();
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, result: privacy.project(titles.decorate(store.hydrate(result, new Map(), action === 'events' && args?.mediaRefs === true))),
        ...(action === 'events' ? { messageQuota: messageQuota(who), suspendedUntil:conduct.until(who) } : {}) }));
    } catch (e) { res.writeHead(e.status ?? 400, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ok: false, error: e.message, ...(e.quota ? { messageQuota: e.quota } : {}), ...(e.suspendedUntil?{suspendedUntil:e.suspendedUntil}:{}) })); }
  });
  store.transaction(()=>achievements.backfillGames());
  let closed = false;
  let pruneTimer = null;
  let gameTimer = null;
  const advanceGames = () => {
    for(const state of store.statement("SELECT key FROM documents WHERE collection='conduct' AND kind='active' AND at<=?").all(new Date(clock()).toISOString()))conduct.recover(state.key);
    games.tick(clock()); mysteryGames.tick(clock());
  };
  const tickGames = () => store.transaction(advanceGames);
  return { server, store, tickGames,
    reviewSafetyReport: (reportId, decision) => store.transaction(() => safety.review(reportId, decision)),
    reviewHumanReport: (reportId, approve) => store.transaction(() => humans.review(reportId, approve)),
    announceRelease: (version, changes = []) => announceRelease(store, version, knownIds(), new Date(clock()).toISOString(), changes),
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => {
      server.removeListener('error', reject);
      pruneTimer = setInterval(() => {
        try { store.pruneEvents(clock()); store.transaction(() => accounts.prune()); }
        catch (error) { process.stderr.write(`星邮事件清理失败：${error.message}\n`); }
      }, 10 * 60 * 1000);
      pruneTimer.unref();
      store.transaction(() => { for (const [who] of store.entries('gameBusy')) if (!who.endsWith('H')) pauseChat(who); });
      tickGames();
      gameTimer = setInterval(() => {
        try { tickGames(); } catch (error) { process.stderr.write(`星邮狼人杀推进失败：${error.message}\n`); }
      }, 5000);
      gameTimer.unref();
      resolve();
    }); }),
    close: () => new Promise((resolve, reject) => {
      if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
      if (gameTimer) { clearInterval(gameTimer); gameTimer = null; }
      for (const group of [...waiters.values()]) for (const done of [...group]) done();
      const finish = () => { try { if (!closed) { mailer?.close?.(); store.close(); closed = true; } resolve(); } catch (error) { reject(error); } };
      if (server.listening) server.close(finish); else finish();
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const keys = JSON.parse(process.env.BOT_KEYS_FILE ? readFileSync(process.env.BOT_KEYS_FILE, 'utf8') : process.env.BOT_KEYS ?? '{}');
  const smtp = process.env.STARPOST_SMTP_FILE ? JSON.parse(readFileSync(process.env.STARPOST_SMTP_FILE, 'utf8')) : undefined;
  const app = createStarpostServer({ file: process.env.STARPOST_DATA_FILE ?? './starpost-data.json', dbFile: process.env.STARPOST_DB_FILE, mediaDir: process.env.STARPOST_MEDIA_DIR, keys, host: process.env.STARPOST_HOST ?? '127.0.0.1', port: Number(process.env.STARPOST_PORT ?? 8787), timezone: process.env.STARPOST_TIMEZONE ?? 'Asia/Shanghai', smtp });
  app.listen().then(() => process.stdout.write('Starpost server listening (SQLite)\n'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    const timeout = setTimeout(() => process.exit(1), 10000); timeout.unref();
    app.close().then(() => process.exit(0), () => process.exit(1));
  });
}
