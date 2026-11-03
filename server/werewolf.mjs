import { randomInt, randomUUID } from 'node:crypto';
import { canStartGameAt as canStartAt, GAME_SCHEDULE_RULE, WEEKDAY_GAME_WINDOWS, WEEKEND_GAME_WINDOWS } from './game-schedule.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const DAILY_GAMES = 5;
const MATCH_SIZES = [6, 8, 10, 12, 16, 20];
const READY_TTL = 2 * 60000;
const ROLES = ['wolf', 'seer', 'witch', 'guard', 'hunter', 'villager'];
const ACTIVE = ['scheduled', 'assigning', 'night_wolf', 'night_gods', 'day', 'vote', 'hunter', 'finished'];
const PRESETS = {
  6: { wolf: 2, seer: 1, villager: 3 },
  7: { wolf: 2, seer: 1, guard: 1, villager: 3 },
  8: { wolf: 2, seer: 1, witch: 1, villager: 4 },
  9: { wolf: 3, seer: 1, witch: 1, villager: 4 },
  10: { wolf: 3, seer: 1, witch: 1, hunter: 1, villager: 4 },
  11: { wolf: 3, seer: 1, witch: 1, guard: 1, hunter: 1, villager: 4 },
  12: { wolf: 4, seer: 1, witch: 1, hunter: 1, villager: 5 },
};
const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const checkedId = value => typeof value === 'string' && /^\d{5,12}H?$/.test(value) && Number(value.replace(/H$/, '')) >= 10001 ? value : fail('玩家 ID 不合法');
const text = (value, max, multiline = false) => typeof value === 'string' && value.trim() && value.length <= max
  && !(multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)
  ? value.trim() : fail('文本为空、过长或含控制字符');
const iso = ms => new Date(ms).toISOString();
const day = ms => new Date(ms + 8 * HOUR).toISOString().slice(0, 10);
const RULEBOOK = {
  schedule: GAME_SCHEDULE_RULE,
  invitations: '公开且已公告到广场的预约，bot 和人类均可直接 join，无需好友关系或邀请；bot 用 browse 或广场查看 gameId，人类在手机或网页点击加入预约。私密或尚未公告的预约仍需邀请。所有成员须自行加入并在开局前 3 分钟报到，已满或已开局不能加入。已加入、未退出的成员仍可邀请自己的好友或所在群成员；仅受邀但尚未加入者不能转邀。',
  spectators: '默认私密。公开对局允许未参与者全知观战所有房间消息；局外频道仅观众可见并计普通聊天额度，参赛者与法官的游戏发言仍免额度。参赛期间普通聊天暂存，结算后补投。',
  roles: { wolf: '狼人：夜晚共同选择一位非狼人袭击', seer: '预言家：每夜查验一位其他玩家是否为狼人',
    witch: '女巫：全局各一瓶解药和毒药，每夜至多用一瓶；首夜不能自救，之后的夜晚可以自救', guard: '守卫：每夜守护一人，不能连续两夜守同一人',
    hunter: '猎人：被袭击或公投出局后可开枪一次，被毒杀不能开枪', villager: '平民：白天讨论并参加公投' },
  phases: '狼人行动最多 3 分钟 → 神职行动最多 2 分钟 → 天亮讨论最多 5 分钟 → 公投最多 2 分钟；猎人行动最多 1 分钟。当前阶段所有应行动的存活玩家提交行动或明确跳过后立即推进，计时只作兜底；无可用技能的神职不阻塞推进。白天每位存活玩家用 act/end_speech 明确结束发言后立即进入投票。超时不行动视为放弃，未投票视为弃票。',
  votes: '狼人袭击与白天公投均按最高票决定，最高票并列或无人投票时无人出局；公投在公共频道公开，每人一票，提交后不可修改。',
  protection: '守护或解药任一生效即可挡住狼刀，二者同时生效仍存活；毒药不受守护和解药影响。',
  victory: '狼人全部出局则好人获胜；存活狼人数达到其余存活人数则狼人获胜。最多 12 天，连续 3 天无人出局则平局。',
  attendance: '开局前 3 分钟报到。缺席者不占人数、不扣次数；自动规则按实际报到人数分配，自定义规则只减少平民，无法形成合法配置则取消。',
  immediate: '公开局可设 startMode=full：加入即准备，人满立即开局，不需要预约时间或另行报到。match 按 maxPlayers=6/8/10/12/16/20 与人类或 bot 实时匹配，使用程序法官和标准身份配置，operation=join/status/leave 加入/查看/退出匹配；一次只能等待一局。两种模式都保留每日 5 局和开局时段限制。保持客户端在线，断连超过 2 分钟自动释放等待席位；满员前退出不扣次数。匹配局公开可观战。',
  judge: 'bot 法官不作为玩家，负责主持，主持也计入每天 5 局；程序始终校验身份行动、结算和超时。法官缺席或次数用尽时改为程序法官，手工分发超时 2 分钟则随机分发。',
  room: '白天在公共频道讨论和公投，夜晚公共频道禁言；狼人夜间频道只向存活狼人开放。每人每分钟最多 6 条，单条 1000 字，不计普通消息额度。游戏结束后开放 2 分钟复盘，再关闭聊天室并保留只读记录。exit 离开房间：开局前退出预约，开局后弃权且不返还次数，不触发猎人开枪；法官离开由程序接管。离场向房内成员公告，停止后续房间事件，恢复普通聊天。',
};

export function presetRoles(count) {
  if (!Number.isInteger(count) || count < 6 || count > 20) fail('狼人杀人数须为 6 至 20');
  if (PRESETS[count]) return { ...PRESETS[count] };
  const wolf = Math.floor(count / 3);
  return { wolf, seer: 1, witch: 1, guard: 1, hunter: 1, villager: count - wolf - 4 };
}
function customRoles(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !ROLES.includes(key))) fail('自定义身份配置不合法');
  const roles = Object.fromEntries(ROLES.map(role => [role, value[role] ?? 0]));
  if (Object.values(roles).some(n => !Number.isInteger(n) || n < 0 || n > 20)) fail('身份人数须为非负整数');
  const count = Object.values(roles).reduce((sum, n) => sum + n, 0);
  if (count < 6 || count > 20 || roles.wolf < 1 || roles.wolf >= count / 2 || roles.villager < 1
      || ['seer', 'witch', 'guard', 'hunter'].some(role => roles[role] > 1)) fail('自定义身份须为 6 至 20 人，狼人少于半数，至少一位平民，每种神职最多一位');
  return roles;
}
function shuffle(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
}

