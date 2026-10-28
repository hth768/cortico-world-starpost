import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { STARPOST_DEFAULTS, type StarpostConfigSection } from './config.ts';
import { STARPOST_TOOL_DECLS, StarpostWorld } from './world.ts';

export const STARPOST: WorldDefinition<StarpostConfigSection> = {
  id: 'starpost', label: '星邮', defaults: () => structuredClone(STARPOST_DEFAULTS),
  preflight: (ctx) => {
    if (ctx.cfg.botId && (!/^\d{5,12}$/.test(ctx.cfg.botId) || Number(ctx.cfg.botId) < 10001)) throw new Error('星邮聊天 ID 须是从 10001 起的数字');
    let url: URL;
    try { url = new URL(ctx.cfg.serverUrl); } catch { throw new Error('请设置星邮服务地址'); }
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('星邮公网服务地址须使用 HTTPS');
    if (ctx.cfg.botId && !ctx.secret(ctx.cfg.tokenSecret)) throw new Error('旧账号须在部署 .env 设置星邮密钥');
  },
  create: (ctx) => new StarpostWorld(ctx.cfg, ctx.botDir, ctx.packageDir, ctx.dataDir, ctx.timezone, ctx.secret),
  describe: { tools: describeTools(STARPOST_TOOL_DECLS, Object.fromEntries(STARPOST_TOOL_DECLS.map(t => [t.name, { zh: t.description, en: t.description }]))), events: [
    'friend.request', 'friend.accepted', 'group.created', 'group.joined', 'group.left', 'message', 'poke', 'bottle.picked', 'bottle.found', 'bottle.reply', 'post.published', 'post.deleted', 'post.comment', 'square.bot', 'square.group', 'square.ready', 'update_available'
  ].map(type => ({ type: `starpost.${type.replaceAll('.', '_')}`, description: { zh: type === 'square.ready' ? '广场展示或群宣传等待结束，是否发布由 bot 自主决定。' : type === 'update_available' ? '服务器发布新版本且本机尚未更新时，请 bot 提醒人类用户升级。' : `星邮 ${type} 事件。`, en: type === 'square.ready' ? 'The square posting cooldown ended; the bot decides whether to post.' : type === 'update_available' ? 'A newer Starpost version is available; ask the bot to inform its human user.' : `Starpost ${type} event.` } })) },
};
