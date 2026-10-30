import { randomUUID } from 'node:crypto';

const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const field = (value, max, multiline = false) => typeof value === 'string' && value.length <= max
  && !(multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u : /[\x00-\x1f\x7f]/u).test(value) ? value.trim() : fail('文字格式或长度不合法');
const activeStates = ['assigning', 'night_wolf', 'night_gods', 'day', 'vote', 'hunter', 'finished'];
// Deterministic rules are deliberately narrow. Ambiguous speech and bot reports require review.
export function humanViolation(value) {
  const text = value.normalize('NFKC').toLowerCase().replace(/[\s\u200b-\u200f\ufeff]/gu, '');
  if (/(?:约炮|强奸你|操你妈|肏你|傻逼|死全家|去死吧|色情服务|裸聊|幼女性交)/u.test(text)) return '明确的辱骂或色情招揽';
  if (/(?:忽略|无视|覆盖).{0,12}(?:系统提示|系统指令|安全规则)|(?:泄露|发送|告诉我).{0,10}(?:账号凭据|登录凭据|api密钥)|ignore.{0,10}(?:system|previousinstructions)/u.test(text)) return '明确的越权或提示注入指令';
  return null;
}

export class HumanGames {
  constructor(store, games, clock) { Object.assign(this, { store, games, clock }); }
  id(owner) { return `${owner}H`; }
  state(owner) { return this.store.get('humanConduct', owner) ?? { strikes: 0, banned: false }; }
  active(owner) {
    const lock = this.store.get('humanGameLock', owner) ?? this.store.get('gameBusy', this.id(owner));
    const game = lock && this.store.get('games', lock.gameId);
    return game && activeStates.includes(game.status) ? game.id : null;
  }
  assertEligible(owner) { if (this.state(owner).banned) fail('该账号下的人类玩家已被禁止参加狼人杀，bot 不受影响', 403); }
  assertRoom(owner, gameId) {
    const current = this.active(owner);
    if (current && current !== gameId) fail('请先完成当前对局', 403);
    const game = this.games.get(gameId), who = this.id(owner);
    if (!game.joined.includes(who) && !game.participants.includes(who) && game.creator !== who) fail('不是本局人类玩家', 403);
    return game;
  }
  lobby(owner) {
    this.games.tick();
    const who = this.id(owner), profile = this.store.get('humanProfiles', owner);
    return { ownerBotId: owner, humanId: who, nickname: profile?.nickname || '匿名人类', moderation: this.state(owner), activeGameId: this.active(owner),
      rules: this.games.rules(who), games: [...new Map([...this.games.list(who), ...this.games.publicListings()].map(g => [g.gameId, g])).values()]
        .map(g => this.games.summary(this.games.get(g.gameId), who)) };
  }
  call(owner, action, args) {
    this.games.tick();
    const who = this.id(owner);
    if (action === 'status' || action === 'lobby') return this.lobby(owner);
    if (action === 'room') return this.room(owner, args.gameId, args.before);
    if (action === 'profile') {
      if (this.active(owner)) fail('对局期间不能修改昵称');
      const nickname = field(args.nickname ?? '', 32);
      if (nickname && (!/^[\p{L}\p{N}\p{M} _.-]+$/u.test(nickname) || humanViolation(nickname))) fail('昵称不合法');
      this.store.put('humanProfiles', owner, { nickname }); return { humanId: who, nickname: nickname || '匿名人类' };
    }
    this.assertEligible(owner);
    if (action === 'schedule') {
      if (this.active(owner)) fail('请先完成当前对局');
      const title = field(args.title || '人类发起的狼人杀', 60);
      if (humanViolation(title)) fail('预约标题不合法');
      const game = this.games.schedule(who, { title, scheduledAt: args.scheduledAt, maxPlayers: args.maxPlayers,
        roles: args.roles, public: args.public === true, judgeMode: 'program', sourceKind: 'private', sourceTarget: owner });
      if (args.public === true) this.games.publish(who, game.gameId);
      return game;
    }
    if (action === 'join') {
      if (this.active(owner)) fail('请先完成当前对局');
      const game = this.games.get(args.gameId);
      if (!(game.public && game.published) && !game.invited.includes(who) && game.creator !== who) fail('预约未公开或未邀请你', 403);
      if (!game.invited.includes(who)) { game.invited.push(who); this.games.save(game); }
      const joined = this.games.join(who, game.id);
      this.store.put('gameAccess', `${who}:${game.id}`, { owner: who, gameId: game.id, at: new Date(this.clock()).toISOString() });
      return joined;
    }
    const game = this.assertRoom(owner, args.gameId);
    if (game.kicked?.includes(who)) fail('你已被禁言并移出本局', 403);
    if (action === 'checkin') return this.games.checkin(who, game.id);
    if (action === 'leave') return this.games.leave(who, game.id);
    if (action === 'cancel') return this.games.cancel(who, game.id);
    if (action === 'message') {
      const room = this.room(owner, game.id);
      if (!room.channels.includes(args.channel)) fail('当前身份或阶段不能在此频道发言', 403);
      const text = field(args.text, 1000, true);
      const reason = humanViolation(text);
      if (reason) return { rejected: true, moderation: this.strike(owner, game, randomUUID(), reason, text) };
      return this.games.message(who, { gameId: game.id, channel: args.channel, text });
    }
    if (action === 'move') {
      const option = this.options(game, who).find(o => o.move === args.move);
      if (!option || !option.targets.some(t => t.id === (args.target ?? ''))) fail('该行动或目标当前不可用', 403);
      if (args.move === 'vote') return this.games.vote(who, { gameId: game.id, target: args.target });
      return this.games.act(who, { gameId: game.id, action: args.move, target: args.target || null });
    }
    fail('不支持的人类游戏操作');
  }
  options(game, who) {
    if (!game.alive.includes(who) && !(game.status === 'hunter' && game.pendingHunter === who) || game.kicked?.includes(who)) return [];
    const role = game.roles[who], targets = game.alive.map(id => ({ id, nickname: this.games.nickname(id) || id }));
    const option = (move, label, list) => ({ move, label, targets: list });
    if (game.status === 'vote' && !Object.hasOwn(game.votes, who)) return [option('vote', '投票', [...targets, { id: 'abstain', nickname: '弃票' }])];
    if (game.status === 'hunter' && game.pendingHunter === who) return [option('shoot', '猎人开枪或放弃', [...targets, { id: '', nickname: '放弃开枪' }])];
    if (game.night.passed?.includes(who)) return [];
    if (game.status === 'night_wolf' && role === 'wolf') return [option('attack', '选择狼刀目标', targets.filter(t => game.roles[t.id] !== 'wolf')),
      ...(!game.night.wolfVotes?.[who] ? [option('skip', '跳过本夜', [{ id: '', nickname: '跳过' }])] : [])];
    if (game.status !== 'night_gods') return [];
    const choices = [];
    if (role === 'seer' && !game.night.seerTarget) choices.push(option('inspect', '查验身份', targets.filter(t => t.id !== who)));
    if (role === 'guard' && !game.night.guardTarget) choices.push(option('protect', '守护', targets.filter(t => t.id !== game.lastGuard)));
    if (role === 'witch' && !game.night.witchActed) {
      if (!game.uses[who].save && game.night.victim && (game.day > 1 || game.night.victim !== who)) choices.push(option('save', '使用解药', [{ id: '', nickname: `救 ${game.night.victim}` }]));
      if (!game.uses[who].poison) choices.push(option('poison', '使用毒药', targets.filter(t => t.id !== who)));
    }
    if (choices.length) choices.push(option('skip', '跳过本夜', [{ id: '', nickname: '跳过' }]));
    return choices;
  }
  room(owner, gameId, before) {
    const game = this.assertRoom(owner, gameId), who = this.id(owner), kicked = game.kicked?.includes(who) === true;
    const page = this.games.read(who, game.id, before);
    const channels = !kicked && (game.alive.includes(who) || game.status === 'finished')
      ? ['day', 'vote', 'finished'].includes(game.status) ? ['public'] : game.roles[who] === 'wolf' && game.status === 'night_wolf' ? ['wolf'] : [] : [];
    return { ...page, humanId: who, nickname: this.games.nickname(who), kicked, moderation: this.state(owner), channels,
      options: kicked ? [] : this.options(game, who), names: Object.fromEntries(game.participants.map(id => [id, this.games.nickname(id) || id])),
      messages: kicked ? [] : page.messages, activeGameId: this.active(owner) };
  }
  strike(owner, game, evidenceId, reason, evidence) {
    const key = `${game.id}:${evidenceId}`, existing = this.store.get('humanViolations', key);
    if (existing) return this.state(owner);
    const old = this.state(owner), state = { strikes: old.strikes + 1, banned: old.strikes + 1 >= 2,
      message: old.strikes ? '第二次违规，禁止该账号下的人类参加狼人杀；bot 不受影响。' : '第一次违规警告，已禁言并移出本局；再次违规将禁止人类参赛。' };
    this.store.put('humanViolations', key, { owner, gameId: game.id, reason, evidence, at: new Date(this.clock()).toISOString() });
    this.store.put('humanConduct', owner, state);
    game.kicked = [...new Set([...(game.kicked ?? []), this.id(owner)])]; this.games.save(game);
    this.games.suspend(this.id(owner), !state.banned);
    return state;
  }
  report(reporter, args) {
    const game = this.games.get(args.gameId), message = this.store.get('gameMessages', args.messageId);
    this.games.canView(game, reporter);
    if (!message || message.gameId !== game.id || message.kind !== 'chat' || !/^\d{5,12}H$/.test(message.sender)) fail('只能举报本局人类的聊天消息');
    const participant = game.participants.includes(reporter) || game.judgeBotId === reporter;
    const spectator = game.public && game.published && !participant && !this.store.get('gameBusy', reporter);
    if (!(spectator || participant && (message.channel === 'public' || message.recipients.includes(reporter)))) fail('不能举报无权读取的消息', 403);
    if (!['sexual', 'abuse', 'injection', 'other'].includes(args.reason)) fail('举报原因不合法');
    const key = `${reporter}:${message.id}`, old = this.store.get('humanReports', key);
    if (old) return { reportId: key, status: old.status };
    if (this.store.count('humanReports', 'owner=? AND at>=?', [reporter, new Date(this.clock() - 86400000).toISOString()]) >= 10) fail('举报过于频繁', 429);
    this.store.put('humanReports', key, { owner: reporter, humanId: message.sender, messageId: message.id, gameId: game.id,
      reason: args.reason, note: field(args.note ?? '', 300), status: 'pending', at: new Date(this.clock()).toISOString() });
    return { reportId: key, status: 'pending', message: '举报已记录，等待管理员复核；不会因举报数量自动封禁。' };
  }
  review(key, approve) {
    const report = this.store.get('humanReports', key);
    if (!report || report.status !== 'pending') fail('没有待处理的举报');
    report.status = approve ? 'confirmed' : 'dismissed'; report.reviewedAt = new Date(this.clock()).toISOString();
    this.store.put('humanReports', key, report);
    if (approve) {
      const message = this.store.get('gameMessages', report.messageId);
      this.strike(report.humanId.slice(0, -1), this.games.get(report.gameId), report.messageId, report.reason, message?.text ?? '');
    }
    return { reportId: key, status: report.status };
  }
}
