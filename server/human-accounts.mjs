import { randomBytes } from 'node:crypto';
import { AuthThrottle, EmailVerification, emailAddress, hashToken, humanNickname, passwordHash, passwordMatches } from './email-auth.mjs';

const fail = (text, status = 400) => { const error = new Error(text); error.status = status; throw error; };
export const isHumanId = value => typeof value === 'string' && /^\d{5,12}H$/.test(value) && Number(value.slice(0, -1)) >= 10001;

export class HumanAccounts {
  constructor(store, { knownIds, botLogin, botProfile, secret, sendMail, clock = Date.now }) {
    Object.assign(this, { store, botLogin, botProfile, clock });
    this.throttle = new AuthThrottle(store, clock);
    this.verification = new EmailVerification(store, { secret, sendMail, clock });
    this.kdfBusy = 0;
    store.transaction(() => {
      if (!store.get('meta', 'humanAccountsMigrated')) {
        for (const botId of knownIds()) {
          const humanId = `${botId}H`;
          if (!store.get('people', humanId)) store.put('people', humanId, { humanId, nickname: store.get('humanProfiles', botId)?.nickname || '匿名人类', email: null, epoch: 1, legacy: true, createdAt: new Date(clock()).toISOString() });
          if (!store.get('botOwners', botId)) store.put('botOwners', botId, { botId, humanId });
        }
        store.put('meta', 'humanAccountsMigrated', true);
      }
      const highest = Math.max(10000, ...store.entries('people').map(([id]) => Number(id.slice(0, -1))));
      store.put('meta', 'nextHumanId', Math.max(highest + 1, store.get('meta', 'nextHumanId') ?? 10001));
    });
  }
  canonical(id) {
    const visited = new Set();
    while (true) {
      if (!isHumanId(id) || visited.has(id)) fail('人类账号不存在', 404);
      visited.add(id);
      const account = this.store.get('people', id);
      if (!account) fail('人类账号不存在', 404);
      if (!account.aliasOf) return id;
      id = account.aliasOf;
    }
  }
  person(id) { return this.store.get('people', this.canonical(id)); }
  exists(id) { return isHumanId(id) && Boolean(this.store.get('people', id)); }
  owner(botId) { const link = this.store.get('botOwners', botId); return link ? this.canonical(link.humanId) : null; }
  claimedOwner(botId) { const owner = this.owner(botId); return owner && this.person(owner).email ? owner : null; }
  aliases(id) {
    const owner = this.canonical(id);
    return [owner, ...this.store.statement("SELECT key FROM documents WHERE collection='people' AND target=? ORDER BY rowid").all(owner).map(row => row.key)];
  }
  bots(id) {
    return this.aliases(id).flatMap(owner => this.store.statement("SELECT key FROM documents WHERE collection='botOwners' AND owner=? ORDER BY rowid").all(owner))
      .map(({ key }) => ({ ...this.botProfile(key), botId: key }));
  }
  publicProfile(id) { const p = this.person(id); return { humanId: p.humanId, botId: p.humanId, nickname: p.nickname, avatarVersion:p.avatarVersion??'', pokeText:p.pokeText??'', bio: p.bio ?? '', discoverable: true, accountType: 'human' }; }
  info(id) {
    const p = this.person(id);
    return { humanId: p.humanId, nickname: p.nickname, avatarVersion:p.avatarVersion??'', pokeText:p.pokeText??'', email: p.email ?? '', needsEmail: !p.email, bots: this.bots(id), aliases: this.aliases(id), friendLimit: 200, groupLimit: 50 };
  }
  mustClaim(id) { const p = this.person(id); if (!p.email) fail('请先绑定邮箱，完成账号升级', 403); return p; }
  allocate(email, nickname, password) {
    if (this.store.get('emailOwners', email)) fail('该邮箱已有账号，请直接登录', 409);
    const next = this.store.get('meta', 'nextHumanId'), humanId = `${next}H`;
    if (!isHumanId(humanId) || this.store.get('people', humanId)) fail('人类账号号段异常', 503);
    this.store.put('meta', 'nextHumanId', next + 1);
    this.store.put('people', humanId, { humanId, nickname, email, password, epoch: 1, createdAt: new Date(this.clock()).toISOString() });
    this.store.put('emailOwners', email, { humanId });
    this.store.put('humanProfiles', String(next), { nickname });
    return this.issue(humanId);
  }
  issue(id, selectedBotId) {
    const p = this.person(id), token = randomBytes(32).toString('hex'), key = hashToken(token), expiresAt = this.clock() + 14 * 86400000;
    const bots = this.bots(id);
    if (!bots.some(b => b.botId === selectedBotId)) selectedBotId = bots[0]?.botId ?? '';
    this.store.statement("DELETE FROM documents WHERE collection='humanSessions' AND at<=?").run(new Date(this.clock()).toISOString());
    const sessions = this.store.list('humanSessions', 'owner=?', [p.humanId], { limit: -1 });
    for (const old of sessions.slice(0, Math.max(0, sessions.length - 4))) this.store.remove('humanSessions', old.key);
    this.store.put('humanSessions', key, { key, owner: p.humanId, epoch: p.epoch, selectedBotId, expiresAt, at: new Date(expiresAt).toISOString() });
    return { ...this.info(id), botId: selectedBotId, accessToken: token, expiresAt };
  }
  authenticate(header) {
    const token = header?.replace(/^Bearer /, '');
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail('请重新登录', 401);
    const session = this.store.get('humanSessions', hashToken(token));
    if (!session || session.expiresAt <= this.clock()) fail('登录已过期，请重新登录', 401);
    const p = this.person(session.owner);
    if (p.humanId !== session.owner || p.epoch !== session.epoch) fail('账号已变更，请重新登录', 401);
    return { ...this.selectFirstIfEmpty(session), human: true };
  }
  selectFirstIfEmpty(session) {
    if (session.selectedBotId) return session;
    const botId = this.bots(session.owner)[0]?.botId;
    if (!botId) return session;
    const selected = { ...session, selectedBotId: botId };
    this.store.put('humanSessions', session.key, selected);
    return selected;
  }
  async kdf(work) {
    if (this.kdfBusy >= 2) fail('登录服务繁忙，请稍后重试', 429);
    this.kdfBusy++;
    try { return await work(); } finally { this.kdfBusy--; }
  }
  async auth(action, input, remote, legacyHumanId) {
    if (!input || typeof input !== 'object') fail('请求格式不合法');
    if (action === 'code') {
      const purpose = input.purpose;
      if (purpose === 'claim') {
        if (!legacyHumanId || this.person(legacyHumanId).email) fail('请先使用旧 bot 凭据进入待升级账号', 403);
      }
      return this.verification.send({ ...input, subject: purpose === 'claim' ? this.canonical(legacyHumanId) : '', remote });
    }
    const email = emailAddress(input.email);
    this.throttle.take([[`auth:ip:${remote}`, 30, 60000], [`auth:email:${email}`, 20, 3600000]]);
    if (action === 'register') {
      const nickname = humanNickname(input.nickname), password = await this.kdf(() => passwordHash(input.password));
      return this.verification.consume({ ...input, email, purpose: 'register', remote }, verified => this.allocate(verified, nickname, password));
    }
    if (action === 'claim') {
      if (!legacyHumanId) fail('请先验证旧 bot 凭据', 401);
      const subject = this.canonical(legacyHumanId), nickname = humanNickname(input.nickname), password = await this.kdf(() => passwordHash(input.password));
      return this.verification.consume({ ...input, email, purpose: 'claim', subject, remote }, verified => {
        const p = this.person(subject);
        if (p.email) fail('该账号已绑定邮箱，请使用邮箱登录', 409);
        if (this.store.get('emailOwners', verified)) fail('该邮箱已有账号，请登录后在设置中绑定这个 bot', 409);
        this.store.put('people', subject, { ...p, email: verified, nickname, password, epoch: p.epoch + 1 });
        this.store.put('emailOwners', verified, { humanId: subject });
        this.store.put('humanProfiles', subject.slice(0, -1), { nickname });
        this.revokeLegacy(subject);
        return this.issue(subject);
      });
    }
    if (action === 'login') {
      const link = this.store.get('emailOwners', email), p = link && this.person(link.humanId);
      if (input.method === 'code') return this.verification.consume({ ...input, email, purpose: 'login', remote }, () => {
        if (!p) fail('邮箱或验证信息不正确', 401);
        return this.issue(p.humanId);
      });
      if (input.method !== 'password') fail('请选择密码或验证码登录');
      if (!await this.kdf(() => passwordMatches(input.password, p?.password)) || !p) fail('邮箱或密码不正确', 401);
      return this.store.transaction(() => {
        if (this.person(p.humanId).password !== p.password) fail('账号已变更，请重新登录', 401);
        return this.issue(p.humanId);
      });
    }
    fail('不支持的账号操作');
  }
  revokeLegacy(id) {
    for (const { botId } of this.bots(id)) this.store.statement("DELETE FROM documents WHERE collection='mobileSessions' AND owner=?").run(botId);
  }
  bind(id, args) {
    const p = this.mustClaim(id), bot = this.botLogin({ identifier: args.botId, token: args.credential }), previous = this.owner(bot.botId);
    if (previous && previous !== p.humanId) {
      const old = this.person(previous);
      if (old.email) fail('该 bot 已绑定其他邮箱账号，不能重复绑定', 409);
      // Keep the legacy H identifier and all game history as an alias; no ID rewriting.
      this.store.put('people', previous, { ...old, aliasOf: p.humanId, epoch: old.epoch + 1 });
      this.store.statement("UPDATE documents SET owner=?,data=json_set(data,'$.author',?) WHERE collection='capsules' AND owner=?").run(p.humanId,p.humanId,previous);
      this.store.statement("DELETE FROM documents WHERE collection='humanSessions' AND owner=?").run(previous);
    }
    this.store.put('botOwners', bot.botId, { botId: bot.botId, humanId: p.humanId });
    this.revokeLegacy(p.humanId);
    return { ...this.info(p.humanId), boundBotId: bot.botId };
  }
  select(session, botId) {
    if (!this.bots(session.owner).some(b => b.botId === botId)) fail('该 bot 未绑定你的账号', 403);
    this.store.put('humanSessions', session.key, { ...session, selectedBotId: botId });
    return { botId };
  }
  prune() {
    const now = new Date(this.clock()).toISOString(), cutoff = new Date(this.clock() - 30 * 86400000).toISOString();
    this.store.statement("DELETE FROM documents WHERE collection IN ('emailChallenges','authRates','humanSessions','humanCommunityRate') AND at<=?").run(now);
    this.store.statement("UPDATE documents SET kind='expired',data=json_set(data,'$.status','expired') WHERE collection='socialApprovals' AND kind='pending' AND json_extract(data,'$.expiresAt')<=?").run(this.clock());
    this.store.statement("DELETE FROM documents WHERE collection='socialApprovals' AND kind<>'pending' AND at<?").run(cutoff);
  }
}
