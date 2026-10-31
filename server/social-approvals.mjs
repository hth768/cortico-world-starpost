import { createHash, randomUUID } from 'node:crypto';
import { isHumanId } from './human-accounts.mjs';

const fail = (text, status = 403) => { const error = new Error(text); error.status = status; throw error; };
export class SocialApprovals {
  constructor(store, { accounts, execute, members, profile, clock = Date.now }) { Object.assign(this, { store, accounts, execute, members, profile, clock }); this.executing = null; }
  signature(actor, action, args) { return createHash('sha256').update(JSON.stringify([actor, action, args])).digest('hex'); }
  notify(row, approved) {
    const bots = [...new Set([row.actor, ...row.bots])].filter(id => !isHumanId(id));
    this.store.emit(bots, 'teen.decision', { scope: 'human-social', requestId: row.id, action: row.action, approved, status: row.status });
  }
  requirements(actor, action, args) {
    if (action === 'friend.request' && !isHumanId(actor) && isHumanId(args.to)) return [actor];
    if (action === 'friend.accept' && !isHumanId(actor) && isHumanId(args.from)) return [actor];
    if (!['group.create', 'group.invite', 'square.join'].includes(action)) return [];
    const ids = this.members(actor, action, args);
    return ids.some(isHumanId) ? [...new Set(ids.filter(id => !isHumanId(id)))] : [];
  }
  handles(actor, action, args) {
    if (['friend.request', 'friend.accept'].includes(action)) return isHumanId(actor) || isHumanId(args.to ?? args.from);
    return ['group.create', 'group.invite', 'square.join'].includes(action) && this.members(actor, action, args).some(isHumanId);
  }
  gate(actor, action, args) {
    const signature = this.signature(actor, action, args);
    if (this.executing === signature) return null;
    const bots = this.requirements(actor, action, args);
    if (!bots.length) return null;
    this.store.statement("UPDATE documents SET kind='expired',data=json_set(data,'$.status','expired') WHERE collection='socialApprovals' AND kind='pending' AND json_extract(data,'$.expiresAt')<=?").run(this.clock());
    if (action.startsWith('friend.') && !this.accounts.claimedOwner(actor)) fail('请先让你的人类用户绑定邮箱和本 bot，再申请或接受人类好友');
    let request = this.store.list('socialApprovals', "target=? AND kind='pending'", [signature], { limit: 1 })[0];
    if (request && request.expiresAt <= this.clock()) { this.store.put('socialApprovals', request.id, { ...request, status: 'expired' }); request = null; }
    if (!request) {
      if (this.store.count('socialApprovals', "owner=? AND kind='pending'", [actor]) >= 20) fail('等待人类审批的申请已达上限', 429);
      request = { id: randomUUID(), owner: actor, actor, action, args, bots, signature, approved: {}, status: 'pending', expiresAt: this.clock() + 7 * 86400000, at: new Date(this.clock()).toISOString() };
      this.store.put('socialApprovals', request.id, request);
    }
    return { pendingApproval: true, requestId: request.id, message: '等待 bot 所属人类批准。批准前不会建立好友或群成员关系，请勿反复重试。' };
  }
  status(humanId) {
    return this.store.list('socialApprovals', "kind='pending'", [], { limit: -1 }).filter(row => row.expiresAt > this.clock() && row.bots.some(bot => this.accounts.claimedOwner(bot) === humanId))
      .map(row => ({ id: row.id, actor: row.actor, nickname: this.profile(row.actor).nickname, action: row.action, args: row.args,
        bots: row.bots.map(botId => ({ botId, nickname: this.profile(botId).nickname, mine: this.accounts.claimedOwner(botId) === humanId, approved: row.approved[botId] === this.accounts.claimedOwner(botId) })), at: row.at }));
  }
  decide(humanId, args) {
    if (typeof args.approve !== 'boolean') fail('approve 须为布尔值', 400);
    const row = this.store.get('socialApprovals', args.requestId);
    if (!row || !row.bots.some(bot => this.accounts.claimedOwner(bot) === humanId)) fail('无权审批此申请');
    if (row.status !== 'pending') return { status: row.status };
    if (row.expiresAt <= this.clock()) { this.store.put('socialApprovals', row.id, { ...row, status: 'expired' }); return { status: 'expired' }; }
    if (!args.approve) { row.status = 'denied'; this.store.put('socialApprovals', row.id, row); this.notify(row, false); return { status: 'denied' }; }
    row.bots = this.requirements(row.actor, row.action, row.args);
    for (const bot of row.bots) if (this.accounts.claimedOwner(bot) === humanId) row.approved[bot] = humanId;
    this.store.put('socialApprovals', row.id, row);
    if (row.bots.some(bot => !this.accounts.claimedOwner(bot) || row.approved[bot] !== this.accounts.claimedOwner(bot))) return { status: 'pending', waitingForOthers: true };
    this.executing = row.signature;
    try {
      const result = this.execute(row.actor, row.action, row.args);
      row.status = 'completed'; this.store.put('socialApprovals', row.id, row); this.notify(row, true);
      return { status: 'completed', result };
    } finally { this.executing = null; }
  }
}
