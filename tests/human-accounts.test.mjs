import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStarpostServer } from '../server/server.mjs';
import { passwordHash, passwordMatches } from '../server/email-auth.mjs';
import { smtpMailer } from '../server/mail.mjs';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'starpost-people-')), keys = { 10001: 'a'.repeat(32), 10002: 'b'.repeat(32), 10003: 'c'.repeat(32) }, mails = [];
  let now = Date.parse('2026-11-01T18:00:00+08:00');
  const app = createStarpostServer({ file: join(directory, 'relay.json'), keys, port: 0, clock: () => now, sendMail: async mail => mails.push(mail) });
  await app.listen();const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, value, token = '', botId = '', headers = {}) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(botId ? { 'x-starpost-id': botId } : {}), ...headers }, body: JSON.stringify(value) });
    return { status: r.status, headers: r.headers, ...await r.json() };
  };
  const rpc = (token, action, args = {}) => post('/mobile/rpc', { action, args }, token);
  const bot = (id, action, args = {}, limits) => post('/rpc', { action, args, limits }, keys[id], id);
  const sendCode = async (email, purpose = 'register', token = '') => {
    const result = await post('/mobile/auth', { action: 'code', email, purpose }, token);
    assert.equal(result.ok, true, result.error);
    return { challengeId: result.result.challengeId, code: mails.at(-1).code };
  };
  const register = async email => {
    const verification = await sendCode(email);
    const r = await post('/mobile/auth', { action: 'register', email, nickname: '相同昵称', password: 'example-pass-123', ...verification });
    assert.equal(r.ok, true, r.error); return r.result;
  };
  const claim = async (botId, email) => {
    const old = await post('/mobile/login', { botId, credential: keys[botId] });assert.equal(old.ok, true, old.error);
    const verification = await sendCode(email, 'claim', old.result.accessToken);
    const r = await post('/mobile/auth', { action: 'claim', email, nickname: '旧账号昵称', password: 'example-pass-123', ...verification }, old.result.accessToken);
    assert.equal(r.ok, true, r.error); return { ...r.result, legacyToken: old.result.accessToken };
  };
  return { directory, app, mails, keys, post, rpc, bot, sendCode, register, claim, base, advance(ms) { now += ms; }, async close() { await app.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('密码加盐哈希，SMTP 要求加密和证书验证，不读取邮件中的文件或远程资源', async () => {
  const a = await passwordHash('correct-password'), b = await passwordHash('correct-password');assert.notEqual(a, b);
  assert.equal(await passwordMatches('correct-password', a), true);assert.equal(await passwordMatches('wrong', a), false);assert.equal(await passwordMatches('guess', undefined), false);
  let config, envelope;
  const send = smtpMailer({ host: 'smtp.example.com', port: 587, user: 'sender', password: 'private', from: 'mail@example.com' }, c => { config = c;return { sendMail: async e => { envelope = e;return { accepted: ['recipient'] }; } }; });
  await send({ to: 'person@example.com', code: '0042', purpose: 'register' });
  assert.equal(config.requireTLS, true);assert.equal(config.tls.rejectUnauthorized, true);assert.equal(config.disableFileAccess, true);assert.match(envelope.text, /0042/);
  assert.throws(() => smtpMailer({ host: 'smtp', port: 25 }), /配置不完整/);
});

test('独立 H 号顺延，支持重名及分页搜索，注册不使用 bot 名额；14 天会话不滑动续期', async () => {
  const f = await fixture();try {
    const a = await f.register('a@example.com'), b = await f.register('b@example.com');
    assert.equal(a.humanId, '10004H');assert.equal(b.humanId, '10005H');assert.equal(a.botId, '');assert.equal(f.app.store.count('accounts'), 0);
    assert.equal(f.app.store.get('meta', 'nextBotId'), 10004);
    const registeredBot = await f.post('/register', { installationId: randomUUID(), token: 'd'.repeat(64) });assert.equal(registeredBot.result.botId, '10004');
    const people = (await f.rpc(a.accessToken, 'social.search', { query: '相同昵称' })).result.items;
    assert.deepEqual(people.map(p => p.botId), ['10005H']);
    assert.equal((await f.rpc(a.accessToken, 'social.search', { query: '10005h' })).result.items[0].botId, '10005H');
    assert.equal((await f.rpc(a.accessToken, 'owner.send', { text: 'no bot' })).status, 403);
    assert.equal((await f.rpc(a.accessToken, 'human.status')).result.humanId, '10004H');
    const login = await f.post('/mobile/auth', { action: 'login', method: 'password', email: 'A@example.com', password: 'example-pass-123' });assert.equal(login.result.humanId, a.humanId);
    assert.equal((await f.post('/mobile/auth', { action: 'login', method: 'password', email: 'A@example.com', password: 'bad' })).status, 401);
    f.advance(61000);const code = await f.sendCode('a@example.com', 'login');
    assert.equal((await f.post('/mobile/auth', { action: 'login', method: 'code', email: 'a@example.com', ...code })).result.humanId, a.humanId);
    f.advance(14 * 86400000);assert.equal((await f.rpc(a.accessToken, 'account.info')).status, 401);
  } finally { await f.close(); }
});

test('四位验证码不能跨用途或重复使用，五次失败后锁定；失败计数不会随请求回滚', async () => {
  const f = await fixture();try {
    const v = await f.sendCode('codes@example.com');assert.match(v.code, /^\d{4}$/);
    const wrong = v.code === '0000' ? '0001' : '0000';
    for(let i=0;i<5;i++) assert.equal((await f.post('/mobile/auth', { action: 'register', email: 'codes@example.com', password: 'example-pass-123', nickname: '甲', challengeId: v.challengeId, code: wrong })).ok, false);
    assert.equal((await f.post('/mobile/auth', { action: 'register', email: 'codes@example.com', password: 'example-pass-123', nickname: '甲', ...v })).ok, false);
    assert.equal(f.app.store.list('emailChallenges')[0].attempts, 5);
    assert.equal((await f.post('/mobile/auth', { action: 'code', email: 'codes@example.com', purpose: 'register' })).status, 429);
    f.advance(61000);const again = await f.sendCode('codes@example.com');
    const data = { action: 'register', email: 'codes@example.com', password: 'example-pass-123', nickname: '甲', ...again };
    assert.equal((await f.post('/mobile/auth', { ...data, action: 'login', method: 'code' })).ok, false);
    assert.equal((await f.post('/mobile/auth', data)).ok, true);assert.equal((await f.post('/mobile/auth', data)).ok, false);
    f.advance(61000);const expired = await f.sendCode('expired@example.com');f.advance(300000);
    assert.equal((await f.post('/mobile/auth', { ...data, email: 'expired@example.com', ...expired })).ok, false);
    assert.equal(f.app.store.entries('people').some(([, p]) => p.password === 'example-pass-123'), false);
  } finally { await f.close(); }
});

test('旧 H 号补绑邮箱、合并无邮箱旧账号与多个 bot，拒绝抢绑已有邮箱的账号', async () => {
  const f = await fixture();try {
    const a = await f.claim('10001', 'old@example.com');assert.equal(a.humanId, '10001H');assert.deepEqual(a.bots.map(b=>b.botId), ['10001']);
    assert.equal((await f.rpc(a.legacyToken, 'overview')).status, 401);
    assert.equal((await f.post('/mobile/login', { botId: '10001', credential: f.keys['10001'] })).status, 401);
    assert.equal((await f.rpc(a.accessToken, 'account.bind', { botId: '10002', credential: f.keys['10002'] })).ok, true);
    assert.equal(f.app.store.get('people', '10002H').aliasOf, '10001H');
    const info = (await f.rpc(a.accessToken, 'account.info')).result;assert.deepEqual(info.bots.map(b=>b.botId), ['10001', '10002']);
    const b = await f.claim('10003', 'other@example.com');
    assert.equal((await f.rpc(b.accessToken, 'account.bind', { botId: '10001', credential: f.keys['10001'] })).status, 409);
    assert.equal((await f.rpc(b.accessToken, 'account.select', { botId: '10002' })).status, 403);
    assert.equal((await f.rpc(a.accessToken, 'account.select', { botId: '10002' })).ok, true);
    assert.equal((await f.rpc(a.accessToken, 'owner.address', { address: '主人' })).ok, true);
    assert.equal((await f.rpc(a.accessToken, 'owner.send', { text: 'hello bot 2' })).ok, true);
    assert.equal(f.app.store.list('ownerMessages')[0].botId, '10002');
    assert.equal((await f.rpc(a.accessToken, 'message.send', { kind: 'private', target: '10003', text: 'impersonate' })).status, 403);
  } finally { await f.close(); }
});

test('人类好友备注、拒绝/接受、私聊图片与群聊：不占 bot 额度，仍限制防刷和越权读取', async () => {
  const f = await fixture();try {
    const a = await f.register('sociala@example.com'), b = await f.register('socialb@example.com');
    assert.equal((await f.rpc(a.accessToken, 'social.friend.request', { to: b.humanId, note: '一起聊天吧' })).ok, true);
    assert.equal((await f.rpc(b.accessToken, 'social.overview')).result.requests[0].note, '一起聊天吧');
    assert.equal((await f.rpc(b.accessToken, 'social.friend.reject', { from: a.humanId })).ok, true);
    await f.rpc(a.accessToken, 'social.friend.request', { to: b.humanId });
    assert.equal((await f.rpc(b.accessToken, 'social.friend.accept', { from: a.humanId })).ok, true);
    const group = await f.rpc(a.accessToken, 'social.group.create', { name: '人类群', members: [b.humanId] });assert.equal(group.ok, true, group.error);
    f.app.store.put('limits', a.humanId, { maxMessagesPerDay: 0 });
    for(let i=0;i<30;i++)assert.equal((await f.rpc(a.accessToken, 'social.message.send', { kind: i%2?'private':'group', target: i%2?b.humanId:group.result.id, text: `hello ${i}` })).ok, true);
    assert.equal((await f.rpc(a.accessToken, 'social.message.send', { kind:'private',target:b.humanId,text:'too fast' })).status,429);
    assert.equal((await f.rpc(b.accessToken, 'social.history', { kind:'private',target:a.humanId })).result.messages.length,15);
    assert.equal((await f.rpc(b.accessToken, 'social.history', { kind:'private',target:'10001' })).status,403);
    assert.equal((await f.rpc(a.accessToken, 'social.friend.remove', { botId:b.humanId })).ok,true);
    assert.equal((await f.rpc(a.accessToken, 'social.message.send', { kind:'private',target:b.humanId,text:'removed' })).ok,false);
  } finally { await f.close(); }
});

test('人类加 bot：bot 决定后再给主人审批；bot 加人类：主人批准后才发送好友申请', async () => {
  const f = await fixture();try {
    const owner = await f.claim('10001','owner@example.com'), stranger = await f.register('stranger@example.com');
    await f.rpc(stranger.accessToken,'social.friend.request',{to:'10001',note:'来自人类'});
    assert.equal((await f.rpc(owner.accessToken,'account.approvals')).result.items.length,0);
    const accepted = await f.bot('10001','friend.accept',{from:stranger.humanId});assert.equal(accepted.result.pendingApproval,true);assert.equal(f.app.store.friends('10001').length,0);
    assert.equal((await f.rpc(stranger.accessToken,'account.decide',{requestId:accepted.result.requestId,approve:true})).status,403);
    assert.equal((await f.rpc(owner.accessToken,'account.decide',{requestId:accepted.result.requestId,approve:true})).result.status,'completed');assert.equal(f.app.store.friends('10001').includes(stranger.humanId),true);
    await f.rpc(stranger.accessToken,'social.friend.remove',{botId:'10001'});
    const request = await f.bot('10001','friend.request',{to:stranger.humanId,note:'bot 想认识你'});assert.equal(request.result.pendingApproval,true);
    assert.equal((await f.rpc(stranger.accessToken,'social.overview')).result.requests.length,0);
    await f.rpc(owner.accessToken,'account.decide',{requestId:request.result.requestId,approve:true});
    assert.equal((await f.rpc(stranger.accessToken,'social.overview')).result.requests[0].note,'bot 想认识你');
    assert.equal((await f.rpc(stranger.accessToken,'social.friend.accept',{from:'10001'})).ok,true);
    assert.equal((await f.bot('10002','friend.request',{to:stranger.humanId})).status,403);
  } finally { await f.close(); }
});

test('混合群所有 bot 主人批准前不建群；给 bot 群加入人类同样需要全体主人审批', async () => {
  const f = await fixture();try {
    const a=await f.claim('10001','ga@example.com'),b=await f.claim('10002','gb@example.com'),h=await f.register('gh@example.com');
    f.app.store.befriend(h.humanId,'10001');f.app.store.befriend(h.humanId,'10002');f.app.store.befriend('10001','10002');
    const create=await f.rpc(h.accessToken,'social.group.create',{name:'混合群',members:['10001','10002']});assert.equal(create.result.pendingApproval,true);assert.equal(f.app.store.count('groups'),0);
    assert.equal((await f.rpc(a.accessToken,'account.decide',{requestId:create.result.requestId,approve:true})).result.waitingForOthers,true);
    const completed=await f.rpc(b.accessToken,'account.decide',{requestId:create.result.requestId,approve:true});assert.equal(completed.result.status,'completed');assert.equal(f.app.store.count('groups'),1);
    const botGroup=await f.bot('10001','group.create',{name:'bot 群',members:['10002']});assert.equal(botGroup.ok,true);
    const invite=await f.bot('10001','group.invite',{groupId:botGroup.result.id,botId:h.humanId});assert.equal(invite.result.pendingApproval,true);
    assert.equal(f.app.store.get('groups',botGroup.result.id).members.includes(h.humanId),false);
    await f.rpc(a.accessToken,'account.decide',{requestId:invite.result.requestId,approve:true});await f.rpc(b.accessToken,'account.decide',{requestId:invite.result.requestId,approve:false});
    assert.equal(f.app.store.get('groups',botGroup.result.id).members.includes(h.humanId),false);
  } finally { await f.close(); }
});

test('网页邮箱登录使用安全 Cookie 且不返回令牌；未绑定 bot 也能公开预约狼人杀', async () => {
  const f=await fixture();try{
    const a=await f.register('web@example.com');
    assert.equal((await f.post('/web/auth',{action:'login',method:'password',email:'web@example.com',password:'example-pass-123'})).status,403);
    const v=await f.post('/web/auth',{action:'login',method:'password',email:'web@example.com',password:'example-pass-123'},'','',{origin:f.base});assert.equal(v.ok,true);assert.equal(v.result.accessToken,undefined);assert.match(v.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);
    const cookie=v.headers.get('set-cookie').split(';')[0];assert.equal((await f.post('/web/rpc',{action:'account.info'},'','',{origin:f.base,cookie})).result.humanId,a.humanId);
    const game=await f.rpc(a.accessToken,'human.schedule',{title:'新人类预约',public:true,maxPlayers:6,scheduledAt:'2026-11-01T18:10:00+08:00'});assert.equal(game.ok,true,game.error);assert.equal(game.result.creator,a.humanId);
  }finally{await f.close();}
});

test('H 数字相同不代表绑定：同号新 bot 不能替人类邀请，实际绑定的不同号 bot 可以', async () => {
  const f=await fixture();try{
    const h=await f.register('independent@example.com');assert.equal(h.humanId,'10004H');
    const token='d'.repeat(64);await f.post('/register',{installationId:randomUUID(),token});
    const scheduled=await f.rpc(h.accessToken,'human.schedule',{title:'独立身份游戏',public:true,maxPlayers:6,scheduledAt:'2026-11-01T18:10:00+08:00'});assert.equal(scheduled.ok,true,scheduled.error);
    f.app.store.befriend('10004','10003');
    assert.equal((await f.post('/rpc',{action:'game.invite',args:{gameId:scheduled.result.gameId,sourceKind:'private',sourceTarget:'10003'}},token,'10004')).status,403);
    assert.equal((await f.rpc(h.accessToken,'account.bind',{botId:'10002',credential:f.keys['10002']})).ok,true);
    f.app.store.befriend('10002','10003');
    assert.equal((await f.bot('10002','game.invite',{gameId:scheduled.result.gameId,sourceKind:'private',sourceTarget:'10003'})).ok,true);
  }finally{await f.close();}
});

test('合并旧 H 身份后保留其游戏记录、房间读取与人类封禁状态', async () => {
  const f=await fixture();try{
    const gameId=randomUUID();f.app.store.put('games',gameId,{id:gameId,title:'旧人类记录',creator:'10002H',joined:['10002H'],participants:['10002H'],status:'closed',roles:{'10002H':'villager'},alive:[],uses:{},rules:{},votes:{},night:{},maxPlayers:6,invited:[],spectators:[],checkedIn:[],scheduledAt:'2026-11-01T18:10:00+08:00'});
    f.app.store.put('gameAccess',`10002H:${gameId}`,{owner:'10002H',gameId});f.app.store.put('humanConduct','10002',{strikes:2,banned:true});
    const owner=await f.claim('10001','merge@example.com');await f.rpc(owner.accessToken,'account.bind',{botId:'10002',credential:f.keys['10002']});
    const lobby=await f.rpc(owner.accessToken,'human.lobby');assert.equal(lobby.result.games.some(g=>g.gameId===gameId),true);assert.equal(lobby.result.moderation.banned,true);
    const room=await f.rpc(owner.accessToken,'human.room',{gameId});assert.equal(room.ok,true,room.error);assert.equal(room.result.humanId,'10002H');
    assert.equal((await f.rpc(owner.accessToken,'human.schedule',{title:'不能绕过封禁',public:true,maxPlayers:6,scheduledAt:'2026-11-01T18:10:00+08:00'})).status,403);
  }finally{await f.close();}
});

test('同名搜索可分页取完，不因 20 条旧上限漏人；人类账号不占满额 bot 的注册额度',async()=>{
  const f=await fixture();try{
    const user=await f.register('search@example.com');
    for(let n=20000;n<20061;n++)f.app.store.put('people',`${n}H`,{humanId:`${n}H`,nickname:'同名用户',email:`u${n}@example.com`,epoch:1});
    const first=await f.rpc(user.accessToken,'social.search',{query:'同名用户'}),second=await f.rpc(user.accessToken,'social.search',{query:'同名用户',offset:50});assert.equal(first.result.items.length,50);assert.equal(second.result.items.length,11);
    for(let n=10004;n<=11500;n++)f.app.store.put('accounts',String(n),{installationId:randomUUID(),tokenHash:'unused'});
    assert.equal((await f.post('/register',{installationId:randomUUID(),token:'f'.repeat(64)})).status,409);
    const still=await f.register('human-after-bot-full@example.com');assert.equal(still.humanId,'10005H');
  }finally{await f.close();}
});
