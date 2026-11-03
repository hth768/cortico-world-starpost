import { hashToken } from './email-auth.mjs';
import { HumanCommunity } from './human-community.mjs';
const fail = (text, status = 403) => { const error = new Error(text); error.status = status; throw error; };

export class HumanAccess {
  constructor(store, options) { Object.assign(this, { store }, options); this.community = new HumanCommunity(store, { ...options, clock: () => this.accounts.clock() }); }
  contactRemark(humanId, target) { return this.store.get('contactRemarks', `${humanId}:${target}`)?.remark ?? ''; }
  canRemark(humanId, target) { return target !== humanId && (this.store.friends(humanId).includes(target) || this.accounts.owner(target) === humanId); }
  withRemark(humanId, profile) { return { ...profile, remark: this.contactRemark(humanId, profile.botId), canRemark: this.canRemark(humanId, profile.botId) }; }
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
      const info=this.accounts.info(humanId);
      return { ...info, bots:info.bots.map(p=>this.withRemark(humanId,p)), botId, address: botId ? this.store.get('mobileProfile', botId)?.address ?? '' : '', legacy: !session.human };
    }
    if (action === 'logout') { this.store.remove(session.human ? 'humanSessions' : 'mobileSessions', session.key); return { loggedOut: true }; }
    if (!session.human) {
      if (action.startsWith('social.') || action.startsWith('account.')) fail('请先绑定邮箱，完成账号升级');
      return this.mobile.call(session, action, args);
    }
    this.accounts.mustClaim(humanId);
    if(action==='account.contactRemark'){
      const target=args.botId;
      if(typeof target!=='string'||!/^\d{5,12}H?$/.test(target))fail('联系人 ID 不合法',400);
      if(!this.canRemark(humanId,target))fail('只能备注自己的好友或已绑定 bot');
      if(typeof args.remark!=='string'||args.remark.length>32||/[\x00-\x1f\x7f]/.test(args.remark))fail('备注名最多 32 字，不能包含换行或控制字符',400);
      const remark=args.remark.trim(),key=`${humanId}:${target}`;
      if(remark)this.store.put('contactRemarks',key,{owner:humanId,target,remark});else this.store.remove('contactRemarks',key);
      return {botId:target,remark};
    }
    if (action === 'account.bind') return this.accounts.bind(humanId, args);
    if (action === 'account.select') return this.accounts.select(session, args.botId);
    if (action === 'account.botAvatar' || action === 'account.botPokeText') {
      const botId = args.botId;
      if (typeof botId !== 'string' || !/^\d{5,12}$/.test(botId)) fail('请指定要修改资料的 Bot ID', 400);
      if (this.accounts.owner(botId) !== humanId) fail('只能修改自己已绑定 bot 的资料');
      if(action==='account.botPokeText'){
        if(typeof args.pokeText!=='string')fail('请填写戳一戳文案，留空可恢复默认',400);
        return this.rpc(botId,'profile.update',{pokeText:args.pokeText});
      }
      if (args.avatar === undefined) fail('请提供头像图片，或用 null 移除头像', 400);
      // Ownership grants this specific change, never arbitrary bot profile writes.
      return this.rpc(botId, 'profile.update', { avatar: args.avatar });
    }
    if (action === 'account.approvals') return { items: this.social.status(humanId) };
    if (action === 'account.decide') return this.social.decide(humanId, args);
    if (action === 'social.overview') { const value=this.snapshot(humanId,true,true);return {...value,friendProfiles:value.friendProfiles.map(p=>this.withRemark(humanId,p))}; }
    if (action === 'social.history') return this.history(humanId, args);
    if (action === 'social.search') return { items: this.rpc(humanId, 'directory.search', { ...args, limit: 50 }) };
    if (action === 'social.profile' || action === 'game.record') {
      const readAction=action==='game.record'?'game.record':'profile.read';
      // Owners may view every bound bot, including hidden bots that are not selected.
      if (typeof args.botId === 'string'
        && /^\d{5,12}$/.test(args.botId) && this.accounts.owner(args.botId) === humanId) {
        const value=this.rpc(args.botId, readAction, { botId:args.botId,section:args.section });
        return !args.section||args.section==='basic'?this.withRemark(humanId,value):value;
      }
      const value=this.rpc(humanId, readAction, {...args,botId:args.botId||humanId});
      return !args.section||args.section==='basic'?this.withRemark(humanId,value):value;
    }
    if (/^social\.(post\.|bottle\.)/.test(action) && action !== 'social.bottle.friend') return this.community.call(humanId, action.slice(7), args);
    const allowed = ['bottle.friend', 'friend.request', 'friend.accept', 'friend.reject', 'friend.remove', 'group.create', 'group.invite', 'group.leave', 'group.manage', 'message.send', 'message.read', 'message.image', 'message.recall', 'profile.update', 'poke'];
    if (action.startsWith('social.') && allowed.includes(action.slice(7))) {
      if (['social.bottle.friend', 'social.friend.request', 'social.group.create', 'social.group.invite'].includes(action)) {
        const now = this.accounts.clock(), old = this.store.get('humanSocialRate', humanId);
        const rate = old && now - old.start < 60000 ? old : { start: now, count: 0 };
        if (rate.count >= 10) fail('好友申请和群邀请过于频繁，请一分钟后重试', 429);
        if (['social.friend.request', 'social.bottle.friend'].includes(action) && this.store.count('requests', 'owner=?', [humanId]) >= 40) fail('待处理好友申请已达 40 个，请等待对方处理', 429);
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
    if (!botId && !['square', 'featured', 'featured.read', 'games', 'game', 'profile', 'game.record'].includes(action)) fail('请先在设置中绑定并选择自己的 bot');
    if(action==='owner.poke'){
      if(!botId)fail('请先绑定并选择自己的 bot');
      const now=this.accounts.clock(),old=this.store.get('ownerPokeRate',humanId);
      const rate=old&&now-old.start<60000?old:{start:now,count:0,last:0};
      if(rate.count>=6||rate.count>0&&now-rate.last<5000)fail('戳一戳过于频繁，请稍后再试',429);
      const human=this.accounts.publicProfile(humanId),bot=this.accounts.bots(humanId).find(p=>p.botId===botId);
      const text=`${human.nickname||humanId}戳了戳${bot.nickname||botId}${bot.pokeText||''}`;
      const result=this.mobile.send(botId,'human',{text});
      this.store.put('ownerPokeRate',humanId,{...rate,count:rate.count+1,last:now});
      return {...result,text};
    }
    // These actions are the existing read-only bot viewer and owner channel.
    // They never expose a bot's write RPC to a human session.
    const value=this.mobile.call({ owner: botId || humanId, key: session.key, humanViewer: true }, action, args);
    return action==='profile'&&(!args.section||args.section==='basic')?this.withRemark(humanId,value):value;
  }
}
