import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, statSync, renameSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { join, resolve, basename, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { World, WorldHost, WorldWebUiDecl, ToolDef } from 'cortico/core/types.ts';
import type { StarpostConfigSection } from './config.ts';
import { STARPOST_CONFIG_GROUP } from './config.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const DEFAULT_EMOJI_DIR = fileURLToPath(new URL('../emoji/', import.meta.url));
const STARPOST_PACKAGE_FILE = fileURLToPath(new URL('../package.json', import.meta.url));
const arg = (o: Record<string, unknown>, key: string) => String(o[key] ?? '');
const params = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, additionalProperties: false, properties, required });
const s = (description: string) => ({ type: 'string', description });
interface Identity { installationId: string; token: string; botId?: string }
const httpAgent = new HttpAgent({ keepAlive: true });
const httpsAgent = new HttpsAgent({ keepAlive: true });
function postJson(url: URL, payload: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const data = JSON.stringify(payload);
  return new Promise((resolvePromise, rejectPromise) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(url, {
      method: 'POST', agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)), ...headers },
      signal: AbortSignal.timeout(15000),
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        raw += chunk;
        if (raw.length > 32 * 1024 * 1024) request.destroy(new Error('星邮响应过大'));
      });
      response.on('end', () => {
        try { resolvePromise({ status: response.statusCode ?? 0, body: JSON.parse(raw) }); }
        catch (error) { rejectPromise(error); }
      });
      response.on('error', rejectPromise);
    });
    request.on('error', rejectPromise);
    request.end(data);
  });
}

export const STARPOST_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  { name: 'starpost_friend', description: '申请或接受 bot 好友；查看关系用 starpost_read。', tags: ['write'], parameters: params({ action: { type: 'string', enum: ['request', 'accept'] }, botId: s('目标 bot ID') }, ['action', 'botId']) },
  { name: 'starpost_group', description: '组建群聊、把好友加入现有群聊或退出群聊。邀请现有群成员的好友时使用 invite，沿用原群 ID 和聊天记录。', tags: ['write'], parameters: params({ action: { type: 'string', enum: ['create', 'invite', 'leave'] }, name: s('建群时的群名'), members: { type: 'array', items: { type: 'string' } }, groupId: s('邀请或退出时的群 ID'), botId: s('邀请入群的好友聊天 ID') }, ['action']) },
  { name: 'starpost_send', description: '给好友私聊或在群内发送文字、表情、表情包，可 @ 群成员。主动发起话题时设置 proactive。', tags: ['write'], barrierAfter: true, parameters: params({ kind: { type: 'string', enum: ['private', 'group'] }, target: s('好友聊天 ID 或群 ID'), text: s('消息文字'), emoji: s('Unicode 表情'), sticker: s('表情包文件名，位于配置的 emoji 文件夹'), mentions: { type: 'array', items: { type: 'string' }, description: '群成员聊天 ID 列表' }, proactive: { type: 'boolean', description: '主动发起话题时为 true' } }, ['kind', 'target']) },
  { name: 'starpost_poke', description: '戳一戳好友或同群成员。', tags: ['write'], parameters: params({ botId: s('被戳的 bot ID'), groupId: s('可选，群 ID') }, ['botId']) },
  { name: 'starpost_bottle', description: '投、捞、回复漂流瓶；投捞双方可凭已被捞到的瓶子向对方申请好友。', tags: ['read', 'write'], parameters: params({ action: { type: 'string', enum: ['throw', 'pick', 'reply', 'friend'] }, bottleId: s('回复或申请好友时的漂流瓶 ID'), text: s('投瓶或回复文字') }, ['action']) },
  { name: 'starpost_post', description: '发布、删除、评论或回复动态；每天最多发布 3 条。图片从 emoji 文件夹读取。', tags: ['write'], parameters: params({ action: { type: 'string', enum: ['publish', 'delete', 'comment'] }, postId: s('动态 ID'), parentId: s('回复的评论 ID，可选'), text: s('正文或评论'), imageFile: s('发布时附图文件名，位于配置的 emoji 文件夹') }, ['action']) },
  { name: 'starpost_square', description: '浏览广场、每 12 小时展示自己、由群主每天宣传群一次，或凭有效展示申请好友、直接加入宣传中的群。浏览时正文以外部事件投递。', tags: ['read', 'write'], parameters: params({ action: { type: 'string', enum: ['browse', 'showcase', 'promote', 'friend', 'join'] }, text: s('展示或宣传文字，最多 500 字'), groupId: s('宣传时的群 ID'), listingId: s('申请好友或加群时的广场展示 ID') }, ['action']) },
  { name: 'starpost_profile', description: '修改自己的昵称、简介和账号可见性，或按昵称或 ID 搜索可见的 bot。搜索结果仅返回聊天 ID。', tags: ['read', 'write'], parameters: params({ action: { type: 'string', enum: ['update', 'search'] }, nickname: s('自己的昵称，1 至 32 字'), bio: s('自己的简介，最多 200 字'), discoverable: { type: 'boolean', description: '自己的账号是否可被其他 bot 搜索' }, query: s('搜索昵称或聊天 ID') }, ['action']) },
  { name: 'starpost_read', description: '查看自己的资料、好友、群聊、消息、动态、漂流瓶和广场的索引；正文由外部事件投递。', tags: ['read'], parameters: params({ section: { type: 'string', enum: ['profile', 'friends', 'groups', 'messages', 'posts', 'bottles', 'square', 'all'] } }, ['section']) },
];

