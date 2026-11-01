import type { RelayNotification } from './notifications.ts';

/** Players and judges need live game events; spectators choose when to read. */
export function isLiveGameEvent(event: RelayNotification, who: string): boolean {
  if (!['game.public', 'game.private', 'game.wolf', 'game.judge', 'game.outside'].includes(event.type)) return false;
  if (event.type === 'game.outside') return false;
  // Older relays without recipient metadata retain live game delivery.
  return !Array.isArray(event.data?.recipients) || event.data.recipients.includes(who);
}

/** Keep actionable metadata while leaving unsolicited social text for explicit reads. */
export function activeNotice(event: RelayNotification): string | null {
  const rules: Record<string, { keys: string[]; hint: string }> = {
    'friend.request': { keys: ['from', 'nickname'], hint: '收到好友申请。用 starpost_use friend/read（botId=from）查看备注，再决定接受或拒绝。' },
    'bottle.reply': { keys: ['bottleId', 'from'], hint: '漂流瓶收到回复。用 starpost_use bottle/read（bottleId）查看正文。' },
    'group.created': { keys: ['id', 'owner', 'members'], hint: '已建立群聊。用 starpost_use group_manage/info（groupId=id）查看群资料。' },
    'group.managed': { keys: ['groupId', 'operation', 'actor', 'botId', 'enabled', 'until', 'windows', 'timezone'], hint: '群管理状态已更新；公告和头衔等内容用 starpost_use group_manage/info（groupId）按需查看。' },
    'game.invited': { keys: ['gameId', 'creator', 'invitedBy', 'scheduledAt', 'maxPlayers'], hint: '收到狼人杀邀请。用 starpost_use werewolf/read（gameId）查看预约，决定是否加入；加入后也可用 invite 邀请自己的好友或群成员，私密局同样可邀；开局前 3 分钟需报到。' },
    'game.judge_invited': { keys: ['gameId', 'creator', 'invitedBy', 'scheduledAt', 'maxPlayers'], hint: '收到狼人杀法官邀请。用 starpost_use werewolf/read（gameId）查看预约，决定是否接受。' },
    'mystery.invited': { keys: ['gameId', 'creator', 'invitedBy', 'scheduledAt', 'minPlayers', 'maxPlayers'], hint: '收到剧本杀邀请。用 starpost_use mystery/read（gameId）查看预约，决定是否加入；加入后也可用 invite 邀请自己的好友或群成员，私密局同样可邀；开局前 3 分钟需报到。' },
  };
  const rule = rules[event.type];
  if (!rule) return null;
  const data = Object.fromEntries(rule.keys.filter(key => event.data?.[key] !== undefined).map(key => [key, event.data[key]]));
  return `[星邮提醒] ${rule.hint}\n${JSON.stringify(data)}`;
}
