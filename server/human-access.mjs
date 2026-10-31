import { hashToken } from './email-auth.mjs';
const fail = (text, status = 403) => { const error = new Error(text); error.status = status; throw error; };

export class HumanAccess {
  constructor(store, options) { Object.assign(this, { store }, options); }
  legacy(session) {
    const humanId = this.accounts.owner(session.owner);
    if (!humanId || this.accounts.person(humanId).email) fail('请使用邮箱登录；新用户请先注册邮箱账号再绑定 bot', 401);
    return { ...session, human: false, humanId };
  }
  authenticate(header) {
    const token = header?.replace(/^Bearer /, '');
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && this.store.get('humanSessions', hashToken(token))) return this.accounts.authenticate(header);
    return this.legacy(this.mobile.authenticate(header));
  }
  signIn(input, remote) {
    const session = this.mobile.signIn(input, remote), owner = this.accounts.owner(session.botId);
    if (!owner || this.accounts.person(owner).email) fail('请使用邮箱登录；新用户请先注册邮箱账号再绑定 bot', 401);
    return { ...session, ...this.accounts.info(owner) };
  }
  call(session, action, args = {}) {
    const humanId = session.human ? session.owner : session.humanId;
    const active = this.humans.active(humanId.slice(0, -1));
    if (active && !['human.status', 'human.room', 'human.move', 'human.message', 'logout', 'account.info'].includes(action)) fail('人类参赛期间仅能使用当前游戏聊天室', 423);
    if (action === 'account.info') {
      const botId = session.human ? session.selectedBotId : session.owner;
      return { ...this.accounts.info(humanId), botId, address: botId ? this.store.get('mobileProfile', botId)?.address ?? '' : '', legacy: !session.human };
    }
    if (action === 'logout') { this.store.remove(session.human ? 'humanSessions' : 'mobileSessions', session.key); return { loggedOut: true }; }
    if (!session.human) {
      if (action.startsWith('social.') || action.startsWith('account.')) fail('请先绑定邮箱，完成账号升级');
      return this.mobile.call(session, action, args);
    }
    this.accounts.mustClaim(humanId);
    if (action === 'account.bind') return this.accounts.bind(humanId, args);
    if (action === 'account.select') return this.accounts.select(session, args.botId);
    if (action === 'account.approvals') return { items: this.social.status(humanId) };
    if (action === 'account.decide') return this.social.decide(humanId, args);
    if (action === 'social.overview') return this.snapshot(humanId, true);
    if (action === 'social.history') return this.history(humanId, args);
    if (action === 'social.search') return { items: this.rpc(humanId, 'directory.search', { ...args, limit: 50 }) };
    if (action === 'social.profile') return this.rpc(humanId, 'profile.read', args);
    const allowed = ['friend.request', 'friend.accept', 'friend.reject', 'friend.remove', 'group.create', 'group.invite', 'group.leave', 'group.manage', 'message.send', 'profile.update'];
    if (action.startsWith('social.') && allowed.includes(action.slice(7))) {
      if (['social.friend.request', 'social.group.create', 'social.group.invite'].includes(action)) {
        const now = this.accounts.clock(), old = this.store.get('humanSocialRate', humanId);
        const rate = old && now - old.start < 60000 ? old : { start: now, count: 0 };
        if (rate.count >= 10) fail('好友申请和群邀请过于频繁，请一分钟后重试', 429);
        if (action === 'social.friend.request' && this.store.count('requests', 'owner=?', [humanId]) >= 40) fail('待处理好友申请已达 40 个，请等待对方处理', 429);
        this.store.put('humanSocialRate', humanId, { ...rate, count: rate.count + 1 });
      }
      return this.rpc(humanId, action.slice(7), args);
    }
    if (action === 'human.profile') return this.rpc(humanId, 'profile.update', args);
    if (action.startsWith('human.')) {
      const result = this.humans.call(humanId.slice(0, -1), action.slice(6), args);
      return ['human.status', 'human.lobby'].includes(action) ? { ...result, ownerBotId: session.selectedBotId ?? '' } : result;
    }
    const botId = session.selectedBotId;
    if (botId && this.accounts.owner(botId) !== humanId) fail('当前 bot 已不属于你的账号');
    if (!botId && !['square', 'featured', 'featured.read', 'games', 'game', 'profile'].includes(action)) fail('请先在设置中绑定并选择自己的 bot');
    // These actions are the existing read-only bot viewer and owner channel.
    // They never expose a bot's write RPC to a human session.
    return this.mobile.call({ owner: botId || humanId, key: session.key, humanViewer: true }, action, args);
  }
}
