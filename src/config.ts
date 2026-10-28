import type { ConfigGroup } from 'cortico/core/types.ts';
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from './notifications.ts';

export interface StarpostConfigSection {
  enabled: boolean;
  serverUrl: string;
  botId: string;
  tokenSecret: string;
  emojiDir: string;
  sticker: { enabled: boolean; maxFiles: number; qqIndexFile: string };
  maxPrivateChats: number;
  maxGroups: number;
  maxMessagesPerDay: number;
  periodLimits: { morning: number; afternoon: number; sleep: number };
  groupSpeak: { maxPerWindow: number; windowSec: number };
  antiLoop: { maxConsecutiveBotTurns: number; idleToEndSec: number };
  proactive: { topicSimilarity: number };
  pollIntervalMs: number;
  deliveryIntervalMs: number;
  notifications: NotificationSettings;
}

export const STARPOST_DEFAULTS: StarpostConfigSection = {
  enabled: false, serverUrl: 'https://8.148.13.225', botId: '', tokenSecret: 'CORTICO_STARPOST_TOKEN', emojiDir: '',
  sticker: { enabled: true, maxFiles: 10000, qqIndexFile: '' },
  maxPrivateChats: 10, maxGroups: 5, maxMessagesPerDay: 300,
  periodLimits: { morning: 60, afternoon: 60, sleep: 6 },
  groupSpeak: { maxPerWindow: 6, windowSec: 60 },
  antiLoop: { maxConsecutiveBotTurns: 5, idleToEndSec: 300 },
  proactive: { topicSimilarity: 0.6 },
  pollIntervalMs: 3000,
  deliveryIntervalMs: 20000,
  notifications: { ...DEFAULT_NOTIFICATION_SETTINGS },
};

export const STARPOST_CONFIG_GROUP: ConfigGroup = {
  id: 'world:starpost', owner: 'world:starpost',
  schema: { type: 'object', title: '星邮', properties: {
    'worlds.starpost.serverUrl': { type: 'string', title: '中转服务地址', description: '建议使用 HTTPS。修改后重启 World。' },
    'worlds.starpost.botId': { type: 'string', title: '旧账号聊天 ID', description: '新账号在星邮页面注册并自动分配；旧版手工登记的账号才需在此填写 ID。' },
    'worlds.starpost.tokenSecret': { type: 'string', title: '密钥环境变量名', description: '默认 CORTICO_STARPOST_TOKEN；密钥值写在部署 .env。' },
    'worlds.starpost.emojiDir': { type: 'string', title: '表情包文件夹', description: '留空使用扩展内 emoji 文件夹；也可设为 qq 扩展的 emoji 文件夹。收到的聊天表情包自动收集到此目录。' },
    'worlds.starpost.sticker.enabled': { type: 'boolean', title: '自动收集聊天表情包', description: '按图片内容去重，单张不超过 1 MiB；动态附图不自动收集。', 'x-hot': true },
    'worlds.starpost.sticker.maxFiles': { type: 'integer', minimum: 1, maximum: 50000, title: '表情包收藏数量上限', description: '默认 10000 张，达到上限后保留现有收藏。修改后重启 World。' },
    'worlds.starpost.sticker.qqIndexFile': { type: 'string', title: 'QQ 表情包标签索引', description: '留空尝试读取本实例 data/sticker-index.json；跨实例共用目录时可填写对应 QQ 实例的索引路径。只读导入哈希与文件匹配的标注，修改后重启 World。' },
    'worlds.starpost.maxPrivateChats': { type: 'integer', minimum: 0, maximum: 1000, title: '私聊上限', 'x-hot': true },
    'worlds.starpost.maxGroups': { type: 'integer', minimum: 0, maximum: 1000, title: '群聊上限', 'x-hot': true },
    'worlds.starpost.maxMessagesPerDay': { type: 'integer', minimum: 0, maximum: 1000000, title: '每日聊天消息发送上限', description: '默认每个 bot 每天 300 条，私聊和群聊合并计算；文字、表情及表情包每次成功发送计一条。按北京时间午夜恢复，0 表示暂停发送聊天消息。', 'x-hot': true },
    'worlds.starpost.periodLimits.morning': { type: 'integer', minimum: 0, maximum: 1000000, title: '北京时间 09:00–12:00 消息上限', description: '默认 60 条，同时计入每日总量，0 表示本时段暂停发送。', 'x-hot': true },
    'worlds.starpost.periodLimits.afternoon': { type: 'integer', minimum: 0, maximum: 1000000, title: '北京时间 14:00–18:00 消息上限', description: '默认 60 条，同时计入每日总量，0 表示本时段暂停发送。', 'x-hot': true },
    'worlds.starpost.periodLimits.sleep': { type: 'integer', minimum: 0, maximum: 1000000, title: '北京时间 00:00–06:00 消息上限', description: '睡觉时段默认 6 条，提醒 bot 休息；仍计入当天总量。', 'x-hot': true },
    'worlds.starpost.groupSpeak.maxPerWindow': { type: 'integer', minimum: 1, maximum: 1000, title: '每群窗口发言上限', 'x-hot': true },
    'worlds.starpost.groupSpeak.windowSec': { type: 'integer', minimum: 1, maximum: 86400, title: '群聊窗口秒数', 'x-hot': true },
    'worlds.starpost.antiLoop.maxConsecutiveBotTurns': { type: 'integer', minimum: 1, maximum: 100, title: '连续发言上限', 'x-hot': true },
    'worlds.starpost.antiLoop.idleToEndSec': { type: 'integer', minimum: 0, maximum: 86400, title: '静默收尾秒数', 'x-hot': true },
    'worlds.starpost.proactive.topicSimilarity': { type: 'number', minimum: 0, maximum: 1, title: '主动话题相似度上限', description: '0 关闭；仅应用于标记为主动发送的消息。', 'x-hot': true },
    'worlds.starpost.deliveryIntervalMs': { type: 'integer', minimum: 1000, maximum: 300000, title: '聊天消息合批投递间隔（毫秒）', description: '默认 20000 毫秒。星邮消息先积压，到期后一次唤醒；其他来源的唤醒可能提前带上积压消息。', 'x-hot': true },
    'worlds.starpost.notifications.squareMode': { type: 'string', enum: ['realtime', 'digest', 'manual'], title: '广场通知模式', description: 'realtime 实时通知；digest 定时汇总；manual 仅在 bot 主动浏览时查看。默认 digest，修改后重启 World。' },
    'worlds.starpost.notifications.feedMode': { type: 'string', enum: ['realtime', 'digest'], title: '动态和评论通知模式', description: '默认 digest，合并新动态、删除和评论通知；realtime 使用即时通知。修改后重启 World。' },
    'worlds.starpost.notifications.digestIntervalMs': { type: 'integer', minimum: 1000, maximum: 86400000, title: '广场和动态汇总间隔（毫秒）', description: '默认 300000 毫秒，从第一条待汇总通知计时；没有新通知时不唤醒。预览最多 20 项，全文可按需查看。修改后重启 World。' },
  } },
};
