import type { ConfigGroup } from 'cortico/core/types.ts';

export interface StarpostConfigSection {
  enabled: boolean;
  serverUrl: string;
  botId: string;
  tokenSecret: string;
  emojiDir: string;
  maxPrivateChats: number;
  maxGroups: number;
  groupSpeak: { maxPerWindow: number; windowSec: number };
  antiLoop: { maxConsecutiveBotTurns: number; idleToEndSec: number };
  proactive: { topicSimilarity: number };
  pollIntervalMs: number;
}

export const STARPOST_DEFAULTS: StarpostConfigSection = {
  enabled: false, serverUrl: 'https://8.148.13.225', botId: '', tokenSecret: 'CORTICO_STARPOST_TOKEN', emojiDir: '',
  maxPrivateChats: 10, maxGroups: 5,
  groupSpeak: { maxPerWindow: 6, windowSec: 60 },
  antiLoop: { maxConsecutiveBotTurns: 5, idleToEndSec: 300 },
  proactive: { topicSimilarity: 0.6 },
  pollIntervalMs: 3000,
};

export const STARPOST_CONFIG_GROUP: ConfigGroup = {
  id: 'world:starpost', owner: 'world:starpost',
  schema: { type: 'object', title: '星邮', properties: {
    'worlds.starpost.serverUrl': { type: 'string', title: '中转服务地址', description: '建议使用 HTTPS。修改后重启 World。' },
    'worlds.starpost.botId': { type: 'string', title: '旧账号聊天 ID', description: '新账号在星邮页面注册并自动分配；旧版手工登记的账号才需在此填写 ID。' },
    'worlds.starpost.tokenSecret': { type: 'string', title: '密钥环境变量名', description: '默认 CORTICO_STARPOST_TOKEN；密钥值写在部署 .env。' },
    'worlds.starpost.emojiDir': { type: 'string', title: '表情包文件夹', description: '留空使用扩展内 emoji 文件夹；也可设为 qq 扩展的 emoji 文件夹。仅读取文件夹内的图片。' },
    'worlds.starpost.maxPrivateChats': { type: 'integer', minimum: 0, maximum: 1000, title: '私聊上限', 'x-hot': true },
    'worlds.starpost.maxGroups': { type: 'integer', minimum: 0, maximum: 1000, title: '群聊上限', 'x-hot': true },
    'worlds.starpost.groupSpeak.maxPerWindow': { type: 'integer', minimum: 1, maximum: 1000, title: '每群窗口发言上限', 'x-hot': true },
    'worlds.starpost.groupSpeak.windowSec': { type: 'integer', minimum: 1, maximum: 86400, title: '群聊窗口秒数', 'x-hot': true },
    'worlds.starpost.antiLoop.maxConsecutiveBotTurns': { type: 'integer', minimum: 1, maximum: 100, title: '连续发言上限', 'x-hot': true },
    'worlds.starpost.antiLoop.idleToEndSec': { type: 'integer', minimum: 0, maximum: 86400, title: '静默收尾秒数', 'x-hot': true },
    'worlds.starpost.proactive.topicSimilarity': { type: 'number', minimum: 0, maximum: 1, title: '主动话题相似度上限', description: '0 关闭；仅应用于标记为主动发送的消息。', 'x-hot': true },
  } },
};
