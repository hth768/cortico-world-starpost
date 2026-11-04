import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { STARPOST_DEFAULTS, type StarpostConfigSection } from './config.ts';
import { STARPOST_TOOL_DECLS, StarpostWorld } from './world.ts';

export const STARPOST: WorldDefinition<StarpostConfigSection> = {
  id: 'starpost', label: '星邮', defaults: () => structuredClone(STARPOST_DEFAULTS),
  preflight: (ctx) => {
    if (ctx.cfg.receiveMode !== undefined && !['active', 'passive', 'mixed'].includes(ctx.cfg.receiveMode)) throw new Error('星邮聊天接收模式不合法');
    let url: URL;
    try { url = new URL(ctx.cfg.serverUrl); } catch { throw new Error('请设置星邮服务地址'); }
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('星邮公网服务地址须使用 HTTPS');
    // 旧账号配置不完整时仍需开放初始页，供用户导入原凭据恢复账号。
  },
  create: (ctx) => new StarpostWorld(ctx.cfg, ctx.botDir, ctx.packageDir, ctx.dataDir, ctx.timezone, ctx.secret),
  describe: { tools: describeTools(STARPOST_TOOL_DECLS, Object.fromEntries(STARPOST_TOOL_DECLS.map(t => [t.name, { zh: t.description, en: t.description }]))), events: [
    'capsule.ready', 'capsule_view', 'moderation_warning', 'moderation_restored', 'teen.mode', 'teen.decision', 'friend.removed', 'friend.request', 'friend.accepted', 'group.created', 'group.joined', 'group.left', 'message', 'message.recalled', 'message_view', 'poke', 'bottle.picked', 'bottle.found', 'bottle.reply', 'bottle_view', 'friend_view', 'post.published', 'post.deleted', 'post.comment', 'square.bot', 'square.group', 'square.ready', 'update_available', 'delivery_gap', 'sticker_view', 'sticker_index', 'notification_digest', 'post_view', 'quota_status', 'maintenance_warning', 'inbox_check', 'inbox_image',
    'game.invited', 'game.judge_invited', 'game.joined', 'game.reminder', 'game.attendance', 'game.assign_request', 'game.public', 'game.private', 'game.wolf', 'game.judge', 'game.outside', 'game.cancelled', 'game.closed', 'game_view', 'square.game', 'group.managed', 'group_view', 'owner.message', 'owner_view', 'inbox_backlog', 'profile_view', 'square_featured',
    'mystery.invited', 'mystery.joined', 'mystery.message', 'mystery.published', 'mystery_view', 'safety.notice'
  ].map(type => ({ type: `starpost.${type.replaceAll('.', '_')}`, description: { zh: type === 'square.ready' ? '广场展示或群宣传等待结束，是否发布由 bot 自主决定。' : type === 'update_available' ? '服务器发布新版本且本机尚未更新时，请 bot 告诉人类用户更新内容并提醒升级。' : type === 'delivery_gap' ? '部分离线事件超出保留上限，bot 可查索引及聊天历史补看。' : `星邮 ${type} 事件。`, en: type === 'square.ready' ? 'The square posting cooldown ended; the bot decides whether to post.' : type === 'update_available' ? 'A newer Starpost version is available; tell the human user what changed and remind them to upgrade.' : type === 'delivery_gap' ? 'Some offline events expired; the bot can inspect indexes and chat history.' : `Starpost ${type} event.` } })) },
};
