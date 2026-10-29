const fail = (message, status = 403) => { const e = new Error(message); e.status = status; throw e; };
const words = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ? value.trim() : fail('文本不合法', 400);
export function groupCanSpeak(g, who, now) {
  if (g.owner === who) return;
  if (Date.parse(g.mutedUntil?.[who] ?? '') > now) fail('你在此群被禁言');
  if ((g.admins ?? []).includes(who)) return;
  const date = new Date(now + 8 * 3600000), minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  for (const window of g.quietHours ?? []) {
    if (window.start < window.end ? minute >= window.start && minute < window.end : minute >= window.start || minute < window.end) fail('当前为群聊禁言时段（北京时间）');
  }
}
export function manageGroup(store, who, args, { group, emit, send, now, changed }) {
  const g = group(who, args.groupId), owner = g.owner === who, admins = g.admins ?? [];
  if (args.operation === 'info') return g;
  if (!owner && !admins.includes(who)) fail('只有群主或管理员可管理群聊');
  const target = args.botId;
  const member = () => {
    if (!g.members.includes(target)) fail('目标不在群中', 400);
    if (target === g.owner || !owner && admins.includes(target)) fail('不能管理群主或同级管理员');
  };
  let notice = {};
  switch (args.operation) {
    case 'admin':
      if (!owner) fail('只有群主可设置管理员');
      member();
      if (typeof args.enabled !== 'boolean') fail('enabled 须为布尔值', 400);
      g.admins = args.enabled ? [...new Set([...admins, target])] : admins.filter(id => id !== target);
      notice = { botId: target, enabled: args.enabled }; break;
    case 'mute': {
      member(); const minutes = args.minutes;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 43200) fail('禁言时长须为 1–43200 分钟', 400);
      g.mutedUntil = { ...g.mutedUntil, [target]: new Date(now + minutes * 60000).toISOString() };
      notice = { botId: target, until: g.mutedUntil[target] }; break;
    }
    case 'unmute': member(); g.mutedUntil ??= {}; delete g.mutedUntil[target]; notice = { botId: target }; break;
    case 'quiet': {
      if (!Array.isArray(args.windows) || args.windows.length > 8) fail('最多设置 8 个每日禁言时段', 400);
      const parse = value => {
        if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) fail('时间须为 HH:mm', 400);
        const [h, m] = value.split(':').map(Number); return h * 60 + m;
      };
      g.quietHours = args.windows.map(value => {
        const start = parse(value?.start), end = parse(value?.end);
        if (start === end) fail('起止时间不能相同', 400); return { start, end };
      }); notice = { windows: args.windows, timezone: 'Asia/Shanghai' }; break;
    }
    case 'title': if (!(owner && target === who)) member(); g.titles = { ...g.titles, [target]: words(args.title, 32) }; notice = { botId: target, title: g.titles[target] }; break;
    case 'kick':
      member(); g.members = g.members.filter(id => id !== target); g.admins = admins.filter(id => id !== target);
      if (g.mutedUntil) delete g.mutedUntil[target]; if (g.titles) delete g.titles[target];
      changed(g.id, target); notice = { botId: target }; break;
    case 'announce': {
      const text = words(args.text, 2000); if (!text) fail('公告不能为空', 400);
      send(who, { kind: 'group', target: g.id, text: `【群公告】${text}`, mentionAll: true });
      g.announcement = { text, author: who, at: new Date(now).toISOString() }; notice = g.announcement; break;
    }
    case 'mention_all': {
      const text = words(args.text, 2000); if (!text) fail('消息不能为空', 400);
      return send(who, { kind: 'group', target: g.id, text, mentionAll: true });
    }
    default: fail('未知群管理操作', 400);
  }
  store.saveGroup(g);
  emit([...new Set([...g.members, ...(args.operation === 'kick' ? [target] : [])])], 'group.managed', { groupId: g.id, operation: args.operation, actor: who, ...notice });
  return { groupId: g.id, updated: true };
}