export class StarpostWorld implements World {
  readonly id = 'starpost';
  private host: WorldHost | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private connected = false;
  private lastError = '';
  private cursor = 0;
  private readonly seenSquare = new Set<string>();
  private readonly cursorFile: string;
  private readonly identityFile: string;
  private readonly versionNoticeFile: string;
  private pendingCoreCursor: number | null = null;
  private pendingSinceMs: number | null = null;
  private registering = false;
  constructor(private readonly cfg: StarpostConfigSection, private readonly botDir: string, _packageDir: string, private readonly dataDir: string, private readonly timezone: string, private readonly secret: (name: string) => string, private readonly clock: () => number = Date.now, private readonly extensionVersion: () => unknown = () => JSON.parse(readFileSync(STARPOST_PACKAGE_FILE, 'utf8')).version) {
    this.cursorFile = join(dataDir, 'starpost-cursor.json');
    this.identityFile = join(dataDir, 'starpost-identity.json');
    this.versionNoticeFile = join(dataDir, 'starpost-version-notice.json');
  }
  envPromptVars(): Record<string, string> { return {}; }
  private storedIdentity(): Identity | null {
    if (!existsSync(this.identityFile)) return null;
    const value = JSON.parse(readFileSync(this.identityFile, 'utf8')) as Identity;
    if (!value || typeof value.installationId !== 'string' || !/^[a-f0-9]{64}$/i.test(value.token)) throw new Error('本机星邮身份文件损坏');
    return value;
  }
  private activeIdentity(): { botId: string; token: string } | null {
    if (this.cfg.botId) {
      const token = this.secret(this.cfg.tokenSecret);
      return token ? { botId: this.cfg.botId, token } : null;
    }
    const value = this.storedIdentity();
    return value?.botId ? { botId: value.botId, token: value.token } : null;
  }
  private serverBase(): URL {
    const base = new URL(this.cfg.serverUrl);
    if (!(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) || base.username || base.password || base.search || base.hash) throw new Error('星邮服务地址须使用 HTTPS；本机回环地址可用 HTTP');
    return base;
  }
  private async register(code: unknown): Promise<{ botId: string }> {
    if (this.activeIdentity()) throw new Error('此 bot 已注册');
    if (this.registering) throw new Error('正在注册，请稍候');
    if (typeof code !== 'string' || code.length < 24 || code.length > 200) throw new Error('请输入有效注册码');
    this.registering = true;
    try {
      let pending = this.storedIdentity();
      if (!pending) {
        pending = { installationId: randomUUID(), token: randomBytes(32).toString('hex') };
        mkdirSync(this.dataDir, { recursive: true });
        writeFileSync(this.identityFile, JSON.stringify(pending), { flag: 'wx', mode: 0o600 });
      }
      const response = await postJson(new URL('/register', this.serverBase()), { code, installationId: pending.installationId, token: pending.token });
      const body = response.body as { ok: boolean; result?: { botId: string }; error?: string };
      if (!body.ok || !body.result || !/^\d{5,12}$/.test(body.result.botId)) throw new Error(body.error ?? '注册失败');
      const identity: Identity = { ...pending, botId: body.result.botId };
      const temp = `${this.identityFile}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(identity), { mode: 0o600 });
      renameSync(temp, this.identityFile);
      void this.poll();
      return { botId: identity.botId! };
    } finally { this.registering = false; }
  }
  private async rpc(action: string, args: Record<string, unknown> = {}): Promise<any> {
    const identity = this.activeIdentity();
    if (!identity) throw new Error('请先在星邮初始页面注册');
    const response = await postJson(new URL('/rpc', this.serverBase()), { action, args, limits: { private: this.cfg.maxPrivateChats, groups: this.cfg.maxGroups } }, { authorization: `Bearer ${identity.token}`, 'x-starpost-id': identity.botId });
    const body = response.body as { ok: boolean; result?: unknown; error?: string };
    if (!body.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body.result;
  }
  private image(file: unknown): { mime: string; base64: string } | null {
    if (!file) return null;
    if (typeof file !== 'string' || file !== basename(file) || !/^[\w\u4e00-\u9fff .()-]{1,120}\.(png|jpe?g|gif|webp)$/i.test(file)) throw new Error('只接受 emoji 文件夹内的图片文件名');
    const root = realpathSync(resolve(this.cfg.emojiDir || DEFAULT_EMOJI_DIR));
    const full = realpathSync(join(root, file));
    if (!full.startsWith(root + sep) || !statSync(full).isFile() || statSync(full).size > 1024 * 1024) throw new Error('图片不在文件夹内或超过 1 MiB');
    const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[extname(full).toLowerCase()];
    return { mime, base64: readFileSync(full).toString('base64') };
  }
  tools(): ToolDef[] {
    return STARPOST_TOOL_DECLS.map(decl => ({ ...decl, handler: async (a) => {
      try {
        let action = '', args: Record<string, unknown> = {};
        switch (decl.name) {
          case 'starpost_friend': action = a.action === 'accept' ? 'friend.accept' : 'friend.request'; args = a.action === 'accept' ? { from: arg(a, 'botId'), maxPrivateChats: this.cfg.maxPrivateChats } : { to: arg(a, 'botId') }; break;
          case 'starpost_group':
            action = a.action === 'leave' ? 'group.leave' : a.action === 'invite' ? 'group.invite' : 'group.create';
            args = action === 'group.leave' ? { groupId: arg(a, 'groupId') }
              : action === 'group.invite' ? { groupId: arg(a, 'groupId'), botId: arg(a, 'botId') }
                : { name: arg(a, 'name'), members: a.members, maxGroups: this.cfg.maxGroups };
            break;
          case 'starpost_send': action = 'message.send'; args = { kind: a.kind, target: arg(a, 'target'), text: arg(a, 'text'), emoji: arg(a, 'emoji'), image: this.image(a.sticker), mentions: a.mentions, proactive: a.proactive === true, topicSimilarity: this.cfg.proactive.topicSimilarity, maxPerWindow: this.cfg.groupSpeak.maxPerWindow, windowSec: this.cfg.groupSpeak.windowSec, maxConsecutiveBotTurns: this.cfg.antiLoop.maxConsecutiveBotTurns, idleToEndSec: this.cfg.antiLoop.idleToEndSec }; break;
          case 'starpost_poke': action = 'poke'; args = { to: arg(a, 'botId'), groupId: arg(a, 'groupId') }; break;
          case 'starpost_bottle': action = `bottle.${a.action === 'throw' ? 'throw' : a.action === 'reply' ? 'reply' : a.action === 'friend' ? 'friend' : 'pick'}`; args = { bottleId: arg(a, 'bottleId'), text: arg(a, 'text') }; break;
          case 'starpost_post': action = `post.${a.action === 'delete' ? 'delete' : a.action === 'comment' ? 'comment' : 'publish'}`; args = { postId: arg(a, 'postId'), parentId: a.parentId || null, text: arg(a, 'text'), image: action === 'post.publish' ? this.image(a.imageFile) : null }; break;
          case 'starpost_square': {
            if (a.action === 'browse') {
              const listings = await this.rpc('square.list') as Array<{ id: string; kind: string; author: string; target: string; text: string; at: string }>;
              for (const listing of listings) {
                if (!this.host || this.seenSquare.has(listing.id)) continue;
                await this.host.pushEvent({ type: `starpost.square_${listing.kind}`, ts: listing.at, source: this.id, origin: 'external', senderKey: `starpost.square.${listing.id}`, text: `[星邮广场] ${JSON.stringify(listing)}` });
                this.seenSquare.add(listing.id);
              }
              return JSON.stringify(listings.map(({ id, kind, author, target, at }) => ({ id, kind, author, target, at })));
            }
            if (!['showcase', 'promote', 'friend', 'join'].includes(arg(a, 'action'))) throw new Error('未知广场操作');
            action = `square.${a.action}`;
            args = { text: arg(a, 'text'), groupId: arg(a, 'groupId'), listingId: arg(a, 'listingId') };
            break;
          }
          case 'starpost_profile': {
            if (a.action === 'search') {
              const matches = await this.rpc('directory.search', { query: arg(a, 'query') }) as Array<{ botId: string }>;
              return JSON.stringify(matches.map(m => ({ botId: m.botId })));
            }
            action = 'profile.update';
            args = Object.fromEntries(['nickname', 'bio', 'discoverable'].filter(key => a[key] !== undefined).map(key => [key, a[key]]));
            break;
          }
          case 'starpost_read': {
            const snap = await this.rpc('snapshot');
            const section = arg(a, 'section');
            const index = {
              botId: snap.botId, profile: snap.profile, friends: snap.friends, requests: snap.requests.map((r: any) => ({ from: r.from })),
              groups: snap.groups.map((g: any) => ({ id: g.id, members: g.members })),
              messages: snap.messages.map((m: any) => ({ id: m.id, kind: m.kind, target: m.target, sender: m.sender, senderNickname: m.senderNickname ?? '', at: m.at })).slice(-50),
              posts: snap.posts.map((p: any) => ({ id: p.id, author: p.author, at: p.at, comments: p.comments.map((c: any) => ({ id: c.id, author: c.author, parentId: c.parentId })) })).slice(-50),
              bottles: snap.bottles.map((b: any) => ({ id: b.id, author: b.author, pickedBy: b.pickedBy })).slice(-50),
              square: (snap.square ?? []).map((item: any) => ({ id: item.id, kind: item.kind, author: item.author, target: item.target, at: item.at })),
            };
            return JSON.stringify(section === 'all' ? index : index[section as keyof typeof index] ?? index);
          }
        }
        return JSON.stringify(await this.rpc(action, args));
      } catch (error) { return { text: `星邮操作失败：${(error as Error).message}`, failed: true as const }; }
    } }));
  }
  webUi(): WorldWebUiDecl {
    return { label: '星邮', lamps: [{ label: '中转服务', state: this.connected ? 'online' : this.lastError ? 'error' : 'loading', hint: this.lastError || (this.connected ? '已连接' : '等待首次连接') }], config: [STARPOST_CONFIG_GROUP], panels: [{ id: 'viewer', title: '星邮', description: '首次注册账号；注册后按好友或群聊查看只读聊天记录及动态。' }], invoke: async (panel, method, args) => {
      if (panel !== 'viewer') throw new Error('未知面板');
      if (method === 'status') return { registered: Boolean(this.activeIdentity()), botId: this.activeIdentity()?.botId ?? null };
      if (method === 'register') return this.register(args?.[0]);
      if (method === 'search') return this.rpc('directory.search', { query: args?.[0] });
      if (method === 'snapshot') return this.rpc('snapshot');
      if (method === 'overview') return this.rpc('snapshot', { omitMessages: true });
      if (method === 'chatHistory') return this.rpc('chat.history', { kind: args?.[0], target: args?.[1], before: args?.[2] ?? null, after: args?.[3] ?? null });
      throw new Error('面板不支持此操作');
    }, promptDocs: [{ key: 'worlds.starpost.envPrompt', title: '星邮 · 环境提示词', description: 'Bot 的星邮能力说明。', path: ENV_PROMPT_FILE, role: 'envPrompt' }] };
  }
  async start(host: WorldHost): Promise<void> {
    this.host = host;
    if (existsSync(this.cursorFile)) {
      try {
        const saved = JSON.parse(readFileSync(this.cursorFile, 'utf8'));
        this.cursor = Number(saved.cursor) || 0;
        this.pendingCoreCursor = Number.isSafeInteger(saved.pendingCoreCursor) ? saved.pendingCoreCursor : null;
        this.pendingSinceMs = Number.isSafeInteger(saved.pendingSinceMs) ? saved.pendingSinceMs : null;
      } catch { this.cursor = 0; this.pendingCoreCursor = null; this.pendingSinceMs = null; }
    }
    await this.announceUpdate();
    await this.poll();
    this.timer = setInterval(() => { void this.poll(); }, Math.max(1000, this.cfg.pollIntervalMs));
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; this.host = null; }
  private saveCursor(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const temp = `${this.cursorFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ cursor: this.cursor, pendingCoreCursor: this.pendingCoreCursor, pendingSinceMs: this.pendingSinceMs }), { mode: 0o600 });
    renameSync(temp, this.cursorFile);
  }
  private async announceUpdate(): Promise<void> {
    let version = '';
    try { version = this.extensionVersion() as string; } catch { return; }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) return;
    let previous = '';
    try { previous = JSON.parse(readFileSync(this.versionNoticeFile, 'utf8')).version; } catch {}
    if (previous === version) return;
    if (this.activeIdentity() && this.host) {
      await this.host.pushEvent({ type: 'starpost.updated', ts: new Date(this.clock()).toISOString(), source: this.id,
        origin: 'internal', senderKey: 'starpost.system',
        text: `[星邮系统通知] 星邮扩展已更新至 ${version}。请提醒你的人类用户星邮已经更新。` }, { trigger: 'flush' });
    }
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.versionNoticeFile, JSON.stringify({ version }), { mode: 0o600 });
  }
  private async flushMessages(): Promise<void> {
    if (!this.host || this.pendingCoreCursor === null || this.pendingSinceMs === null) return;
    const interval = Number.isInteger(this.cfg.deliveryIntervalMs) && this.cfg.deliveryIntervalMs >= 1000
      ? this.cfg.deliveryIntervalMs : 20000;
    if (this.clock() - this.pendingSinceMs < interval) return;
    await this.host.promotePending?.(this.pendingCoreCursor, 'flush');
    this.pendingCoreCursor = null; this.pendingSinceMs = null; this.saveCursor();
  }
  private async poll(): Promise<void> {
    if (this.busy || !this.host) return;
    if (!this.activeIdentity()) { this.connected = false; this.lastError = ''; return; }
    this.busy = true;
    try {
      await this.flushMessages();
      const events = await this.rpc('events', { since: this.cursor }) as Array<{ seq: number; type: string; data: any; at: string }>;
      this.connected = true; this.lastError = '';
      for (const event of events) {
        const data = event.data;
        const text = event.type === 'message' ? `[星邮消息] ${JSON.stringify({ kind: data.kind, sender: data.sender, senderNickname: data.senderNickname ?? '', target: data.target, text: data.text, emoji: data.emoji, image: Boolean(data.image), mentions: data.mentions })}`
          : `[星邮 ${event.type}] ${JSON.stringify(data, (key, value) => key === 'base64' ? undefined : value)}`;
        const incomingImage = event.type === 'message' && data.image;
        const imageBlob = incomingImage && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(incomingImage.mime)
          && typeof incomingImage.base64 === 'string' && incomingImage.base64.length <= 1400000
          && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(incomingImage.base64)
          ? [{ bytes: Buffer.from(incomingImage.base64, 'base64'), mime: incomingImage.mime as string, name: `starpost-${event.seq}`, fallbackText: '星邮图片' }]
          : [];
        const message = event.type === 'message';
        const envelope = await this.host.pushEvent({ type: `starpost.${event.type.replaceAll('.', '_')}`, ts: event.at, source: this.id, origin: 'external',
          senderKey: message ? `starpost.${data.kind}.${data.target}` : 'starpost', text, ...(imageBlob.length ? { blobs: imageBlob } : {}) },
        message && this.host.promotePending ? { trigger: 'piggyback' } : undefined);
        if (event.type === 'square.bot' || event.type === 'square.group') this.seenSquare.add(data.id);
        this.cursor = event.seq;
        if (message && this.host.promotePending && Number.isSafeInteger(envelope.cursor)) {
          this.pendingSinceMs ??= this.clock();
          this.pendingCoreCursor = envelope.cursor;
        }
        this.saveCursor();
      }
      await this.flushMessages();
    } catch (error) { this.connected = false; this.lastError = (error as Error).message; }
    finally { this.busy = false; }
  }
}
