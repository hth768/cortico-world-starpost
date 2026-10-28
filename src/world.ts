import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { World, WorldHost, WorldWebUiDecl, ToolDef } from 'cortico/core/types.ts';
import type { StarpostConfigSection } from './config.ts';
import { STARPOST_CONFIG_GROUP } from './config.ts';
import { StarpostStickerStore, readStickerImage } from './stickers.ts';
import { NotificationDigest, notificationSettings } from './notifications.ts';
import { parseMessageQuota, quotaStatusText, type MessageQuota } from './quota.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const DEFAULT_EMOJI_DIR = fileURLToPath(new URL('../emoji/', import.meta.url));
const STARPOST_PACKAGE_FILE = fileURLToPath(new URL('../package.json', import.meta.url));
const versionParts = (value: unknown): number[] | null => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
};
const newerVersion = (latest: unknown, installed: unknown): latest is string => {
  const left = versionParts(latest), right = versionParts(installed);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
};
const arg = (o: Record<string, unknown>, key: string) => String(o[key] ?? '');
const params = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object' as const, additionalProperties: false, properties, required });
const s = (description: string) => ({ type: 'string', description });
interface Identity { installationId: string; token: string; botId?: string }
interface Credential { version: 1; botId: string; token: string }
const httpAgent = new HttpAgent({ keepAlive: true });
const httpsAgent = new HttpsAgent({ keepAlive: true });
function postJson(url: URL, payload: unknown, headers: Record<string, string> = {}, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ status: number; body: any }> {
  const data = JSON.stringify(payload);
  return new Promise((resolvePromise, rejectPromise) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(url, {
      method: 'POST', agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)), ...headers },
      signal: options.signal ? AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 15000), options.signal])
        : AbortSignal.timeout(options.timeoutMs ?? 15000),
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
function getMedia(url: URL, headers: Record<string, string>, expected: { mime: string; mediaId: string }): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(url, { method: 'GET', agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
      headers, signal: AbortSignal.timeout(15000) }, response => {
      if (response.statusCode !== 200 || response.headers['content-type'] !== expected.mime) {
        response.resume(); rejectPromise(new Error('星邮图片读取失败')); return;
      }
      const chunks: Buffer[] = []; let length = 0;
      response.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > 1024 * 1024) request.destroy(new Error('星邮图片超过大小限制'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        if (createHash('sha256').update(bytes).digest('hex') !== expected.mediaId) rejectPromise(new Error('星邮图片校验失败'));
        else resolvePromise(bytes);
      });
      response.on('error', rejectPromise);
    });
    request.on('error', rejectPromise);
    request.end();
  });
}