export class WerewolfGames {
  constructor(store, { isKnown, friends, group, nickname = () => '', clock = Date.now, pauseChat = () => {}, resumeChat = () => {}, consume = () => {}, knownIds = () => [], ownsHuman = (bot, human) => human === `${bot}H`, eligible = () => true }) {
    this.store = store; this.isKnown = isKnown; this.friends = friends; this.group = group; this.nickname = nickname; this.clock = clock;
    this.pauseChat = pauseChat; this.resumeChat = resumeChat; this.consume = consume; this.knownIds = knownIds; this.ownsHuman = ownsHuman;
    this.eligible = eligible;
  }
  rules(who) {
    return { presets: PRESETS, customPlayers: '6–20 人，每种神职最多一位，狼人少于半数且至少一位平民',
      rulebook: RULEBOOK, matchSizes: MATCH_SIZES, dailyLimit: DAILY_GAMES, usedToday: this.participation(who, this.clock()).length,
      timezone: 'Asia/Shanghai', startWindows: WEEKDAY_GAME_WINDOWS, weekendStartWindows: WEEKEND_GAME_WINDOWS };
  }
  get(gameId) {
    if (typeof gameId !== 'string' || !/^[0-9a-f-]{36}$/.test(gameId)) fail('游戏 ID 不合法');
    const game = this.store.get('games', gameId);
    if (!game) fail('游戏不存在', 404);
    return game;
  }
  save(game) {
    game.kind = game.status;
    game.at = game.deadlineAt ?? game.scheduledAt;
    this.store.put('games', game.id, game);
  }
  emit(game, channel, recipients, data, sender = 'system') {
    recipients = recipients.filter(who => !game.left?.includes(who));
    const at = iso(this.clock());
    const entry = { id: randomUUID(), gameId: game.id, channel, sender, senderNickname: sender === 'system' ? '星邮法官' : this.nickname(sender),
      recipients: [...new Set(recipients)], at, ...data };
    this.store.put('gameMessages', entry.id, entry);
    const viewers = game.public && channel !== 'outside' ? (game.spectators ?? []).filter(who => !game.left?.includes(who) && !this.store.get('gameBusy', who)) : [];
    this.notify([...new Set([...recipients, ...viewers])].filter(who => who !== sender && !who.endsWith('H')), `game.${channel}`, entry, at);
    return entry;
  }
  notify(recipients, ...args) {
    const left = args[1]?.gameId ? this.store.get('games', args[1].gameId)?.left ?? [] : [];
    this.store.emit(recipients.filter(who => !who.endsWith('H') && !left.includes(who)), ...args);
  }
  public(game, data, sender = 'system') { return this.emit(game, 'public', [...game.participants, ...(game.judgeBotId ? [game.judgeBotId] : [])], data, sender); }
  private(game, to, data) { return this.emit(game, 'private', [to], { to, ...data }); }
  invited(game, targets, source = {}) {
    const details = { ...this.summary(game), ...source };
    for (const who of targets) this.store.put('gameAccess', `${who}:${game.id}`, { owner: who, gameId: game.id, at: game.createdAt });
    this.notify(targets.filter(who => !who.endsWith('H')), 'game.invited', details);
  }
  summary(game, who) {
    return { gameId: game.id, title: game.title, creator: game.creator, judgeMode: game.judgeMode,
      judgeBotId: game.judgeBotId, assignmentMode: game.assignmentMode, scheduledAt: game.scheduledAt,
      startMode: game.startMode ?? 'scheduled', matching: Boolean(game.matching),
      status: game.status, maxPlayers: game.maxPlayers, joined: game.joined.length, checkedIn: game.checkedIn.length,
      checkedInSelf: who ? game.checkedIn.includes(who) : undefined,
      rules: game.rules, participant: who ? game.joined.includes(who) : undefined, canInvite: who ? this.canInvite(game, who) : false,
      judge: who ? game.judgeBotId === who : undefined, phaseDeadlineAt: game.deadlineAt,
      winner: game.winner ?? null, public: Boolean(game.public), published: Boolean(game.published), spectators: (game.spectators ?? []).length };
  }
  canView(game, who) {
    if (!game.public && game.creator !== who && game.judgeBotId !== who && !game.formerJudgeBotIds?.includes(who) && !game.invited.includes(who) && !game.joined.includes(who)) fail('无权查看此局游戏', 403);
  }
  participation(who, now) {
    return this.store.get('gameParticipation', `${who}:${day(now)}`)?.games ?? [];
  }
  completedAt(game) {
    if (game.finishedAt) return game.finishedAt;
    const row = this.store.statement("SELECT data FROM documents WHERE collection='gameMessages' AND scope=? AND json_extract(data,'$.kind')='finished' ORDER BY rowid DESC LIMIT 1").get(game.id);
    return row ? JSON.parse(row.data).at : null;
  }
  record(who, viewer) {
    const completed = this.store.list('gameAccess', 'owner=?', [who], { limit: -1 })
      .map(access => this.store.get('games', access.gameId))
      .filter(game => game && game.participants?.includes(who) && ['finished', 'closed'].includes(game.status) && game.winner)
      .map(game => ({ game, completedAt: this.completedAt(game) ?? game.startedAt ?? '' }))
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
    const wins = completed.filter(({ game }) => (game.roles[who] === 'wolf') === (game.winner === 'wolves') && game.winner !== 'draw').length;
    const draws = completed.filter(({ game }) => game.winner === 'draw').length;
    return { wins, losses: completed.length - wins - draws, draws,
      recent: completed.slice(0, 3).map(({ game, completedAt }) => {
        const visible = viewer === who || game.public && game.published;
        return { at: completedAt, result: game.winner === 'draw' ? 'draw'
          : (game.roles[who] === 'wolf') === (game.winner === 'wolves') ? 'win' : 'loss',
          ...(visible ? { gameId: game.id, title: game.title, public: Boolean(game.public && game.published) } : { title: '私密对局', public: false }) };
      }) };
  }
  featured(now = this.clock()) {
    const reportDate = day(now - DAY), availableAt = new Date(`${day(now)}T00:00:00+08:00`).toISOString();
    const start = new Date(`${reportDate}T00:00:00+08:00`).toISOString();
    const end = iso(Date.parse(start) + DAY);
    const todayGames = this.store.list('games', "json_extract(data,'$.startedAt')>=? AND json_extract(data,'$.startedAt')<?", [start, end], { limit: -1 });
    const candidates = todayGames.filter(game => ['finished', 'closed'].includes(game.status) && game.public && game.published)
      .map(game => {
        const finishedAt = this.completedAt(game);
        return { game, finishedAt, durationMs: finishedAt ? Date.parse(finishedAt) - Date.parse(game.startedAt) : -1 };
      }).filter(item => item.durationMs >= 0 && Date.parse(item.finishedAt) <= Date.parse(availableAt))
      .sort((a, b) => b.durationMs - a.durationMs || a.game.startedAt.localeCompare(b.game.startedAt));
    const chosen = candidates[0];
    return { date: reportDate, availableAt, published: true, totalGames: todayGames.length,
      featured: chosen ? { gameId: chosen.game.id, title: chosen.game.title, startedAt: chosen.game.startedAt,
        finishedAt: chosen.finishedAt, durationMs: chosen.durationMs, winner: chosen.game.winner,
        participants: chosen.game.participants.length } : null };
  }
  featuredRead(gameId, before) {
    const daily = this.featured(), game = daily.featured?.gameId === gameId ? this.get(gameId) : fail('今日精彩对局不存在或尚未公布', 404);
    const cursor = before == null ? Number.MAX_SAFE_INTEGER : before;
    if (!Number.isSafeInteger(cursor) || cursor < 1) fail('消息游标不合法');
    const rows = this.store.statement("SELECT rowid,data FROM documents WHERE collection='gameMessages' AND scope=? AND rowid<? ORDER BY rowid DESC LIMIT 51").all(game.id, cursor);
    const page = rows.slice(0, 50).reverse();
    return { ...daily, messages: page.map(row => ({ ...JSON.parse(row.data), cursor: row.rowid })), nextBefore: rows.length > 50 ? page[0].rowid : null };
  }
  charge(who, gameId, now) {
    const key = `${who}:${day(now)}`, games = this.participation(who, now);
    if (games.length >= DAILY_GAMES) return false;
    this.store.put('gameParticipation', key, { owner: who, day: day(now), games: [...games, gameId], at: iso(now) });
    return true;
  }
  immediate(game) { return game.startMode === 'full'; }
  busy(who, except) {
    const lock = this.store.get('gameBusy', who);
    if (lock && lock.gameId !== except) {
      const game = this.store.get('games', lock.gameId) ?? this.store.get('mysteryGames', lock.gameId);
      if (game && ['assigning', 'night_wolf', 'night_gods', 'day', 'vote', 'hunter', 'active'].includes(game.status)) return true;
    }
    if (who.endsWith('H')) {
      const human = this.store.get('humanGameLock', who.slice(0, -1));
      const game = human && this.store.get('games', human.gameId);
      if (game && game.id !== except && ['assigning', 'night_wolf', 'night_gods', 'day', 'vote', 'hunter', 'finished'].includes(game.status)) return true;
    }
    return false;
  }
  waiting(who) {
    const row = this.store.get('gameWaiting', who), game = row && this.store.get('games', row.gameId);
    return game?.status === 'scheduled' && this.immediate(game) && (game.joined.includes(who) || game.judgeBotId === who) ? row : null;
  }
  assertReady(who, gameId) {
    if (!this.eligible(who)) fail('当前账号不能参加游戏', 403);
    if (!canStartAt(this.clock())) fail(GAME_SCHEDULE_RULE);
    if (this.busy(who, gameId)) fail('请先完成当前对局');
    if (this.participation(who, this.clock()).length >= DAILY_GAMES) fail('今日已参加 5 局');
    if (this.waiting(who) && this.waiting(who).gameId !== gameId) fail('已在其他人满即开或匹配房间等待，请先退出');
    const other = this.store.get('mysteryWaiting', who);
    if (other && this.store.get('mysteryGames', other.gameId)?.status === 'scheduled') fail('已在剧本杀人满即开房间等待，请先退出');
  }
  ready(who, game) {
    this.store.put('gameWaiting', who, { owner: who, gameId: game.id, expiresAt: this.clock() + READY_TTL });
  }
  touchWaiting(who) {
    const row = this.waiting(who);
    // Network polling renews readiness without waking a bot or adding prompt tokens.
    if (row && row.expiresAt > this.clock() && row.expiresAt - this.clock() < READY_TTL / 2)
      this.store.put('gameWaiting', who, { ...row, expiresAt: this.clock() + READY_TTL });
  }
  clearWaiting(who, gameId) {
    if (this.store.get('gameWaiting', who)?.gameId === gameId) this.store.remove('gameWaiting', who);
  }
  tryFull(game, now = this.clock()) {
    if (!this.immediate(game) || game.status !== 'scheduled') return;
    const members = [...game.joined, ...(game.judgeBotId && game.judgeAccepted ? [game.judgeBotId] : [])];
    for (const who of members) {
      const ready = this.store.get('gameWaiting', who);
      if (ready?.gameId !== game.id || ready.expiresAt <= now || !this.eligible(who) || this.busy(who, game.id) || this.participation(who, now).length >= DAILY_GAMES) {
        this.exit(who, game.id);
      }
    }
    // exit persists its own copy; never overwrite removed members with a stale game.
    Object.assign(game, this.get(game.id));
    if (!canStartAt(now)) {
      this.cancelWaiting(game, '进入限制时段，等待已取消；未开局不计次数。'); return;
    }
    if (!game.joined.length && !game.judgeBotId) { this.cancelWaiting(game, '等待房间已无成员。'); return; }
    if (game.joined.length < game.maxPlayers) return;
    game.checkedIn = [...game.joined]; game.judgeCheckedIn = Boolean(game.judgeBotId && game.judgeAccepted);
    this.save(game); this.beginAtAppointment(game, now);
  }
  cancelWaiting(game, reason) {
    game.status = 'cancelled'; game.deadlineAt = null; this.save(game);
    for (const who of [...game.joined, ...(game.judgeBotId ? [game.judgeBotId] : [])]) this.clearWaiting(who, game.id);
    this.notify([...new Set([...game.joined, game.creator, ...(game.judgeBotId ? [game.judgeBotId] : [])])], 'game.cancelled', { gameId: game.id, reason });
  }
  match(who, args = {}) {
    const operation = args.operation ?? 'status';
    if (!['join', 'leave', 'status'].includes(operation)) fail('匹配操作须为 join/status/leave');
    if (operation === 'leave') {
      const waiting = this.waiting(who);
      if (waiting && this.get(waiting.gameId).matching) this.exit(who, waiting.gameId);
      return this.matchStatus(who);
    }
    if (operation === 'status') return this.matchStatus(who);
    if (!MATCH_SIZES.includes(args.maxPlayers)) fail('匹配人数须为 6、8、10、12、16 或 20');
    const old = this.waiting(who);
    if (old) {
      const game = this.get(old.gameId);
      if (!game.matching || game.maxPlayers !== args.maxPlayers) fail('已在等待其他对局，请先退出后再选择人数');
      this.assertReady(who, game.id); return this.matchStatus(who);
    }
    this.assertReady(who);
    let game = this.store.list('games', "kind='scheduled'", [], { limit: -1 })
      .find(g => g.matching && g.maxPlayers === args.maxPlayers && g.joined.length < g.maxPlayers && !g.kicked?.includes(who));
    if (game) this.join(who, game.id);
    else {
      const created = this.schedule(who, { startMode: 'full', public: true, sourceKind: 'square', maxPlayers: args.maxPlayers,
        title: `${args.maxPlayers} 人狼人杀 · 实时匹配` });
      game = this.get(created.gameId); game.matching = true; this.save(game);
    }
    this.store.put('gameMatchLast', who, { owner: who, gameId: game.id });
    return this.matchStatus(who);
  }
  matchStatus(who) {
    const row = this.waiting(who) ?? this.store.get('gameMatchLast', who), game = row && this.store.get('games', row.gameId);
    const current = game?.matching && !game.left?.includes(who) && game.joined.includes(who) ? game : null;
    return { state: current?.status === 'scheduled' ? 'waiting' : current && !['cancelled', 'closed'].includes(current.status) ? 'matched' : 'idle',
      sizes: MATCH_SIZES, ...(current ? { game: this.summary(current, who) } : {}) };
  }
  schedule(who, args) {
    const now = this.clock(), startMode = args.startMode ?? 'scheduled', immediate = startMode === 'full', scheduled = Date.parse(args.scheduledAt);
    if (!['scheduled', 'full'].includes(startMode)) fail('开局模式须为 scheduled 或 full');
    if (immediate) { if (args.public !== true) fail('人满就开只用于公开局'); this.assertReady(who); }
    if (!immediate && (typeof args.scheduledAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(args.scheduledAt)
      || !Number.isFinite(scheduled) || scheduled < now + 3 * 60000 || scheduled > now + 7 * DAY)) fail('请预约 3 分钟后至 7 天内的时间，使用带时区的 ISO 日期');
    if (!immediate && !canStartAt(scheduled)) fail(GAME_SCHEDULE_RULE);
    const judgeMode = args.judgeMode === 'bot' ? 'bot' : args.judgeMode === 'program' || args.judgeMode == null ? 'program' : fail('法官模式不合法');
    const judgeBotId = judgeMode === 'bot' ? checkedId(args.judgeBotId ?? who) : null;
    if (judgeBotId?.endsWith('H')) fail('人类玩家不能担任 bot 法官，请使用程序或 bot 法官');
    if (judgeBotId && !this.isKnown(judgeBotId)) fail('法官 bot 不存在');
    if (judgeBotId && judgeBotId !== who && !this.friends(who).includes(judgeBotId)) fail('只能邀请自己的好友担任法官', 403);
    const assignmentMode = judgeMode === 'bot' && args.assignmentMode === 'judge' ? 'judge' : 'random';
    if (args.assignmentMode && !['judge', 'random'].includes(args.assignmentMode)) fail('分发身份模式不合法');
    const custom = args.roles != null ? customRoles(args.roles) : null;
    const maxPlayers = custom ? Object.values(custom).reduce((a, b) => a + b, 0) : args.maxPlayers;
    if (!Number.isInteger(maxPlayers) || maxPlayers < 6 || maxPlayers > 20) fail('预约人数须为 6 至 20');
    const title = text(args.title ?? '狼人杀', 60);
    if (this.store.count('games', "owner=? AND kind='scheduled'", [who]) >= 3) fail('最多同时保留 3 个待开局预约');
    const sourceKind = args.sourceKind === 'group' ? 'group' : args.sourceKind === 'private' ? 'private' : args.sourceKind === 'square' && args.public === true ? 'square' : fail('请选择私聊、群聊邀请或公开预约');
    const sourceTarget = String(args.sourceTarget ?? '');
    const targets = sourceKind === 'square' ? [] : sourceKind === 'private'
      ? [checkedId(sourceTarget)]
      : this.group(who, sourceTarget).members.filter(botId => botId !== who);
    if (sourceKind === 'private' && !this.friends(who).includes(targets[0])) fail('只能通过私聊邀请好友', 403);
    const invited = [...new Set(targets.filter(botId => botId !== judgeBotId))];
    const game = { id: randomUUID(), title, creator: who, judgeMode, judgeBotId, assignmentMode,
      public: args.public === true, published: immediate, spectators: [], startMode,
      scheduledAt: immediate ? null : iso(scheduled), createdAt: iso(now), status: 'scheduled', deadlineAt: immediate ? null : iso(scheduled),
      maxPlayers, customRoles: custom, rules: custom ?? (immediate ? presetRoles(maxPlayers) : { preset: '按实际报到人数自动匹配 6–20 人身份配置' }),
      invited, joined: judgeBotId === who ? [] : [who], checkedIn: immediate && judgeBotId !== who ? [who] : [], judgeAccepted: judgeBotId === who,
      judgeCheckedIn: immediate && judgeBotId === who, participants: [], alive: [], roles: {}, day: 0, uses: {}, lastGuard: null,
      night: {}, votes: {}, winner: null, reminded: false };
    this.save(game);
    if (immediate) this.ready(who, game);
    this.store.put('gameAccess', `${who}:${game.id}`, { owner: who, gameId: game.id, at: game.createdAt });
    this.invited(game, invited, { sourceKind, sourceTarget, invitedBy: who });
    if (judgeBotId && judgeBotId !== who) {
      this.store.put('gameAccess', `${judgeBotId}:${game.id}`, { owner: judgeBotId, gameId: game.id, at: game.createdAt });
      this.notify([judgeBotId], 'game.judge_invited', this.summary(game));
    }
    return this.summary(game, who);
  }
  // HumanGames may retain a legacy player ID while contacts belong to the merged account.
  invite(who, args, contactId = who) {
    const game = this.get(args.gameId);
    if (!this.canInvite(game, who)) fail('仅开局前的预约成员、法官或发起人所属 bot 可邀请；请先加入，退出或被移出后不能邀请', 403);
    const kind = args.sourceKind, target = String(args.sourceTarget ?? '');
    const candidates = kind === 'private' ? [checkedId(target)] : kind === 'group' ? this.group(contactId, target).members : fail('请选择私聊或群聊邀请');
    if (kind === 'private' && !this.friends(contactId).includes(candidates[0])) fail('只能通过私聊邀请好友', 403);
    const added = [...new Set(candidates.filter(id => id !== who && id !== contactId && id !== game.judgeBotId && !game.joined.includes(id) && !game.invited.includes(id) && !game.kicked?.includes(id)))];
    game.invited.push(...added); this.save(game); this.invited(game, added, { sourceKind: kind, sourceTarget: target, invitedBy: who });
    return { gameId: game.id, invited: added.length };
  }
  canInvite(game, who) {
    return game.status === 'scheduled' && !game.left?.includes(who) && !game.kicked?.includes(who)
      && (game.creator === who || this.ownsHuman(who, game.creator) || game.judgeBotId === who || game.joined.includes(who));
  }
  join(who, gameId) {
    const game = this.get(gameId);
    if (game.kicked?.includes(who)) fail('你已被移出本局', 403);
    if (game.status !== 'scheduled') fail('预约已结束');
    if (this.immediate(game)) this.assertReady(who, gameId);
    if (who === game.judgeBotId) {
      if (this.participation(who, this.immediate(game) ? this.clock() : Date.parse(game.scheduledAt)).length >= DAILY_GAMES) fail('预约当天已参加 5 局');
      game.left = (game.left ?? []).filter(id => id !== who);
      game.judgeAccepted = true; if (this.immediate(game)) { game.judgeCheckedIn = true; this.ready(who, game); } this.save(game); return { gameId, judge: true };
    }
    if (!game.joined.includes(who) && !game.invited.includes(who) && who !== game.creator && !(game.public && game.published)) fail('此预约未公告到公开广场，须先收到邀请', 403);
    if (game.joined.includes(who)) return { gameId, joined: true };
    game.spectators = (game.spectators ?? []).filter(id => id !== who);
    if (game.joined.length >= game.maxPlayers) fail('名额已满');
    if (this.participation(who, this.immediate(game) ? this.clock() : Date.parse(game.scheduledAt)).length >= DAILY_GAMES) fail('预约当天已参加 5 局');
    game.left = (game.left ?? []).filter(id => id !== who);
    game.joined.push(who);
    if (this.immediate(game)) { game.checkedIn.push(who); this.ready(who, game); }
    this.save(game);
    this.store.put('gameAccess', `${who}:${game.id}`, { owner: who, gameId: game.id, at: iso(this.clock()) });
    this.notify([game.creator], 'game.joined', { gameId, botId: who, joined: game.joined.length });
    if (game.matching) this.store.put('gameMatchLast', who, { owner: who, gameId });
    this.tryFull(game);
    return { gameId, joined: true, status: game.status, startMode: game.startMode ?? 'scheduled' };
  }
  checkin(who, gameId) {
    const game = this.get(gameId), now = this.clock(), start = Date.parse(game.scheduledAt);
    if (this.immediate(game)) { if (!game.joined.includes(who) && game.judgeBotId !== who) fail('请先加入'); return { gameId, checkedIn: true, message: '加入即准备，人满立即开局。' }; }
    if (game.kicked?.includes(who)) fail('你已被移出本局', 403);
    if (game.status !== 'scheduled' || now < start - 3 * 60000 || now >= start) fail('请在开局前 3 分钟内报到');
    if (who === game.judgeBotId) {
      if (!game.judgeAccepted) fail('请先接受法官邀请');
      game.judgeCheckedIn = true;
    } else {
      if (!game.joined.includes(who)) fail('请先加入预约');
      if (!game.checkedIn.includes(who)) game.checkedIn.push(who);
    }
    this.save(game);
    return { gameId, checkedIn: true };
  }
  leave(who, gameId) {
    const game = this.get(gameId);
    if (game.status !== 'scheduled') fail('已开局；bot 可用 exit 离开房间并弃权');
    return this.exit(who, gameId);
  }
  exit(who, gameId) {
    const game = this.get(gameId);
    if (game.left?.includes(who)) return { gameId, left: true, alreadyLeft: true };
    const judge = game.judgeBotId === who, player = game.participants.includes(who);
    const spectator = (game.spectators ?? []).includes(who);
    if (!judge && !player && !game.joined.includes(who) && !spectator) fail('你不在这个游戏房间内', 403);
    const recipients = [...new Set([...(game.status === 'scheduled' ? game.joined : game.participants),
      ...(game.judgeBotId ? [game.judgeBotId] : []), ...(game.spectators ?? [])])];
    const active = ['assigning','night_wolf','night_gods','day','vote','hunter'].includes(game.status);
    const wasAlive = game.alive.includes(who);
    game.left = [...(game.left ?? []), who];
    game.spectators = (game.spectators ?? []).filter(id => id !== who);
    if (game.status === 'scheduled') {
      game.joined = game.joined.filter(id => id !== who); game.checkedIn = game.checkedIn.filter(id => id !== who);
    }
    if (judge) {
      game.formerJudgeBotIds = [...new Set([...(game.formerJudgeBotIds ?? []), who])];
      game.judgeBotId = null; game.judgeMode = 'program'; game.assignmentMode = 'random';
      game.judgeAccepted = false; game.judgeCheckedIn = false;
    }
    if (active && player) {
      game.alive = game.alive.filter(id => id !== who);
      for (const votes of [game.night?.wolfVotes, game.votes]) if (votes) {
        for (const [voter, target] of Object.entries(votes)) if (voter === who || target === who) delete votes[voter];
      }
      if (game.night?.victim === who) game.night.victim = null;
      if (wasAlive) game.roundDeaths = (game.roundDeaths ?? 0) + 1;
    }
    this.save(game);
    this.clearWaiting(who, game.id);
    if (this.store.get('gameBusy', who)?.gameId === game.id) {
      this.store.remove('gameBusy', who); this.resumeChat(who);
    }
    const consequence = judge ? '，由程序法官接管' : active && player ? '，本局视为弃权' : '';
    this.emit(game, 'public', recipients, { kind: 'left', botId: who, nickname: this.nickname(who),
      text: `${this.nickname(who) || who} 已离开游戏房间${consequence}。` });
    if (judge && game.status === 'assigning') this.start(game);
    else if (active && game.pendingHunter === who) {
      game.pendingHunter = null; this.afterElimination(game, game.hunterResume === 'day' ? 'day' : 'night');
    } else if (active && wasAlive) {
      const winner = game.status === 'hunter' ? null : this.winner(game);
      if (winner) this.finish(game, winner);
      else this.advanceCompleted(game);
    }
    return { gameId, left: true, forfeited: active && player, status: this.get(gameId).status };
  }
  list(who) {
    return this.store.list('gameAccess', 'owner=?', [who], { limit: 50, reverse: true })
      .map(access => this.store.get('games', access.gameId)).filter(Boolean)
      .filter(game => game.public || game.creator === who || game.judgeBotId === who || game.formerJudgeBotIds?.includes(who) || game.invited.includes(who) || game.joined.includes(who))
      .map(game => this.summary(game, who));
  }
  publicListings() {
    return this.store.list('games', `kind IN (${ACTIVE.map(() => '?').join(',')})`, ACTIVE, { limit: -1, reverse: true })
      .filter(game => game.public && game.published).slice(0, 100).map(game => ({ ...this.summary(game), id: game.id, kind: 'game', author: game.creator, target: game.id, text: game.title, at: game.createdAt }));
  }
  visibility(who, args) {
    const game = this.get(args.gameId);
    if (this.immediate(game)) fail('人满即开和匹配房间须保持公开');
    if (game.creator !== who || game.status !== 'scheduled' || typeof args.public !== 'boolean') fail('仅发起人可在开局前设置公开性', 403);
    game.public = args.public; if (!game.public) { game.spectators = []; game.published = false; }
    this.save(game); return { gameId: game.id, public: game.public };
  }
  publish(who, gameId) {
    const game = this.get(gameId);
    if (game.creator !== who || !game.public || !ACTIVE.includes(game.status)) fail('只有公开对局的发起人可公告', 403);
    if (game.published) fail('本局已公告');
    game.published = true; this.save(game);
    this.notify(this.knownIds().filter(id => id !== who), 'square.game', this.publicListings().find(item => item.id === game.id));
    return { gameId, published: true };
  }
  watch(who, gameId, enabled) {
    const game = this.get(gameId);
    if (!game.public || !ACTIVE.includes(game.status)) fail('对局未公开或已经关闭', 403);
    if (game.participants.includes(who) || game.judgeBotId === who || game.joined.includes(who)) fail('参与者不能进入全知观战频道', 403);
    if (this.store.get('gameBusy', who)) fail('正在对局时不能观战其他对局', 403);
    game.spectators ??= []; game.spectators = game.spectators.filter(id => id !== who);
    if (enabled) { game.spectators.push(who); game.left = (game.left ?? []).filter(id => id !== who); } this.save(game);
    this.store.put('gameAccess', `${who}:${game.id}`, { owner: who, gameId, at: game.createdAt });
    return { gameId, watching: enabled };
  }
  read(who, gameId, before) {
    const game = this.get(gameId); this.canView(game, who);
    const spectator = Boolean(game.public && !game.joined.includes(who) && game.judgeBotId !== who);
    if (spectator && this.store.get('gameBusy', who)) fail('正在对局时不能读取全知视角', 403);
    if (!spectator && !['scheduled', 'cancelled'].includes(game.status) && !game.participants.includes(who) && game.judgeBotId !== who && !game.formerJudgeBotIds?.includes(who)) fail('不是此局聊天室成员', 403);
    const cursor = before == null ? Number.MAX_SAFE_INTEGER : before;
    if (!Number.isSafeInteger(cursor) || cursor < 1) fail('消息游标不合法');
    const rows = this.store.statement("SELECT rowid,data FROM documents WHERE collection='gameMessages' AND scope=? AND rowid<? ORDER BY rowid DESC LIMIT 200").all(game.id, cursor);
    const allowed = rows.map(row => ({ ...JSON.parse(row.data), cursor: row.rowid })).filter(item => spectator || item.channel === 'public'
      || item.channel === 'private' && item.to === who
      || item.channel === 'wolf' && item.recipients.includes(who)
      || game.judgeBotId === who && item.channel !== 'outside');
    const page = allowed.slice(0, 50).reverse();
    return { game: { ...this.summary(game, who), rulebook: RULEBOOK, participants: game.participants, alive: game.alive, day: game.day,
      ownRole: game.roles[who] ?? null, uses: game.roles[who] ? game.uses[who] ?? {} : undefined,
      speechEnded: game.status === 'day' && Boolean(game.dayDone?.includes(who)),
      speechesDone: game.status === 'day' ? game.alive.filter(id => game.dayDone?.includes(id)).length : undefined,
      ...(who === game.judgeBotId ? { assignments: game.roles } : {}) },
      messages: page, nextBefore: allowed.length > 50 ? page[0].cursor : rows.length === 200 ? rows.at(-1).rowid : null };
  }
  assign(who, args) {
    const game = this.get(args.gameId);
    if (game.status !== 'assigning' || game.judgeBotId !== who || game.assignmentMode !== 'judge') fail('当前不能由你分发身份', 403);
    if (!Array.isArray(args.assignments) || args.assignments.length !== game.participants.length) fail('请为每位报到玩家指定一个身份');
    const roles = {};
    for (const item of args.assignments) {
      const botId = checkedId(item?.botId), role = item?.role;
      if (!game.participants.includes(botId) || roles[botId] || !ROLES.includes(role)) fail('身份分发对象或身份不合法');
      roles[botId] = role;
    }
    for (const role of ROLES) if (Object.values(roles).filter(value => value === role).length !== (game.rules[role] ?? 0)) fail('身份人数与本局规则不符');
    this.start(game, roles);
    return { gameId: game.id, assigned: true };
  }
  start(game, assignedRoles = null) {
    const roles = assignedRoles ?? {};
    if (!assignedRoles) {
      const deck = shuffle(ROLES.flatMap(role => Array(game.rules[role] ?? 0).fill(role)));
      game.participants.forEach((who, i) => { roles[who] = deck[i]; });
    }
    game.roles = roles; game.alive = game.participants.filter(who => !game.left?.includes(who)); game.day = 1;
    game.uses = Object.fromEntries(game.participants.map(who => [who, { save: false, poison: false, shot: false }]));
    game.status = 'night_wolf'; game.deadlineAt = iso(this.clock() + 3 * 60000);
    this.save(game);
    this.public(game, { kind: 'started', rules: game.rules, participants: game.participants,
      judgeMode: game.judgeMode, judgeBotId: game.judgeBotId, rulebook: RULEBOOK, day: 1, phase: game.status, deadlineAt: game.deadlineAt });
    for (const who of game.participants.filter(id => !game.left?.includes(id))) this.private(game, who, { kind: 'role', role: roles[who],
      teammates: roles[who] === 'wolf' ? game.participants.filter(other => other !== who && roles[other] === 'wolf') : [] });
    if (game.judgeBotId) this.emit(game, 'judge', [game.judgeBotId], { kind: 'assignments', roles });
    this.public(game, { kind: 'night_wolf', day: game.day, deadlineAt: game.deadlineAt });
    if (game.left?.some(who => game.participants.includes(who))) {
      const winner = game.alive.length ? this.winner(game) : 'draw';
      if (winner) this.finish(game, winner);
    }
  }
  beginAtAppointment(game, now) {
    const busy = who => this.busy(who, game.id);
    const present = game.checkedIn.filter(who => this.participation(who, now).length < DAILY_GAMES && !busy(who));
    const absent = game.joined.filter(who => !present.includes(who));
    const judgeReady = game.judgeMode === 'program' || game.judgeAccepted && game.judgeCheckedIn && !busy(game.judgeBotId)
      && this.participation(game.judgeBotId, now).length < DAILY_GAMES;
    if (!judgeReady) { game.judgeMode = 'program'; game.judgeBotId = null; game.assignmentMode = 'random'; }
    let roles = game.customRoles;
    if (roles) {
      const fixed = Object.entries(roles).filter(([role]) => role !== 'villager').reduce((sum, [, n]) => sum + n, 0);
      roles = { ...roles, villager: present.length - fixed };
    } else if (present.length >= 6) roles = presetRoles(present.length);
    if (!canStartAt(now) || present.length < 6 || !roles || roles.villager < 1 || roles.wolf >= present.length / 2 || present.length < Object.values(roles).reduce((a, b) => a + b, 0)) {
      game.status = 'cancelled'; game.deadlineAt = null; this.save(game);
      this.notify([...new Set([...game.joined, game.creator, ...(game.judgeBotId ? [game.judgeBotId] : [])])], 'game.cancelled',
        { gameId: game.id, reason: !canStartAt(now) ? '实际开局时间处于限制时段' : '可参加的报到人数不足或自定义身份人数无法匹配', present, absent });
      return;
    }
    game.rules = roles; game.participants = present; game.startedAt = iso(now);
    for (const who of [...present, ...(game.judgeBotId ? [game.judgeBotId] : [])]) {
      this.clearWaiting(who, game.id);
      this.charge(who, game.id, now); this.store.put('gameBusy', who, { gameId: game.id });
      if (who.endsWith('H')) this.store.put('humanGameLock', who.slice(0, -1), { gameId: game.id });
      this.pauseChat(who);
    }
    this.notify([...new Set([...game.joined, game.creator, ...(game.judgeBotId ? [game.judgeBotId] : [])])], 'game.attendance',
      { gameId: game.id, participants: present, absent, judgeMode: game.judgeMode });
    if (game.assignmentMode === 'judge') {
      game.status = 'assigning'; game.deadlineAt = iso(now + 2 * 60000); this.save(game);
      this.notify([game.judgeBotId], 'game.assign_request', { gameId: game.id, participants: present,
        roles, deadlineAt: game.deadlineAt });
    } else this.start(game);
  }
  message(who, args) {
    const game = this.get(args.gameId), now = this.clock();
    if (game.left?.includes(who)) fail('你已离开本局房间', 403);
    if (game.kicked?.includes(who)) fail('你已被禁言并移出本局', 403);
    if (args.channel === 'outside') {
      if (!game.public || !(game.spectators ?? []).includes(who) || game.joined.includes(who) || game.judgeBotId === who || this.store.get('gameBusy', who) || !ACTIVE.includes(game.status)) fail('仅未参赛的观众可在局外讨论', 403);
      const content = text(args.text, 1000, true);
      if (this.store.count('gameMessages', 'scope=? AND owner=? AND at>=?', [game.id, who, iso(now - 60000)]) >= 6) fail('每分钟最多 6 条', 429);
      this.consume(who); const entry = this.emit(game, 'outside', game.spectators.filter(id => !this.store.get('gameBusy', id)), { kind: 'chat', text: content }, who);
      return { gameId: game.id, messageId: entry.id, channel: 'outside' };
    }
    if (!['night_wolf', 'night_gods', 'day', 'vote', 'finished'].includes(game.status)) fail('聊天室尚未开放或已经关闭');
    const judge = game.judgeBotId === who, player = game.participants.includes(who);
    if (!judge && !player) fail('不是本局成员', 403);
    const channel = args.channel === 'wolf' ? 'wolf' : args.channel === 'public' ? 'public' : fail('频道不合法');
    if (channel === 'wolf' && (game.roles[who] !== 'wolf' || game.status !== 'night_wolf')) fail('仅存活狼人可在夜晚狼人频道发言', 403);
    if (channel === 'public' && !judge && !['day', 'vote', 'finished'].includes(game.status)) fail('公共频道仅在白天开放');
    if (!judge && game.status !== 'finished' && !game.alive.includes(who)) fail('出局玩家不能继续发言');
    const content = text(args.text, 1000, true);
    const count = this.store.count('gameMessages', "scope=? AND owner=? AND at>=?", [game.id, who, iso(now - 60000)]);
    if (count >= 6) fail('游戏室每分钟最多发 6 条消息', 429);
    const recipients = channel === 'wolf' ? game.alive.filter(id => game.roles[id] === 'wolf') : [...game.participants, ...(game.judgeBotId ? [game.judgeBotId] : [])];
    const entry = this.emit(game, channel, recipients, { kind: 'chat', text: content }, who);
    return { gameId: game.id, messageId: entry.id, channel };
  }
  act(who, args) {
    const game = this.get(args.gameId), role = game.roles[who], action = args.action;
    this.checkPhase(game, args.expectedPhase);
    if (game.left?.includes(who)) fail('你已离开本局房间', 403);
    if (game.kicked?.includes(who)) fail('你已被移出本局', 403);
    if (!role || !game.alive.includes(who) && game.status !== 'hunter') fail('不是存活玩家', 403);
    if (action === 'end_speech') {
      if (game.status !== 'day' || !game.alive.includes(who)) fail('仅存活玩家可在白天结束发言', 403);
      if (!game.dayDone?.includes(who)) {
        game.dayDone = [...(game.dayDone ?? []), who]; this.save(game);
      }
      this.advanceCompleted(game);
      return { gameId: game.id, action, status: game.status };
    }
    if (['night_wolf', 'night_gods'].includes(game.status) && game.night.passed?.includes(who)) fail('本夜已跳过行动');
    if (action === 'skip' && (game.status === 'night_wolf' && role === 'wolf' || game.status === 'night_gods' && ['seer', 'guard', 'witch'].includes(role))) {
      if (game.night.wolfVotes?.[who] || role === 'seer' && game.night.seerTarget || role === 'guard' && game.night.guardTarget || role === 'witch' && game.night.witchActed) fail('本夜已经行动');
      game.night.passed = [...(game.night.passed ?? []), who]; this.save(game); this.advanceCompleted(game); return { gameId: game.id, action, status: game.status };
    }
    const target = args.target == null || args.target === '' ? null : checkedId(args.target);
    if (target && !game.alive.includes(target)) fail('目标不是存活玩家');
    if (game.status === 'night_wolf' && role === 'wolf' && action === 'attack') {
      if (Object.hasOwn(game.night.wolfVotes ?? {}, who)) fail('本夜已经提交狼刀，不能修改');
      if (!target || game.roles[target] === 'wolf') fail('狼人须指定一位存活的非狼人');
      game.night.wolfVotes ??= {}; game.night.wolfVotes[who] = target;
      this.emit(game, 'wolf', game.alive.filter(id => game.roles[id] === 'wolf'), { kind: 'attack_vote', botId: who, target });
    } else if (game.status === 'night_gods' && role === 'seer' && action === 'inspect') {
      if (!target || target === who || game.night.seerTarget) fail('本夜只能查验一位其他存活玩家');
      game.night.seerTarget = target;
      this.private(game, who, { kind: 'inspect_result', target, isWolf: game.roles[target] === 'wolf' });
    } else if (game.status === 'night_gods' && role === 'guard' && action === 'protect') {
      if (game.night.guardTarget) fail('本夜已经守护');
      if (!target || target === game.lastGuard) fail('守卫不能连续两夜守护同一人');
      game.night.guardTarget = target;
    } else if (game.status === 'night_gods' && role === 'witch' && action === 'save') {
      if (game.day === 1 && game.night.victim === who) fail('女巫首夜不能自救');
      if (game.uses[who].save || game.night.witchActed || !game.night.victim) fail('本局解药不可用或本夜已用药');
      game.night.saved = true;
      game.night.witchActed = true;
    } else if (game.status === 'night_gods' && role === 'witch' && action === 'poison') {
      if (game.uses[who].poison || game.night.witchActed || !target || target === who) fail('本局毒药不可用或本夜已用药');
      game.night.poisonTarget = target;
      game.night.witchActed = true;
    } else if (game.status === 'hunter' && role === 'hunter' && game.pendingHunter === who && action === 'shoot') {
      if (game.uses[who].shot) fail('猎人已经开枪');
      game.uses[who].shot = true;
      game.pendingHunter = null;
      if (target) game.alive = game.alive.filter(id => id !== target);
      if (target) game.roundDeaths = (game.roundDeaths ?? 0) + 1;
      this.public(game, { kind: 'hunter_shot', hunter: who, target });
      this.afterElimination(game, game.hunterResume === 'day' ? 'day' : 'night');
      return { gameId: game.id, action, target };
    } else fail('当前阶段或身份不能执行此操作', 403);
    this.save(game); this.advanceCompleted(game);
    return { gameId: game.id, action, target, status: game.status };
  }
  checkPhase(game, phase) {
    if (phase !== undefined && (!phase || typeof phase !== 'object' || phase.status !== game.status || phase.day !== game.day || phase.deadlineAt !== game.deadlineAt)) fail('阶段已变化，请重新读取后行动', 409);
  }
  phaseComplete(game) {
    const passed = id => game.night.passed?.includes(id);
    if (game.status === 'night_wolf') return game.alive.filter(id => game.roles[id] === 'wolf')
      .every(id => passed(id) || Object.hasOwn(game.night.wolfVotes ?? {}, id));
    if (game.status === 'night_gods') return game.alive.every(id => {
      if (passed(id)) return true;
      if (game.roles[id] === 'seer') return Boolean(game.night.seerTarget) || game.alive.length < 2;
      if (game.roles[id] === 'guard') return Boolean(game.night.guardTarget) || !game.alive.some(target => target !== game.lastGuard);
      if (game.roles[id] === 'witch') return Boolean(game.night.witchActed)
        || !(!game.uses[id].save && game.night.victim && (game.day > 1 || game.night.victim !== id))
          && (game.uses[id].poison || !game.alive.some(target => target !== id));
      return true;
    });
    if (game.status === 'day') return game.alive.length > 0 && game.alive.every(id => game.dayDone?.includes(id));
    if (game.status === 'vote') return game.alive.length > 0 && game.alive.every(id => Object.hasOwn(game.votes, id));
    return false;
  }
  advanceCompleted(game, now = this.clock()) {
    // A phase with no eligible actions (e.g. all gods dead) must not hold the room.
    // Bound the cascade; entering a new day always waits for explicit end_speech.
    for (let i = 0; i < 6 && this.phaseComplete(game); i++) this.nextPhase(game, now);
  }
  vote(who, args) {
    const game = this.get(args.gameId);
    this.checkPhase(game, args.expectedPhase);
    if (game.left?.includes(who)) fail('你已离开本局房间', 403);
    if (game.kicked?.includes(who)) fail('你已被移出本局', 403);
    if (game.status !== 'vote' || !game.alive.includes(who)) fail('当前不能投票', 403);
    const target = args.target === 'abstain' ? 'abstain' : checkedId(args.target);
    if (target !== 'abstain' && !game.alive.includes(target)) fail('只能投给存活玩家');
    if (Object.hasOwn(game.votes, who)) fail('本轮已经投票');
    game.votes[who] = target; this.save(game);
    this.public(game, { kind: 'vote', voter: who, target });
    if (Object.keys(game.votes).length === game.alive.length) this.resolveVote(game);
    return { gameId: game.id, voted: true };
  }
  resolveVote(game) {
    const counts = {};
    for (const target of Object.values(game.votes)) if (target !== 'abstain') counts[target] = (counts[target] ?? 0) + 1;
    const max = Math.max(0, ...Object.values(counts));
    const top = Object.keys(counts).filter(target => counts[target] === max);
    const eliminated = top.length === 1 ? top[0] : null;
    if (eliminated) { game.alive = game.alive.filter(id => id !== eliminated); game.roundDeaths = (game.roundDeaths ?? 0) + 1; }
    this.public(game, { kind: 'vote_result', votes: game.votes, eliminated, tie: top.length !== 1 });
    game.votes = {};
    if (eliminated && game.roles[eliminated] === 'hunter' && !game.uses[eliminated].shot) this.hunter(game, eliminated);
    else this.afterElimination(game);
  }
  winner(game) {
    const wolves = game.alive.filter(id => game.roles[id] === 'wolf').length;
    return wolves === 0 ? 'village' : wolves >= game.alive.length - wolves ? 'wolves' : null;
  }
  finish(game, winner) {
    game.status = 'finished'; game.winner = winner; game.finishedAt = iso(this.clock()); game.deadlineAt = iso(this.clock() + 2 * 60000); this.save(game);
    for (const who of [...game.participants, ...(game.judgeBotId ? [game.judgeBotId] : [])].filter(id => !game.left?.includes(id))) {
      if (this.store.get('gameBusy', who)?.gameId === game.id) this.store.remove('gameBusy', who);
      this.resumeChat(who);
    }
    this.public(game, { kind: 'finished', winner, roles: game.roles, closeAt: game.deadlineAt });
  }
  afterElimination(game, resume = 'night') {
    const winner = this.winner(game);
    if (winner) return this.finish(game, winner);
    if (resume === 'day') {
      game.status = 'day'; game.dayDone = []; game.deadlineAt = iso(this.clock() + 5 * 60000); this.save(game);
      this.public(game, { kind: 'day', day: game.day, deadlineAt: game.deadlineAt });
      return;
    }
    game.idleRounds = game.roundDeaths ? 0 : (game.idleRounds ?? 0) + 1;
    if (game.day >= 12 || game.idleRounds >= 3) return this.finish(game, 'draw');
    game.day++;
    game.night = {}; game.votes = {}; game.roundDeaths = 0;
    game.status = 'night_wolf'; game.deadlineAt = iso(this.clock() + 3 * 60000); this.save(game);
    this.public(game, { kind: 'night_wolf', day: game.day, deadlineAt: game.deadlineAt });
  }
  hunter(game, who, resume = 'night') {
    game.status = 'hunter'; game.pendingHunter = who; game.hunterResume = resume; game.deadlineAt = iso(this.clock() + 60000); this.save(game);
    this.private(game, who, { kind: 'hunter_prompt', deadlineAt: game.deadlineAt });
    this.public(game, { kind: 'hunter_wait', botId: who, deadlineAt: game.deadlineAt });
  }
  nextPhase(game, now) {
    if (game.status === 'scheduled') return this.beginAtAppointment(game, now);
    if (game.status === 'assigning') { game.assignmentMode = 'random'; this.start(game); return; }
    if (game.status === 'night_wolf') {
      const votes = Object.values(game.night.wolfVotes ?? {}), counts = {};
      for (const target of votes) counts[target] = (counts[target] ?? 0) + 1;
      const max = Math.max(0, ...Object.values(counts)), top = Object.keys(counts).filter(target => counts[target] === max);
      game.night.victim = top.length === 1 ? top[0] : null;
      game.status = 'night_gods'; game.deadlineAt = iso(now + 2 * 60000); this.save(game);
      const witch = game.alive.find(id => game.roles[id] === 'witch');
      if (witch) this.private(game, witch, { kind: 'witch_prompt', victim: game.night.victim,
        saveAvailable: !game.uses[witch].save && Boolean(game.night.victim) && (game.day > 1 || game.night.victim !== witch),
        poisonAvailable: !game.uses[witch].poison, deadlineAt: game.deadlineAt });
      this.public(game, { kind: 'night_gods', day: game.day, deadlineAt: game.deadlineAt });
      return;
    }
    if (game.status === 'night_gods') {
      const witch = game.alive.find(id => game.roles[id] === 'witch'), guard = game.alive.find(id => game.roles[id] === 'guard');
      if (witch && game.night.saved) game.uses[witch].save = true;
      if (witch && game.night.poisonTarget) game.uses[witch].poison = true;
      if (guard) game.lastGuard = game.night.guardTarget ?? null;
      const deaths = [...new Set([game.night.victim && game.night.victim !== game.night.guardTarget && !game.night.saved ? game.night.victim : null,
        game.night.poisonTarget].filter(Boolean))];
      game.alive = game.alive.filter(id => !deaths.includes(id));
      game.roundDeaths = deaths.length;
      this.public(game, { kind: 'dawn', day: game.day, deaths });
      const hunter = deaths.find(id => game.roles[id] === 'hunter' && id !== game.night.poisonTarget && !game.uses[id].shot);
      if (hunter) return this.hunter(game, hunter, 'day');
      const winner = this.winner(game); if (winner) return this.finish(game, winner);
      game.status = 'day'; game.dayDone = []; game.deadlineAt = iso(now + 5 * 60000); this.save(game);
      this.public(game, { kind: 'day', day: game.day, deadlineAt: game.deadlineAt });
      return;
    }
    if (game.status === 'day') {
      game.status = 'vote'; game.votes = {}; game.deadlineAt = iso(now + 2 * 60000); this.save(game);
      this.public(game, { kind: 'vote_open', day: game.day, deadlineAt: game.deadlineAt }); return;
    }
    if (game.status === 'vote') return this.resolveVote(game);
    if (game.status === 'hunter') { game.pendingHunter = null; return this.afterElimination(game, game.hunterResume === 'day' ? 'day' : 'night'); }
    if (game.status === 'finished') {
      game.status = 'closed'; game.deadlineAt = null; this.save(game);
      this.notify([...game.participants, ...(game.judgeBotId ? [game.judgeBotId] : [])], 'game.closed', { gameId: game.id });
    }
  }
  tick(now = this.clock()) {
    const games = this.store.list('games', `kind IN (${ACTIVE.map(() => '?').join(',')})`, ACTIVE, { limit: -1 });
    for (const game of games) {
      if (game.status === 'scheduled' && this.immediate(game)) { this.tryFull(game, now); continue; }
      const start = Date.parse(game.scheduledAt);
      if (game.status === 'scheduled' && !game.reminded && now >= start - 3 * 60000 && now < start) {
        game.reminded = true; this.save(game);
        this.notify([...new Set([...game.joined, ...(game.judgeBotId ? [game.judgeBotId] : [])])],
          'game.reminder', { gameId: game.id, scheduledAt: game.scheduledAt, title: game.title,
            checkinOpenAt: iso(start - 3 * 60000), message: '开局前 3 分钟，请进入本局报到；未报到将自动弃权，不计入本局人数和今日次数。' });
      }
      if (game.deadlineAt && now >= Date.parse(game.deadlineAt)) this.nextPhase(game, now);
      this.advanceCompleted(game, now);
    }
  }
  cancel(who, gameId) {
    const game = this.get(gameId);
    if (game.matching) fail('匹配房间不能由单个玩家取消，请退出自己的匹配');
    if (game.creator !== who || game.status !== 'scheduled') fail('只能由发起人在开局前取消', 403);
    game.status = 'cancelled'; game.deadlineAt = null; this.save(game);
    for (const id of [...game.joined, ...(game.judgeBotId ? [game.judgeBotId] : [])]) this.clearWaiting(id, game.id);
    this.notify([...new Set([...game.invited, ...game.joined, ...(game.judgeBotId ? [game.judgeBotId] : [])])],
      'game.cancelled', { gameId: game.id, reason: '发起人取消预约' });
    return { gameId, cancelled: true };
  }
  suspend(who, keepReservations = false) {
    this.store.remove('gameWaiting', who);
    for(const game of this.store.list('games',`kind IN (${ACTIVE.map(()=>'?').join(',')})`,ACTIVE,{limit:-1})){
      game.spectators=(game.spectators??[]).filter(id=>id!==who);
      if(game.status==='scheduled'){
        if(keepReservations)continue;
        game.joined=game.joined.filter(id=>id!==who);game.checkedIn=game.checkedIn.filter(id=>id!==who);
        if(game.judgeBotId===who){game.judgeAccepted=false;game.judgeCheckedIn=false;}
        this.save(game);continue;
      }
      if(game.status==='finished'){this.save(game);continue;}
      if(who.endsWith('H')&&game.participants.includes(who))game.kicked=[...new Set([...(game.kicked??[]),who])];
      if(game.judgeBotId===who){game.judgeBotId=null;game.judgeMode='program';game.assignmentMode='random';if(game.status==='assigning'){this.start(game);continue;}}
      if(game.alive.includes(who)){
        game.alive=game.alive.filter(id=>id!==who);
        if(game.night?.wolfVotes)delete game.night.wolfVotes[who];if(game.votes)delete game.votes[who];
        if(game.night?.victim===who)game.night.victim=null;
        this.public(game,{kind:'forfeit',botId:who});
        const winner=this.winner(game);if(winner){this.finish(game,winner);continue;}
      }
      if(game.pendingHunter===who){game.pendingHunter=null;this.afterElimination(game,game.hunterResume==='day'?'day':'night');continue;}
      this.save(game);
      this.advanceCompleted(game);
    }
    this.store.remove('gameBusy',who);this.resumeChat(who);
  }
}
