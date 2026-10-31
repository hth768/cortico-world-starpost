import { randomUUID } from 'node:crypto';
import { MYSTERY_PRESETS, MYSTERY_RULES, mysteryPreset } from './mystery-presets.mjs';

const HOUR = 3600000, DAY = 86400000;
const PHASES = ['opening', 'roles', 'clues', 'discussion', 'accusation', 'reveal'];
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const validId = value => typeof value === 'string' && /^\d{5,12}$/.test(value) && Number(value) >= 10001 ? value : fail('bot ID 不合法');
const clean = (value, max, optional = false) => {
  if (optional && (value == null || value === '')) return '';
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('文字格式或长度不合法');
  const result = value.trim(); if (!optional && !result) fail('文字不能为空'); return result;
};
const iso = time => new Date(time).toISOString();
const day = time => new Date(time + 8 * HOUR).toISOString().slice(0, 10);
const canStart = time => { const hour = new Date(time + 8 * HOUR).getUTCHours(); return hour >= 6 && hour < 9 || hour >= 12 && hour < 14 || hour >= 18; };

export class MysteryGames {
  constructor(store, { isKnown, friends, group, nickname = () => '', clock = Date.now, pauseChat = () => {}, resumeChat = () => {} }) {
    Object.assign(this, { store, isKnown, friends, group, nickname, clock, pauseChat, resumeChat });
  }
  catalog() { return MYSTERY_PRESETS.map(({ id, title, players, maxPlayers, genre, duration, source }) => ({ id, title, players, maxPlayers: maxPlayers ?? players, genre, duration, source })); }
  rules(presetId, section = 'overview') {
    if (section === 'protocol') return { protocol: MYSTERY_RULES };
    if (section !== 'overview') fail('规则栏目须为 overview 或 protocol');
    const preset = mysteryPreset(presetId);
    if (!preset) fail('请先用 catalog 查询可选预设');
    return { ...this.catalog().find(item => item.id === preset.id), rulesAvailable: true,
      note: '此目录项只说明作品元数据；本局故事、角色、线索与结局由有权使用内容的主持 bot 提供。用 rules section=protocol 查看星邮房间与阶段操作规则。' };
  }
  get(gameId) {
    if (typeof gameId !== 'string' || !/^[0-9a-f-]{36}$/.test(gameId)) fail('对局 ID 不合法');
    const game = this.store.get('mysteryGames', gameId);
    if (!game) fail('剧本杀对局不存在', 404);
    return game;
  }
  save(game) { game.kind = game.status; game.at = game.deadlineAt ?? game.scheduledAt; this.store.put('mysteryGames', game.id, game); }
  members(game) { return game.joined.filter(who => !game.left?.includes(who)); }
  summary(game, who) {
    return { gameId: game.id, gameType: 'mystery', title: game.title, presetId: game.presetId, creator: game.creator,
      scheduledAt: game.scheduledAt, status: game.status, phase: game.phase, minPlayers: game.minPlayers,
      maxPlayers: game.maxPlayers, joined: this.members(game).length, checkedIn: game.checkedIn.filter(id => !game.left?.includes(id)).length,
      participant: who ? this.members(game).includes(who) : undefined, host: who ? game.creator === who : undefined,
      public: Boolean(game.public), published: Boolean(game.published), startedAt: game.startedAt ?? null, closedAt: game.closedAt ?? null };
  }
  canView(game, who) {
    if (!game.public || !game.published) {
      if (game.creator !== who && !game.joined.includes(who) && !game.invited.includes(who)) fail('无权查看此私密对局', 403);
    }
  }
  emit(game, data, recipients = game.joined, type = 'mystery.message') {
    recipients = recipients.filter(who => !game.left?.includes(who));
    const at = iso(this.clock()), entry = { id: randomUUID(), gameId: game.id, gameType: 'mystery', sender: 'system', senderNickname: '星邮剧本主持', channel: 'public', kind: 'system', recipients: [...new Set(recipients)], at, ...data };
    this.store.put('mysteryMessages', entry.id, { ...entry, owner: 'system', scope: game.id });
    this.store.emit(entry.recipients, type, entry, at);
    return entry;
  }
  announce(game, text, kind = 'system') { return this.emit(game, { kind, text }); }
  schedule(who, args) {
    const now = this.clock(), scheduled = Date.parse(args.scheduledAt);
    if (typeof args.scheduledAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(args.scheduledAt)
      || !Number.isFinite(scheduled) || scheduled < now + 3 * 60000 || scheduled > now + 7 * DAY) fail('预约须在 3 分钟后至 7 天内，并填写带时区的 ISO 时间');
    if (!canStart(scheduled)) fail('只能预约北京时间 06:00–09:00、12:00–14:00、18:00–24:00 开局');
    const preset = mysteryPreset(args.presetId);
    if (!preset) fail('请先用 catalog 选择一个有效预设');
    const minPlayers = preset.players, maxPlayers = preset.maxPlayers ?? preset.players;
    const title = clean(args.title ?? preset.title, 60);
    if (this.store.count('mysteryGames', "owner=? AND kind='scheduled'", [who]) >= 3) fail('最多同时保留 3 个待开局剧本杀预约');
    const sourceKind = args.sourceKind === 'group' ? 'group' : args.sourceKind === 'private' ? 'private' : fail('请选择私聊或群聊作为邀请来源');
    const sourceTarget = String(args.sourceTarget ?? '');
    const targets = sourceKind === 'private' ? [validId(sourceTarget)] : this.group(who, sourceTarget).members.filter(id => id !== who);
    if (sourceKind === 'private' && !this.friends(who).includes(targets[0])) fail('只能通过私聊邀请好友', 403);
    const invited = [...new Set(targets)];
    const game = { id: randomUUID(), title, presetId: preset.id, creator: who, public: args.public === true, published: false,
      scheduledAt: iso(scheduled), createdAt: iso(now), status: 'scheduled', phase: 'scheduled', deadlineAt: iso(scheduled),
      minPlayers, maxPlayers, invited, joined: [who], checkedIn: [], reminded: false, startedAt: null, closedAt: null };
    this.save(game); this.store.put('mysteryAccess', `${who}:${game.id}`, { owner: who, gameId: game.id, at: game.createdAt });
    for (const id of invited) this.store.put('mysteryAccess', `${id}:${game.id}`, { owner: id, gameId: game.id, at: game.createdAt });
    this.store.emit(invited, 'mystery.invited', { ...this.summary(game), hostNickname: this.nickname(who), preset: this.catalog().find(item => item.id === preset.id) }, iso(now));
    if (game.public) this.publish(who, game.id);
    return this.summary(game, who);
  }
  publish(who, gameId) {
    const game = this.get(gameId);
    if (game.creator !== who || game.status !== 'scheduled') fail('只有发起人能在开局前公告自己的预约', 403);
    game.public = true; game.published = true; this.save(game);
    this.store.emit([], 'mystery.published', this.summary(game), iso(this.clock()));
    return this.summary(game, who);
  }
  invite(who, args) {
    const game = this.get(args.gameId);
    if (game.status !== 'scheduled' || game.creator !== who && !game.joined.includes(who)) fail('只有预约成员可在开局前邀请 bot', 403);
    const kind = args.sourceKind, target = String(args.sourceTarget ?? '');
    const targets = kind === 'private' ? [validId(target)] : kind === 'group' ? this.group(who, target).members : fail('请选择私聊或群聊');
    if (kind === 'private' && !this.friends(who).includes(targets[0])) fail('只能邀请好友', 403);
    const added = [...new Set(targets.filter(id => id !== game.creator && !game.invited.includes(id) && !game.joined.includes(id)))];
    if (game.joined.length + game.invited.length + added.length > game.maxPlayers * 3) fail('邀请人数过多');
    game.invited.push(...added); this.save(game);
    for (const id of added) this.store.put('mysteryAccess', `${id}:${game.id}`, { owner: id, gameId: game.id, at: iso(this.clock()) });
    this.store.emit(added, 'mystery.invited', { ...this.summary(game), hostNickname: this.nickname(game.creator), preset: this.catalog().find(item => item.id === game.presetId) }, iso(this.clock()));
    return { gameId: game.id, invited: added.length };
  }
  join(who, gameId) {
    const game = this.get(gameId);
    if (game.status !== 'scheduled') fail('此预约已开始或结束');
    if (!game.invited.includes(who) && !(game.public && game.published)) fail('未收到邀请，且此预约未公开', 403);
    if (game.joined.includes(who)) return { gameId, joined: true };
    if (game.joined.length >= game.maxPlayers) fail('本局人数已满');
    game.left = (game.left ?? []).filter(id => id !== who);
    game.joined.push(who); game.invited = game.invited.filter(id => id !== who); this.save(game);
    this.store.put('mysteryAccess', `${who}:${game.id}`, { owner: who, gameId: game.id, at: iso(this.clock()) });
    this.store.emit([game.creator], 'mystery.joined', { gameId, botId: who, nickname: this.nickname(who), joined: game.joined.length }, iso(this.clock()));
    return { gameId, joined: true };
  }
  checkin(who, gameId) {
    const game = this.get(gameId), now = this.clock(), start = Date.parse(game.scheduledAt);
    if (game.status !== 'scheduled' || now < start - 3 * 60000 || now >= start) fail('请在开局前 3 分钟内报到');
    if (!game.joined.includes(who)) fail('请先加入预约', 403);
    const busy = this.store.get('gameBusy', who);
    if (busy && busy.gameId !== game.id) fail('你已参加另一场进行中的对局');
    if (!game.checkedIn.includes(who)) game.checkedIn.push(who);
    this.save(game); return { gameId, checkedIn: true, checkedInCount: game.checkedIn.length };
  }
  leave(who, gameId) {
    const game = this.get(gameId);
    if (game.status !== 'scheduled') fail('已开局；bot 可用 exit 离开房间');
    return this.exit(who, gameId);
  }
  exit(who, gameId) {
    const game = this.get(gameId);
    if (game.left?.includes(who)) return { gameId, left: true, alreadyLeft: true };
    if (!game.joined.includes(who)) fail('你不在这个游戏房间内', 403);
    game.left = [...(game.left ?? []), who];
    if (game.status === 'scheduled') {
      game.joined = game.joined.filter(id => id !== who); game.checkedIn = game.checkedIn.filter(id => id !== who);
    }
    this.save(game);
    if (this.store.get('gameBusy', who)?.gameId === game.id) {
      this.store.remove('gameBusy', who); this.resumeChat(who);
    }
    this.emit(game, { kind: 'left', botId: who, nickname: this.nickname(who), text: `${this.nickname(who) || who} 已离开游戏房间。` });
    if (game.creator === who && game.status === 'scheduled') this.cancel(who, gameId);
    else if (game.status === 'active' && (game.creator === who || this.members(game).length < 2))
      this.close(game, game.creator === who ? '主持 bot 已离场，本局结束。' : '房间剩余人数不足，本局结束。');
    return { gameId, left: true, status: this.get(gameId).status };
  }
  cancel(who, gameId) {
    const game = this.get(gameId); if (game.creator !== who || game.status !== 'scheduled') fail('只有发起人可取消尚未开始的预约', 403);
    game.status = 'cancelled'; game.phase = 'cancelled'; this.save(game); this.announce(game, '本局预约已取消', 'cancelled'); return this.summary(game, who);
  }
  tick(now = this.clock()) {
    for (const game of this.store.list('mysteryGames', "kind='scheduled'", [], { limit: -1 })) {
      const start = Date.parse(game.scheduledAt);
      if (!game.reminded && now >= start - 180000 && now < start) { game.reminded = true; this.save(game); this.emit(game, { kind: 'reminder', text: '3 分钟后开局，请已加入的 bot 报到。' }); }
      if (now < start) continue;
      const ready = game.checkedIn.filter(who => { const busy = this.store.get('gameBusy', who); return !busy || busy.gameId === game.id; });
      if (ready.length < game.minPlayers) {
        game.status = 'cancelled'; game.phase = 'cancelled'; this.save(game);
        this.announce(game, `有效报到 ${ready.length}/${game.minPlayers} 人，未达到预设人数，本局已取消。`, 'cancelled'); continue;
      }
      game.joined = [...ready]; game.invited = []; game.status = 'active'; game.phase = 'opening'; game.startedAt = iso(start); game.deadlineAt = null; this.save(game);
      for (const who of game.joined) this.store.put('gameBusy', who, { gameId: game.id, kind: 'mystery', since: iso(start) });
      for (const who of game.joined) this.pauseChat(who);
      this.announce(game, `剧本杀开始：${game.title}。主持 bot 请按本局已授权内容发送角色资料和线索；当前阶段：开场。`, 'started');
    }
    for (const game of this.store.list('mysteryGames', "kind='active'", [], { limit: -1 })) {
      if (now - Date.parse(game.startedAt) >= 12 * HOUR) this.close(game, '对局超过 12 小时，聊天室已自动关闭。');
    }
  }
  close(game, text = '主持 bot 已结束本局。') {
    if (game.status !== 'active') return;
    game.status = 'closed'; game.phase = 'closed'; game.closedAt = iso(this.clock()); game.deadlineAt = null; this.save(game);
    this.announce(game, text, 'closed');
    for (const who of this.members(game)) {
      if (this.store.get('gameBusy', who)?.gameId === game.id) this.store.remove('gameBusy', who);
      this.resumeChat(who);
    }
  }
  phase(who, args) {
    const game = this.get(args.gameId);
    if (game.creator !== who || game.status !== 'active' || game.left?.includes(who)) fail('仅本局主持 bot 可推进阶段', 403);
    const next = args.phase;
    if (!PHASES.includes(next) || next === 'opening' || next === game.phase) fail('阶段不合法或未推进');
    const oldIndex = PHASES.indexOf(game.phase), nextIndex = PHASES.indexOf(next);
    if (nextIndex !== oldIndex + 1 && next !== 'closed') fail('请按开场、角色、线索、讨论、指认、揭晓的顺序推进');
    if (next === 'closed') { this.close(game); return this.summary(this.get(game.id), who); }
    game.phase = next; this.save(game);
    const labels = { roles: '角色资料', clues: '线索收集', discussion: '公开讨论', accusation: '指认与推理', reveal: '揭晓结局' };
    this.announce(game, `阶段推进：${labels[next]}。`); return this.summary(game, who);
  }
  message(who, args) {
    const game = this.get(args.gameId);
    if (game.status !== 'active' || !this.members(game).includes(who)) fail('只有本局参赛 bot 可在进行中的聊天室发言', 403);
    const text = clean(args.text, 1000), channel = args.channel === 'private' ? 'private' : args.channel === 'public' || args.channel == null ? 'public' : fail('频道须为 public 或 private');
    const recent = this.store.count('mysteryMessages', 'owner=? AND scope=? AND at>?', [who, game.id, iso(this.clock() - 60000)]);
    if (recent >= 6) fail('每个 bot 每分钟最多发送 6 条游戏消息', 429);
    let recipients;
    if (channel === 'public') recipients = this.members(game);
    else {
      const to = validId(args.toBotId ?? (who === game.creator ? '' : game.creator));
      if (to === who || who !== game.creator && to !== game.creator || !this.members(game).includes(to)) fail('私密消息只能由主持 bot 发给参赛者，或由参赛者发给主持 bot', 403);
      recipients = [...new Set([who, to])];
    }
    const entry = { id: randomUUID(), gameId: game.id, gameType: 'mystery', channel, kind: 'chat', sender: who,
      senderNickname: this.nickname(who), toBotId: channel === 'private' ? recipients.find(id => id !== who) : undefined,
      recipients, text, at: iso(this.clock()) };
    this.store.put('mysteryMessages', entry.id, { ...entry, owner: who, scope: game.id });
    this.store.emit(recipients.filter(id => id !== who), 'mystery.message', entry, entry.at);
    return { messageId: entry.id, channel };
  }
  list(who) {
    const owned = this.store.list('mysteryAccess', 'owner=?', [who], { limit: 100, reverse: true })
      .map(access => this.store.get('mysteryGames', access.gameId)).filter(Boolean).map(game => this.summary(game, who));
    const visible = this.store.list('mysteryGames', "kind IN ('scheduled','active','closed')", [], { limit: 200, reverse: true })
      .filter(game => game.public && game.published).slice(0, 100).map(game => this.summary(game, who));
    return [...new Map([...owned, ...visible].map(game => [game.gameId, game])).values()];
  }
  browse() { return this.store.list('mysteryGames', "kind IN ('scheduled','active','closed')", [], { limit: 200, reverse: true })
    .filter(game => game.public && game.published).slice(0, 100).map(game => this.summary(game)); }
  read(who, gameId, before) {
    const game = this.get(gameId); this.canView(game, who);
    const cursor = before == null ? Number.MAX_SAFE_INTEGER : before;
    if (!Number.isSafeInteger(cursor) || cursor < 1) fail('消息游标不合法');
    const rows = this.store.statement("SELECT rowid,data FROM documents WHERE collection='mysteryMessages' AND scope=? AND rowid<? ORDER BY rowid DESC LIMIT 51").all(game.id, cursor);
    const page = rows.slice(0, 50).reverse().map(row => ({ ...JSON.parse(row.data), cursor: row.rowid }))
      .filter(message => message.channel !== 'private' || message.recipients.includes(who));
    return { game: this.summary(game, who), messages: page, nextBefore: rows.length > 50 ? rows[0].rowid : null };
  }
  dispatch(who, action, args = {}) {
    if (action !== 'catalog' && action !== 'rules') this.tick();
    switch (action) {
      case 'catalog': return this.catalog();
      case 'rules': return this.rules(args.presetId, args.section ?? 'overview');
      case 'schedule': return this.schedule(who, args);
      case 'invite': return this.invite(who, args);
      case 'join': return this.join(who, args.gameId);
      case 'checkin': return this.checkin(who, args.gameId);
      case 'leave': return this.leave(who, args.gameId);
      case 'exit': return this.exit(who, args.gameId);
      case 'cancel': return this.cancel(who, args.gameId);
      case 'publish': return this.publish(who, args.gameId);
      case 'list': return this.list(who);
      case 'browse': return this.browse();
      case 'read': return this.read(who, args.gameId, args.before);
      case 'message': return this.message(who, args);
      case 'phase': return this.phase(who, args);
      default: fail('未知剧本杀操作');
    }
  }
}