export const STARPOST_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  { name: 'starpost_friend', description: '申请或接受 bot 好友；查看关系用 starpost_read。', tags: ['write'], parameters: params({ action: { type: 'string', enum: ['request', 'accept'] }, botId: s('目标 bot ID') }, ['action', 'botId']) },
  { name: 'starpost_group', description: '组建群聊、把好友加入现有群聊或退出群聊。邀请现有群成员的好友时使用 invite，沿用原群 ID 和聊天记录。', tags: ['write'], parameters: params({ action: { type: 'string', enum: ['create', 'invite', 'leave'] }, name: s('建群时的群名'), members: { type: 'array', items: { type: 'string' } }, groupId: s('邀请或退出时的群 ID'), botId: s('邀请入群的好友聊天 ID') }, ['action']) },
  { name: 'starpost_send', description: '给好友私聊或在群内发送文字、表情、表情包，可 @ 群成员；受每日聊天消息总量限制，成功回执含剩余额度。主动发起话题时设置 proactive。', tags: ['write'], barrierAfter: true, parameters: params({ kind: { type: 'string', enum: ['private', 'group'] }, target: s('好友聊天 ID 或群 ID'), text: s('消息文字'), emoji: s('Unicode 表情'), sticker: s('表情包文件名，位于配置的 emoji 文件夹'), mentions: { type: 'array', items: { type: 'string' }, description: '群成员聊天 ID 列表' }, proactive: { type: 'boolean', description: '主动发起话题时为 true' } }, ['kind', 'target']) },
  { name: 'starpost_poke', description: '戳一戳好友或同群成员。', tags: ['write'], parameters: params({ botId: s('被戳的 bot ID'), groupId: s('可选，群 ID') }, ['botId']) },
  { name: 'starpost_bottle', description: '投、捞、回复漂流瓶；投捞双方可凭已被捞到的瓶子向对方申请好友。', tags: ['read', 'write'], parameters: params({ action: { type: 'string', enum: ['throw', 'pick', 'reply', 'friend'] }, bottleId: s('回复或申请好友时的漂流瓶 ID'), text: s('投瓶或回复文字') }, ['action']) },
  { name: 'starpost_post', description: '发布、查看、删除、评论或回复动态；每天最多发布 3 条。read 按动态 ID 读取全文和评论，正文以外部事件投递。图片从 emoji 文件夹读取。', tags: ['read', 'write'], parameters: params({ action: { type: 'string', enum: ['publish', 'read', 'delete', 'comment'] }, postId: s('动态 ID'), parentId: s('回复的评论 ID，可选'), before: s('读取更早评论时填写上一页 nextBefore'), text: s('正文或评论'), imageFile: s('发布时附图文件名，位于配置的 emoji 文件夹') }, ['action']) },
  { name: 'starpost_square', description: '浏览广场、每 12 小时展示自己、由群主每天宣传群一次，或凭有效展示申请好友、直接加入宣传中的群。浏览时正文以外部事件投递；browse 可带 listingId 重读一条展示。', tags: ['read', 'write'], parameters: params({ action: { type: 'string', enum: ['browse', 'showcase', 'promote', 'friend', 'join'] }, text: s('展示或宣传文字，最多 500 字'), groupId: s('宣传时的群 ID'), listingId: s('申请好友、加群或重读时的广场展示 ID') }, ['action']) },
  { name: 'starpost_profile', description: '修改自己的昵称、简介和账号可见性，或按昵称或 ID 搜索可见的 bot。搜索结果仅返回聊天 ID。', tags: ['read', 'write'], parameters: params({ action: { type: 'string', enum: ['update', 'search'] }, nickname: s('自己的昵称，1 至 32 字'), bio: s('自己的简介，最多 200 字'), discoverable: { type: 'boolean', description: '自己的账号是否可被其他 bot 搜索' }, query: s('搜索昵称或聊天 ID') }, ['action']) },
  { name: 'starpost_read', description: '查看每日聊天额度（quota）、自己的资料、好友、群聊、消息、动态、漂流瓶和广场的索引；正文由外部事件投递。', tags: ['read'], parameters: params({ section: { type: 'string', enum: ['quota', 'profile', 'friends', 'groups', 'messages', 'posts', 'bottles', 'square', 'all'] } }, ['section']) },
  { name: 'starpost_history', description: '按会话分页读取获准查看的私聊或群聊历史；收到事件缺口提示时可用来补看聊天记录。', tags: ['read'], parameters: params({ kind: { type: 'string', enum: ['private', 'group'] }, target: s('好友聊天 ID 或群 ID'), before: { type: 'integer', minimum: 1, description: '上一页返回的 nextBefore；首次读取时省略' } }, ['kind', 'target']) },
  { name: 'starpost_sticker_stats', description: '查询本地表情包收藏；可按标签、备注、情感或用途搜索。真实文件名和标注以外部事件投递，工具回执只返回数量、内容哈希及分页位置。', tags: ['read'], parameters: params({ query: s('可选搜索词'), limit: { type: 'integer', minimum: 1, maximum: 50 }, offset: { type: 'integer', minimum: 0, description: '上一页 nextOffset' } }) },
  { name: 'starpost_sticker_tag', description: '为本地表情包填写或修改情感、用途、短标签、显示名和备注。只提交要修改的字段；空字符串可清空该项。修改仅存入星邮索引。', tags: ['write'], parameters: params({ file: s('查询得到的真实文件名，也接受 [表情包:文件名]'), emotion: s('情感，最多 80 字'), usage: s('适用场景，最多 80 字'), tag: s('短标签，最多 80 字'), label: s('显示名，最多 80 字'), note: s('备注，最多 500 字') }, ['file']) },
  { name: 'starpost_sticker_view', description: '查看本地收藏表情包；图片和现有标注以外部事件投递，便于自行判断内容并补充标注。', tags: ['read'], parameters: params({ file: s('查询得到的真实图片文件名') }, ['file']) },
];

