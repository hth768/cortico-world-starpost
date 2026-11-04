import { randomUUID } from 'node:crypto';

const fail = (message, status = 400) => { const error = new Error(message); error.status = status; throw error; };
const clean = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) fail(`${label}不能为空，且最多 ${max} 字`);
  return value.trim();
};

// Reporter identity comes only from the authenticated session. Evidence is loaded
// from server records after an access check, never accepted as client-written text.
export class Safety {
  constructor(store, { isKnown, profile, evidence, owner = () => null, removeFriend = () => {}, clock = Date.now }) {
    Object.assign(this, { store, isKnown, profile, evidence, owner, removeFriend, clock });
  }
  target(who, value) {
    if (typeof value !== 'string' || !/^\d{5,12}H?$/.test(value) || !this.isKnown(value)) fail('目标账号不存在', 404);
    if (value === who) fail('不能对自己执行此操作');
    return value;
  }
  label(who, target) {
    const p = this.profile(target);
    return p.discoverable !== false || this.store.friends(who).includes(target) || this.owner(target) === who ? p.nickname ?? '' : '';
  }
  report(who, args) {
    const target = this.target(who, args.botId), reason = clean(args.reason, 600, '举报原因');
    const evidence = args.evidence == null ? null : this.evidence(who, target, args.evidence);
    const sourceKey = evidence ? `${evidence.type}:${evidence.id}` : 'account';
    const old = this.store.list('safetyReports', "owner=? AND target=? AND kind='pending' AND json_extract(data,'$.sourceKey')=?", [who, target, sourceKey], { limit: 1 })[0];
    if (old) return { reportId: old.id, status: old.status, message: '这项举报已在等待人工审核，请勿重复提交。' };
    const now = this.clock();
    if (this.store.count('safetyReports', 'owner=? AND at>?', [who, new Date(now - 86400000).toISOString()]) >= 10) fail('24 小时内最多提交 10 项举报，请勿重复举报', 429);
    const p = this.profile(target);
    const row = { id: randomUUID(), owner: who, target, reason, sourceKey, evidence,
      targetProfile: { botId: target, nickname: p.nickname ?? '', bio: p.bio ?? '' },
      status: 'pending', at: new Date(now).toISOString() };
    this.store.put('safetyReports', row.id, row);
    return { reportId: row.id, status: row.status, message: '举报已提交，由开发者不定期人工审核；不会因举报次数自动处罚。' };
  }
  reports(who, args = {}) {
    const cursor = args.before ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(cursor) || cursor < 1) fail('分页游标不合法');
    const rows = this.store.statement("SELECT rowid,data FROM documents WHERE collection='safetyReports' AND owner=? AND rowid<? ORDER BY rowid DESC LIMIT 21").all(who, cursor);
    return { items: rows.slice(0, 20).map(({ data }) => {
      const r = JSON.parse(data);
      return { id: r.id, botId: r.target, nickname: this.label(who,r.target), reason: r.reason, status: r.status,
        at: r.at, reviewedAt: r.reviewedAt, reviewNote: r.reviewNote, outcome: r.outcome };
    }), nextBefore: rows.length > 20 ? rows[19].rowid : null };
  }
  reviewList(status = 'pending', before = Number.MAX_SAFE_INTEGER) {
    if (!['pending', 'confirmed', 'dismissed', 'all'].includes(status) || !Number.isSafeInteger(before) || before < 1) fail('审核筛选参数不合法');
    const rows = this.store.statement(`SELECT rowid,data FROM documents WHERE collection='safetyReports' AND rowid<?${status === 'all' ? '' : ' AND kind=?'} ORDER BY rowid DESC LIMIT 51`).all(before, ...(status === 'all' ? [] : [status]));
    return { items: rows.slice(0, 50).map(({ data }) => JSON.parse(data)), nextBefore: rows.length > 50 ? rows[49].rowid : null };
  }
  review(reportId, { decision, note, outcome = 'none', minutes } = {}) {
    const r = this.store.get('safetyReports', reportId);
    if (!r) fail('举报不存在', 404);
    if (r.status !== 'pending') fail('该举报已经审核，不能重复处罚', 409);
    if (!['confirmed', 'dismissed'].includes(decision) || !['none', 'warning', 'mute'].includes(outcome) || decision === 'dismissed' && outcome !== 'none') fail('审核结论或处理方式不合法');
    const reviewNote = clean(note, 600, '审核说明');
    if (outcome === 'mute' && (!Number.isInteger(minutes) || minutes < 1 || minutes > 43200)) fail('禁言时长须为 1–43200 分钟');
    const now = this.clock(), reviewedAt = new Date(now).toISOString();
    const updated = { ...r, status: decision, reviewedAt, reviewNote, outcome };
    if (outcome === 'mute') {
      updated.mutedUntil = Math.max(this.mutedUntil(r.target), now + minutes * 60000);
      this.store.put('safetyMutes', r.target, { until: updated.mutedUntil, reportId, at: reviewedAt });
    }
    this.store.put('safetyReports', reportId, updated);
    this.store.emit([r.owner], 'safety.notice', { reportId, status: decision, note: reviewNote, message: '你提交的举报已有人工审核结果，可主动查看举报记录。' }, reviewedAt);
    if (outcome !== 'none') this.store.put('safetyNotices', randomUUID(), { owner: r.target, outcome, note: reviewNote, until: updated.mutedUntil ?? null, at: reviewedAt });
    if (outcome !== 'none') this.store.emit([r.target], 'safety.notice', { outcome, note: reviewNote, mutedUntil: updated.mutedUntil ?? null, message: outcome === 'mute' ? '管理员已对本账号定时禁言，到期自动恢复发言。' : '管理员向本账号发出一次警告，请注意交流方式。' }, reviewedAt);
    return { reportId, status: decision, outcome, mutedUntil: updated.mutedUntil ?? null };
  }
  mutedUntil(who) { const until = this.store.get('safetyMutes', who)?.until ?? 0; return until > this.clock() ? until : 0; }
  assertCanSpeak(who, action, args = {}) {
    const speaking = ['message.send','owner.send','game.message','human.message','mystery.message','post.publish','post.comment','bottle.throw','bottle.reply','square.showcase','square.promote','poke','owner.poke'].includes(action)
      || action === 'group.manage' && ['announce','mention_all'].includes(args.operation);
    const until = speaking ? this.mutedUntil(who) : 0;
    if (until) fail(`该账号被管理员禁言至 ${new Date(until).toISOString()}；仍可查看消息、举报和进行投票等游戏行动`, 403);
  }
  status(who, botId) {
    return { mutedUntil: this.mutedUntil(who), notices: this.store.list('safetyNotices', 'owner=?', [who], { limit: 10, reverse: true }),
      ...(botId ? { botId: this.target(who, botId), blocked: Boolean(this.store.get('accountBlocks', `${who}:${botId}`)), interactionBlocked: this.blocked(who, botId) } : {}) };
  }
  blocked(a, b) { return Boolean(a && b && (this.store.get('accountBlocks', `${a}:${b}`) || this.store.get('accountBlocks', `${b}:${a}`))); }
  assertContact(a, b) { if (this.blocked(a, b)) fail('双方处于拉黑限制，无法进行此互动', 403); }
  canReadPrivate(who, target) { return this.store.friends(who).includes(target) || Boolean(this.store.get('privateArchives', `${who}:${target}`)); }
  setBlock(who, args, blocked) {
    const target = this.target(who, args.botId), key = `${who}:${target}`;
    if (this.owner(who) === target || this.owner(target) === who) fail('不能拉黑自己绑定的 bot 或所属人类');
    if (!blocked) { this.store.remove('accountBlocks', key); return { botId: target, blocked: false, message: '已解除你的拉黑；不会自动恢复好友关系。' }; }
    if (this.store.get('accountBlocks', key)) return { botId: target, blocked: true };
    if (this.store.count('accountBlocks', 'owner=?', [who]) >= 1000) fail('黑名单最多 1000 个账号', 429);
    const at = new Date(this.clock()).toISOString();
    if (this.store.friends(who).includes(target)) for (const [actor, peer] of [[who,target],[target,who]]) this.store.put('privateArchives', `${actor}:${peer}`, { owner: actor, target: peer, at });
    this.store.put('accountBlocks', key, { owner: who, target, nickname: this.label(who,target), at });
    this.removeFriend(who, target);
    // Clear pending direct contact so an earlier request/message cannot bypass the block.
    const unwanted = (recipient, type, data) => {
      const sender = type === 'message' ? data.sender : ['friend.request','poke'].includes(type) ? data.from : null;
      return sender && ((recipient === who && sender === target) || (recipient === target && sender === who)) && (type !== 'message' || data.kind === 'private');
    };
    for (const row of this.store.statement('SELECT seq,recipient,type,data FROM events WHERE recipient IN (?,?)').all(who,target)) if (unwanted(row.recipient,row.type,JSON.parse(row.data))) this.store.statement('DELETE FROM events WHERE seq=?').run(row.seq);
    for (const collection of ['heldEvents','deferredChat']) for (const row of this.store.statement('SELECT key,data FROM documents WHERE collection=? AND target IN (?,?)').all(collection,who,target)) {const event=JSON.parse(row.data);if(unwanted(event.recipient,event.type??'message',event.data??{}))this.store.remove(collection,row.key);}
    return { botId: target, blocked: true, message: '已拉黑并解除好友；私聊、好友申请和戳一戳已拦截，共同群聊与游戏保留。' };
  }
  blocks(who, args = {}) {
    const cursor = args.before ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(cursor) || cursor < 1) fail('分页游标不合法');
    const rows = this.store.statement("SELECT rowid,data FROM documents WHERE collection='accountBlocks' AND owner=? AND rowid<? ORDER BY rowid DESC LIMIT 21").all(who, cursor);
    return { items: rows.slice(0,20).map(({data}) => { const r=JSON.parse(data);return {botId:r.target,nickname:r.nickname,at:r.at,hasHistory:this.canReadPrivate(who,r.target)}; }), nextBefore: rows.length>20?rows[19].rowid:null };
  }
  merge(from, to) {
    // An old H account may be merged during bot binding. Restrictions follow the
    // new owner, while the saved evidence keeps its historical author identity.
    for (const [key,r] of this.store.entries('accountBlocks')) if(r.owner===from||r.target===from){
      const next={...r,owner:r.owner===from?to:r.owner,target:r.target===from?to:r.target};
      this.store.remove('accountBlocks',key);
      if(next.owner!==next.target)this.store.put('accountBlocks',`${next.owner}:${next.target}`,next);
    }
    for(const collection of ['safetyReports','safetyNotices'])for(const [key,r] of this.store.entries(collection))if(r.owner===from||r.target===from)this.store.put(collection,key,{...r,owner:r.owner===from?to:r.owner,...(r.target?{target:r.target===from?to:r.target}:{})});
    const old=this.store.get('safetyMutes',from);
    if(old&&old.until>this.mutedUntil(to))this.store.put('safetyMutes',to,old);
    this.store.remove('safetyMutes',from);
  }
}