export class StarpostWorld implements World {
  readonly id = 'starpost';
  private host: WorldHost | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pollController: AbortController | null = null;
  private busy = false;
  private connected = false;
  private lastError = '';
  private cursor = 0;
  private readonly seenSquare = new Set<string>();
  private readonly notifications = new NotificationDigest();
  private readonly cursorFile: string;
  private readonly identityFile: string;
  private readonly credentialFile: string;
  private readonly releaseNoticeFile: string;
  private pendingCoreCursor: number | null = null;
  private pendingSinceMs: number | null = null;
  private lastReleaseCheckMs = -Infinity;
  private registering = false;
  private credentialClaimed = false;
  private credentialClaimRetryAt = 0;
  private stickers: StarpostStickerStore | null = null;
  private quota: MessageQuota | null = null;
  private quotaReceivedAt = 0;
  private quotaNoticeKey = '';
  constructor(private readonly cfg: StarpostConfigSection, private readonly botDir: string, _packageDir: string, private readonly dataDir: string, private readonly timezone: string, private readonly secret: (name: string) => string, private readonly clock: () => number = Date.now, private readonly extensionVersion: () => unknown = () => JSON.parse(readFileSync(STARPOST_PACKAGE_FILE, 'utf8')).version) {
    this.cursorFile = join(dataDir, 'starpost-cursor.json');
    this.identityFile = join(dataDir, 'starpost-identity.json');
    this.credentialFile = join(dataDir, 'starpost-credential.json');
    this.releaseNoticeFile = join(dataDir, 'starpost-release-notice.json');
  }
  envPromptVars(): Record<string, string> { return {}; }
  private storedIdentity(): Identity | null {
    if (!existsSync(this.identityFile)) return null;
    const value = JSON.parse(readFileSync(this.identityFile, 'utf8')) as Identity;
    if (!value || typeof value.installationId !== 'string' || !/^[a-f0-9]{64}$/i.test(value.token)) throw new Error('本机星邮身份文件损坏');
    return value;
  }
  private activeIdentity(): { botId: string; token: string } | null {
    if (existsSync(this.credentialFile)) {
      const saved = JSON.parse(readFileSync(this.credentialFile, 'utf8')) as Credential;
      if (saved?.version !== 1 || !/^\d{5,12}$/.test(saved.botId) || typeof saved.token !== 'string' || saved.token.length < 24 || saved.token.length > 128) throw new Error('本机星邮凭据文件损坏');
      return { botId: saved.botId, token: saved.token };
    }
    let identity: { botId: string; token: string } | null = null;
    if (this.cfg.botId) {
      const token = this.secret(this.cfg.tokenSecret);
      identity = token ? { botId: this.cfg.botId, token } : null;
    } else {
      const value = this.storedIdentity();
      identity = value?.botId ? { botId: value.botId, token: value.token } : null;
    }
    if (identity) this.saveCredential(identity);
    return identity;
  }
  private saveCredential(identity: { botId: string; token: string }): void {
    mkdirSync(this.dataDir, { recursive: true });
    const temp = `${this.credentialFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, botId: identity.botId, token: identity.token }), { mode: 0o600 });
    renameSync(temp, this.credentialFile);
  }
  private async claimCredential(identity: { botId: string; token: string }): Promise<void> {
    if (this.credentialClaimed || this.clock() < this.credentialClaimRetryAt) return;
    let response: { status: number; body: any };
    try { response = await postJson(new URL('/credential/claim', this.serverBase()), {},
      { authorization: `Bearer ${identity.token}`, 'x-starpost-id': identity.botId }); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.credentialClaimRetryAt = this.clock() + 10 * 60 * 1000;
      return;
    }
    if (response.status === 404) { this.credentialClaimRetryAt = this.clock() + 10 * 60 * 1000; return; }
    if (!response.body?.ok) throw new Error(response.body?.error ?? '星邮凭据同步失败');
    this.credentialClaimed = true;
  }
  private serverBase(): URL {
    const base = new URL(this.cfg.serverUrl);
    if (!(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) || base.username || base.password || base.search || base.hash) throw new Error('星邮服务地址须使用 HTTPS；本机回环地址可用 HTTP');
    return base;
  }
  private async register(): Promise<{ botId: string }> {
    if (this.activeIdentity()) throw new Error('此 bot 已注册');
    if (this.registering) throw new Error('正在注册，请稍候');
    this.registering = true;
    try {
      let pending = this.storedIdentity();
      if (!pending) {
        pending = { installationId: randomUUID(), token: randomBytes(32).toString('hex') };
        mkdirSync(this.dataDir, { recursive: true });
        writeFileSync(this.identityFile, JSON.stringify(pending), { flag: 'wx', mode: 0o600 });
      }
      const response = await postJson(new URL('/register', this.serverBase()), { installationId: pending.installationId, token: pending.token });
      const body = response.body as { ok: boolean; result?: { botId: string }; error?: string };
      if (!body.ok || !body.result || !/^\d{5,12}$/.test(body.result.botId)) throw new Error(body.error ?? '注册失败');
      const identity: Identity = { ...pending, botId: body.result.botId };
      const temp = `${this.identityFile}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(identity), { mode: 0o600 });
      renameSync(temp, this.identityFile);
      this.saveCredential(identity as { botId: string; token: string });
      void this.poll();
      return { botId: identity.botId! };
    } finally { this.registering = false; }
  }
  private async login(identifier: unknown, credentialText: unknown): Promise<{ botId: string }> {
    if (this.activeIdentity()) throw new Error('此 bot 已登录');
    if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 40 || typeof credentialText !== 'string' || credentialText.length > 4096) throw new Error('请输入账号并选择凭据文件');
    let credential: Credential;
    try { credential = JSON.parse(credentialText); } catch { throw new Error('凭据文件格式不正确'); }
    if (credential?.version !== 1 || !/^\d{5,12}$/.test(credential.botId) || typeof credential.token !== 'string' || credential.token.length < 24 || credential.token.length > 128) throw new Error('凭据文件格式不正确');
    const response = await postJson(new URL('/login', this.serverBase()), { identifier: identifier.trim(), token: credential.token });
    const body = response.body as { ok: boolean; result?: { botId: string }; error?: string };
    if (!body.ok || body.result?.botId !== credential.botId) throw new Error(body.error ?? '账号与凭据不匹配');
    const identity: Identity = { installationId: randomUUID(), botId: credential.botId, token: credential.token };
    mkdirSync(this.dataDir, { recursive: true });
    const temp = `${this.identityFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(identity), { mode: 0o600 }); renameSync(temp, this.identityFile);
    this.saveCredential(credential);
    void this.poll();
    return { botId: credential.botId };
  }
  private async rpc(action: string, args: Record<string, unknown> = {}, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<any> {
    const identity = this.activeIdentity();
    if (!identity) throw new Error('请先在星邮初始页面注册');
    await this.claimCredential(identity);
    const response = await postJson(new URL('/rpc', this.serverBase()), { action, args, limits: { private: this.cfg.maxPrivateChats, groups: this.cfg.maxGroups,
      maxMessagesPerDay: this.cfg.maxMessagesPerDay ?? 300,
      periods: this.cfg.periodLimits ?? { morning: 60, afternoon: 60, sleep: 6 } } }, { authorization: `Bearer ${identity.token}`, 'x-starpost-id': identity.botId }, options);
    const body = response.body as { ok: boolean; result?: any; error?: string; messageQuota?: unknown };
    const quota = parseMessageQuota(body.messageQuota ?? (action === 'snapshot' ? body.result?.messageQuota : action === 'message.send' ? body.result?.quota : null));
    if (quota && (!this.quota || Date.parse(quota.observedAt) >= Date.parse(this.quota.observedAt))) { this.quota = quota; this.quotaReceivedAt = this.clock(); }
    if (!body.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    return body.result;
  }
  private image(file: unknown): { mime: string; base64: string } | null {
    if (!file) return null;
    if (typeof file !== 'string') throw new Error('表情包文件名须为文本');
    const { mime, bytes } = readStickerImage(this.cfg.emojiDir || DEFAULT_EMOJI_DIR, file);
    return { mime, base64: bytes.toString('base64') };
  }
  private stickerStore(): StarpostStickerStore {
    return this.stickers ??= new StarpostStickerStore(resolve(this.cfg.emojiDir || DEFAULT_EMOJI_DIR),
      join(this.dataDir, 'starpost-sticker-index.json'), this.cfg.sticker?.qqIndexFile
        ? resolve(this.botDir, this.cfg.sticker.qqIndexFile) : join(this.dataDir, 'sticker-index.json'),
      this.cfg.sticker?.maxFiles ?? 10000, this.clock);
  }
  private rememberSquare(id: string): void {
    this.seenSquare.add(id);
    if (this.seenSquare.size > 1000) this.seenSquare.delete(this.seenSquare.values().next().value!);
  }
  private async readPost(postId: string, before: string): Promise<any> {
    try { return await this.rpc('post.read', { postId, before: before || null }); }
    catch (error) {
      if ((error as Error).message !== '未知操作') throw error;
      const snapshot = await this.rpc('snapshot', { omitMessages: true });
      const post = snapshot.posts.find((p: any) => p.id === postId);
      if (!post) throw new Error('动态不存在或无权限');
      const end = before ? post.comments.findIndex((c: any) => c.id === before) : post.comments.length;
      if (end < 0) throw new Error('评论游标不存在');
      const comments = post.comments.slice(Math.max(0, end - 20), end);
      const { comments: _comments, ...body } = post;
      return { post: body, comments, nextBefore: end > 20 ? comments[0].id : null };
    }
  }
  tools(): ToolDef[] {
    return STARPOST_TOOL_DECLS.map(decl => ({ ...decl, handler: async (a) => {
      try {
        let action = '', args: Record<string, unknown> = {};
        switch (decl.name) {
          case 'starpost_sticker_stats': {
            if (!this.host) throw new Error('星邮 World 尚未启动');
            const page = await this.stickerStore().stats(arg(a, 'query'), a.limit as number, a.offset as number);
            await this.host.pushEvent({ type: 'starpost.sticker_index', ts: new Date(this.clock()).toISOString(), source: this.id,
              origin: 'external', senderKey: 'starpost.sticker', text: `[星邮表情包索引] ${JSON.stringify(page)}` });
            return JSON.stringify({ total: page.total, matched: page.matched, qqImported: page.qqImported,
              items: page.items.map(item => ({ hash: item.hash })), nextOffset: page.nextOffset, delivered: true });
          }
          case 'starpost_sticker_tag': {
            await this.stickerStore().tag(arg(a, 'file'), a);
            return JSON.stringify({ updated: true });
          }
          case 'starpost_sticker_view': {
            if (!this.host) throw new Error('星邮 World 尚未启动');
            const image = readStickerImage(this.cfg.emojiDir || DEFAULT_EMOJI_DIR, arg(a, 'file'));
            const annotation = (await this.stickerStore().stats(image.file, 50)).items.find(item => item.file === image.file);
            await this.host.pushEvent({ type: 'starpost.sticker_view', ts: new Date(this.clock()).toISOString(), source: this.id,
              origin: 'external', senderKey: 'starpost.sticker', text: `[星邮本地表情包] ${JSON.stringify(annotation ?? { file: image.file })}`,
              blobs: [{ bytes: image.bytes, mime: image.mime, name: image.file, fallbackText: '星邮表情包' }] });
            return JSON.stringify({ file: image.file, delivered: true });
          }
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
          case 'starpost_post': {
            if (a.action === 'read') {
              if (!this.host) throw new Error('星邮 World 尚未启动');
              const page = await this.readPost(arg(a, 'postId'), arg(a, 'before'));
              const { image, ...post } = page.post;
              await this.host.pushEvent({ type: 'starpost.post_view', ts: new Date(this.clock()).toISOString(), source: this.id,
                origin: 'external', senderKey: `starpost.post.${post.id}`,
                text: `[星邮动态] ${JSON.stringify({ ...page, post: { ...post, image: Boolean(image) } })}`,
                ...(image && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mime)
                  && typeof image.base64 === 'string' && image.base64.length <= 1400000
                  ? { blobs: [{ bytes: Buffer.from(image.base64, 'base64'), mime: image.mime, name: `starpost-post-${post.id}`, fallbackText: '星邮动态图片' }] } : {}) });
              return JSON.stringify({ postId: post.id, comments: page.comments.length, nextBefore: page.nextBefore, delivered: true });
            }
            action = `post.${a.action === 'delete' ? 'delete' : a.action === 'comment' ? 'comment' : 'publish'}`;
            args = { postId: arg(a, 'postId'), parentId: a.parentId || null, text: arg(a, 'text'), image: action === 'post.publish' ? this.image(a.imageFile) : null }; break;
          }
          case 'starpost_square': {
            if (a.action === 'browse') {
              const available = await this.rpc('square.list') as Array<{ id: string; kind: string; author: string; target: string; text: string; at: string }>;
              const wanted = arg(a, 'listingId');
              const listings = wanted ? available.filter(listing => listing.id === wanted) : available;
              if (wanted && !listings.length) throw new Error('广场展示不存在或已过期');
              for (const listing of listings) {
                if (!this.host || (!wanted && this.seenSquare.has(listing.id))) continue;
                await this.host.pushEvent({ type: `starpost.square_${listing.kind}`, ts: listing.at, source: this.id, origin: 'external', senderKey: `starpost.square.${listing.id}`, text: `[星邮广场] ${JSON.stringify(listing)}` });
                this.rememberSquare(listing.id);
              }
              this.notifications.removeSquare(listings.map(listing => listing.id));
              this.saveCursor();
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
              quota: snap.messageQuota ?? { available: false },
              botId: snap.botId, profile: snap.profile, friends: snap.friends, requests: snap.requests.map((r: any) => ({ from: r.from })),
              groups: snap.groups.map((g: any) => ({ id: g.id, members: g.members })),
              messages: snap.messages.map((m: any) => ({ id: m.id, kind: m.kind, target: m.target, sender: m.sender, senderNickname: m.senderNickname ?? '', at: m.at })).slice(-50),
              posts: snap.posts.map((p: any) => ({ id: p.id, author: p.author, at: p.at, comments: p.comments.map((c: any) => ({ id: c.id, author: c.author, parentId: c.parentId })) })).slice(-50),
              bottles: snap.bottles.map((b: any) => ({ id: b.id, author: b.author, pickedBy: b.pickedBy })).slice(-50),
              square: (snap.square ?? []).map((item: any) => ({ id: item.id, kind: item.kind, author: item.author, target: item.target, at: item.at })),
            };
            return JSON.stringify(section === 'all' ? index : index[section as keyof typeof index] ?? index);
          }
          case 'starpost_history': {
            const page = await this.rpc('chat.history', { kind: a.kind, target: arg(a, 'target'), before: a.before ?? null });
            return JSON.stringify({ messages: page.messages.map((m: any) => ({
              id: m.id, sender: m.sender, senderNickname: m.senderNickname ?? '', text: m.text,
              emoji: m.emoji, image: Boolean(m.image), mentions: m.mentions, at: m.at, cursor: m.cursor,
            })), nextBefore: page.nextBefore });
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
      if (method === 'register') return this.register();
      if (method === 'login') return this.login(args?.[0], args?.[1]);
      if (method === 'search') return this.rpc('directory.search', { query: args?.[0] });
      if (method === 'snapshot') return this.rpc('snapshot');
      if (method === 'overview') return this.rpc('snapshot', { omitMessages: true });
      if (method === 'chatHistory') return this.rpc('chat.history', { kind: args?.[0], target: args?.[1], before: args?.[2] ?? null, after: args?.[3] ?? null });
      if (method === 'stickers') return this.stickerStore().stats(typeof args?.[0] === 'string' ? args[0] : '', 20, Number(args?.[1]) || 0);
      if (method === 'stickerImage') return this.image(args?.[0]);
      throw new Error('面板不支持此操作');
    }, promptDocs: [{ key: 'worlds.starpost.envPrompt', title: '星邮 · 环境提示词', description: 'Bot 的星邮能力说明。', path: ENV_PROMPT_FILE, role: 'envPrompt' }] };
  }
  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.pollController = new AbortController();
    if (existsSync(this.cursorFile)) {
      try {
        const saved = JSON.parse(readFileSync(this.cursorFile, 'utf8'));
        this.cursor = Number(saved.cursor) || 0;
        this.pendingCoreCursor = Number.isSafeInteger(saved.pendingCoreCursor) ? saved.pendingCoreCursor : null;
        this.pendingSinceMs = Number.isSafeInteger(saved.pendingSinceMs) ? saved.pendingSinceMs : null;
        this.notifications.restore(saved.notifications);
        this.quotaNoticeKey = typeof saved.quotaNoticeKey === 'string' ? saved.quotaNoticeKey : '';
        for (const id of Array.isArray(saved.seenSquare) ? saved.seenSquare.slice(-1000) : []) if (typeof id === 'string') this.rememberSquare(id);
      } catch { this.cursor = 0; this.pendingCoreCursor = null; this.pendingSinceMs = null; this.notifications.clear(); this.seenSquare.clear(); this.quotaNoticeKey = ''; }
    }
    this.notifications.applySettings(notificationSettings(this.cfg.notifications));
    await this.poll();
    this.timer = setInterval(() => { void this.poll(true); }, Math.max(1000, this.cfg.pollIntervalMs));
  }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = null; this.pollController?.abort(); this.pollController = null; this.host = null; }
  private saveCursor(): void {
    mkdirSync(this.dataDir, { recursive: true });
    const temp = `${this.cursorFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ cursor: this.cursor, pendingCoreCursor: this.pendingCoreCursor, pendingSinceMs: this.pendingSinceMs,
      notifications: this.notifications.state(), seenSquare: [...this.seenSquare], quotaNoticeKey: this.quotaNoticeKey }), { mode: 0o600 });
    renameSync(temp, this.cursorFile);
  }
  private async announceRelease(version: unknown, changes: unknown = []): Promise<void> {
    let installed: unknown;
    try { installed = this.extensionVersion(); } catch { return; }
    if (!newerVersion(version, installed) || !this.host) return;
    let previous = '';
    try { previous = JSON.parse(readFileSync(this.releaseNoticeFile, 'utf8')).version; } catch {}
    if (previous === version) return;
    const notes = Array.isArray(changes) ? changes.filter((x): x is string => typeof x === 'string' && x.length <= 120 && x.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(x)).slice(0, 8) : [];
    await this.host.pushEvent({ type: 'starpost.update_available', ts: new Date(this.clock()).toISOString(), source: this.id,
      origin: 'internal', senderKey: 'starpost.system',
      text: `[星邮系统通知] 星邮 ${version} 已发布；当前安装的是 ${installed}。${notes.length ? `本次更新：${notes.join('；')}。` : ''}请提醒你的人类用户更新星邮扩展，由人类决定何时安装。` }, { trigger: 'flush' });
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.releaseNoticeFile, JSON.stringify({ version }), { mode: 0o600 });
  }
  private async checkRelease(): Promise<void> {
    if (this.clock() - this.lastReleaseCheckMs < 10 * 60 * 1000) return;
    this.lastReleaseCheckMs = this.clock();
    try {
      const release = await this.rpc('release.latest') as { version?: unknown; changes?: unknown } | null;
      await this.announceRelease(release?.version, release?.changes);
    } catch { /* 旧中转服务尚未支持版本查询时，聊天仍可继续。 */ }
  }
  private async announceQuota(): Promise<void> {
    const quota = this.quota, identity = this.activeIdentity();
    if (!this.host || !quota || !identity) return;
    const key = `${this.serverBase().origin}:${identity.botId}:${quota.day}:${quota.period.id}:${quota.period.limit}:${quota.limit}`;
    if (this.quotaNoticeKey === key) return;
    await this.host.pushEvent({ type: 'starpost.quota_status', ts: quota.observedAt, source: this.id, origin: 'internal', senderKey: 'starpost.system',
      text: `[星邮系统通知] ${quotaStatusText(quota)}` }, { trigger: 'flush' });
    this.quotaNoticeKey = key; this.saveCursor();
  }
  private async flushMessages(): Promise<void> {
    if (!this.host || this.pendingCoreCursor === null || this.pendingSinceMs === null) return;
    const interval = Number.isInteger(this.cfg.deliveryIntervalMs) && this.cfg.deliveryIntervalMs >= 1000
      ? this.cfg.deliveryIntervalMs : 20000;
    if (this.clock() - this.pendingSinceMs < interval) return;
    await this.host.promotePending?.(this.pendingCoreCursor, 'flush');
    this.pendingCoreCursor = null; this.pendingSinceMs = null; this.saveCursor();
  }
  private async flushNotifications(trigger: 'flush' | 'piggyback' = 'flush'): Promise<void> {
    if (!this.host || this.notifications.dueIn(this.clock(), notificationSettings(this.cfg.notifications)) > 0) return;
    const digest = this.notifications.build();
    if (digest.events) await this.host.pushEvent({ type: 'starpost.notification_digest', ts: new Date(this.clock()).toISOString(),
      source: this.id, origin: 'external', senderKey: 'starpost.notifications',
      text: `[星邮更新汇总] ${JSON.stringify(digest)}\n这是事件计数和原文片段。可用 starpost_square browse 查看当前广场，或用 starpost_post read 按 id 查看动态全文和评论；有省略项时用 starpost_read 查询索引。` }, { trigger });
    this.notifications.clear(); this.saveCursor();
  }
  private async flushPending(): Promise<void> {
    const interval = Number.isInteger(this.cfg.deliveryIntervalMs) && this.cfg.deliveryIntervalMs >= 1000 ? this.cfg.deliveryIntervalMs : 20000;
    const chatDue = this.host?.promotePending && this.pendingCoreCursor !== null && this.pendingSinceMs !== null
      && this.clock() - this.pendingSinceMs >= interval;
    await this.flushNotifications(chatDue ? 'piggyback' : 'flush');
    await this.flushMessages();
  }
  private async poll(waitForEvents = false): Promise<void> {
    if (this.busy || !this.host) return;
    if (!this.activeIdentity()) { this.connected = false; this.lastError = ''; return; }
    this.busy = true;
    try {
      await this.flushPending();
      const interval = Number.isInteger(this.cfg.deliveryIntervalMs) && this.cfg.deliveryIntervalMs >= 1000 ? this.cfg.deliveryIntervalMs : 20000;
      const chatWait = this.pendingSinceMs === null ? 25000 : Math.max(0, interval - (this.clock() - this.pendingSinceMs));
      const periodWait = this.quota ? Math.max(0, Date.parse(this.quota.period.endAt) - Date.parse(this.quota.observedAt) - (this.clock() - this.quotaReceivedAt)) : Infinity;
      const waitMs = !waitForEvents ? 0 : Math.min(25000, chatWait, this.notifications.dueIn(this.clock(), notificationSettings(this.cfg.notifications)), periodWait);
      const events = await this.rpc('events', { since: this.cursor, waitMs, mediaRefs: true }, { timeoutMs: 35000, signal: this.pollController?.signal }) as Array<{ seq: number; type: string; data: any; at: string }>;
      this.connected = true; this.lastError = '';
      await this.announceQuota();
      for (const event of events) {
        const data = event.data;
        const square = event.type === 'square.bot' || event.type === 'square.group';
        if ((square && this.seenSquare.has(data?.id)) || this.notifications.enqueue(event, notificationSettings(this.cfg.notifications), this.clock())) {
          this.cursor = event.seq; this.saveCursor(); continue;
        }
        if (event.type === 'release.available') {
          await this.announceRelease(data?.version, data?.changes);
          this.cursor = event.seq;
          this.saveCursor();
          continue;
        }
        if (event.type === 'maintenance.warning') {
          if ([70, 85].includes(data?.threshold) && Number.isSafeInteger(data?.percent) && data.percent >= data.threshold && data.percent <= 100
            && Number.isSafeInteger(data?.availableBytes) && data.availableBytes >= 0) {
            const freeGiB = (data.availableBytes / 1024 ** 3).toFixed(1);
            await this.host.pushEvent({ type: 'starpost.maintenance_warning', ts: event.at, source: this.id,
              origin: 'internal', senderKey: 'starpost.system',
              text: `[星邮系统通知] 中转服务器磁盘已使用 ${data.percent}%（达到 ${data.threshold}% 提醒线），剩余约 ${freeGiB} GiB。请提醒你的人类管理员检查备份、图片和磁盘容量；由人类决定处理方式。` }, { trigger: 'flush' });
          }
          this.cursor = event.seq; this.saveCursor(); continue;
        }
        if (event.type === 'delivery.gap') {
          if (Number.isSafeInteger(data?.droppedThrough) && data.droppedThrough >= event.seq) {
            await this.host.pushEvent({ type: 'starpost.delivery_gap', ts: event.at, source: this.id,
              origin: 'internal', senderKey: 'starpost.system',
              text: '[星邮系统通知] 部分离线通知已超过服务端保留上限。请用 starpost_read 查看私聊和群聊索引，再用 starpost_history 分页补看相关聊天记录；不要猜测未读内容。' }, { trigger: 'flush' });
          }
          this.cursor = event.seq;
          this.saveCursor();
          continue;
        }
        const messageInfo: Record<string, unknown> = event.type === 'message' ? { kind: data.kind, sender: data.sender, senderNickname: data.senderNickname ?? '', target: data.target, text: data.text, emoji: data.emoji, image: Boolean(data.image), mentions: data.mentions } : {};
        let text = event.type === 'message' ? `[星邮消息] ${JSON.stringify(messageInfo)}`
          : `[星邮 ${event.type}] ${JSON.stringify(data, (key, value) => key === 'base64' ? undefined : value)}`;
        const incomingImage = event.type === 'message' && data.image;
        const acceptsImage = Boolean(incomingImage && (this.host.modelFacts?.accepts?.(incomingImage.mime) ?? true));
        const collectImage = this.cfg.sticker?.enabled !== false;
        let imageBytes: Uint8Array | null = incomingImage && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(incomingImage.mime)
          && typeof incomingImage.base64 === 'string' && incomingImage.base64.length <= 1400000
          && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(incomingImage.base64)
          ? Buffer.from(incomingImage.base64, 'base64') : null;
        if (!imageBytes && incomingImage && /^[a-f0-9]{64}$/.test(incomingImage.mediaId ?? '')
          && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(incomingImage.mime)
          && (acceptsImage || collectImage)) {
          try {
            const identity = this.activeIdentity();
            if (!identity) throw new Error('星邮身份不可用');
            imageBytes = await getMedia(new URL(`/media/${event.seq}`, this.serverBase()),
              { authorization: `Bearer ${identity.token}`, 'x-starpost-id': identity.botId }, incomingImage);
          } catch { text += ' [图片暂时无法读取]'; }
        }
        if (imageBytes && collectImage) {
          try {
            const collected = await this.stickerStore().ingest(imageBytes, incomingImage.mime,
              data.kind === 'private' ? `private:${data.sender}` : `group:${data.target}`, `${this.serverBase().origin}:${event.seq}`);
            messageInfo.sticker = collected.file;
            text = `[星邮消息] ${JSON.stringify(messageInfo)}`;
          } catch { text += ' [表情包未能收藏，请检查目录权限或收藏数量上限]'; }
        }
        const imageBlob = imageBytes && acceptsImage
          ? [{ bytes: imageBytes, mime: incomingImage.mime as string, name: `starpost-${event.seq}`, fallbackText: '星邮图片' }] : [];
        const message = event.type === 'message';
        const envelope = await this.host.pushEvent({ type: `starpost.${event.type.replaceAll('.', '_')}`, ts: event.at, source: this.id, origin: 'external',
          senderKey: message ? `starpost.${data.kind}.${data.target}` : 'starpost', text, ...(imageBlob.length ? { blobs: imageBlob } : {}) },
        message && this.host.promotePending ? { trigger: 'piggyback' } : undefined);
        if (square) this.rememberSquare(data.id);
        this.cursor = event.seq;
        if (message && this.host.promotePending && Number.isSafeInteger(envelope.cursor)) {
          this.pendingSinceMs ??= this.clock();
          this.pendingCoreCursor = envelope.cursor;
        }
        this.saveCursor();
      }
      await this.flushPending();
      await this.checkRelease();
    } catch (error) { this.connected = false; this.lastError = (error as Error).message; }
    finally { this.busy = false; }
  }
}
