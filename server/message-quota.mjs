const HOUR_MS = 60 * 60 * 1000;
export const MESSAGE_PERIODS = [
  { id: 'sleep', startHour: 0, endHour: 6, limitKey: 'sleep', defaultLimit: 6 },
  { id: 'early', startHour: 6, endHour: 9 },
  { id: 'morning', startHour: 9, endHour: 12, limitKey: 'morning', defaultLimit: 60 },
  { id: 'noon', startHour: 12, endHour: 14 },
  { id: 'afternoon', startHour: 14, endHour: 18, limitKey: 'afternoon', defaultLimit: 60 },
  { id: 'evening', startHour: 18, endHour: 24 },
];

export class MessageQuota {
  constructor(store) { this.store = store; }
  read(who, now) {
    const shifted = new Date(now + 8 * HOUR_MS), day = shifted.toISOString().slice(0, 10);
    const midnight = Date.parse(`${day}T00:00:00+08:00`), limits = this.store.get('limits', who);
    const rule = MESSAGE_PERIODS.find(period => shifted.getUTCHours() < period.endHour);
    const count = (start, end) => this.store.count('messages', 'owner=? AND at>=? AND at<?',
      [who, new Date(start).toISOString(), new Date(end).toISOString()]);
    const saved = this.store.get('messageQuota', who);
    const used = saved?.day === day && saved.timezone === 'Asia/Shanghai' && Number.isSafeInteger(saved.used) && saved.used >= 0
      ? saved.used : count(midnight, midnight + 24 * HOUR_MS);
    const limit = limits?.maxMessagesPerDay ?? 300;
    const periodLimit = rule.limitKey ? limits?.periods?.[rule.limitKey] ?? rule.defaultLimit : null;
    const periodUsed = count(midnight + rule.startHour * HOUR_MS, midnight + rule.endHour * HOUR_MS);
    const period = { id: rule.id, startHour: rule.startHour, endHour: rule.endHour,
      startAt: new Date(midnight + rule.startHour * HOUR_MS).toISOString(), endAt: new Date(midnight + rule.endHour * HOUR_MS).toISOString(),
      used: periodUsed, limit: periodLimit, remaining: periodLimit === null ? null : Math.max(0, periodLimit - periodUsed), sleeping: rule.id === 'sleep' };
    const statusText = `北京时间 ${String(rule.startHour).padStart(2, '0')}:00–${String(rule.endHour % 24).padStart(2, '0')}:00：`
      + (periodLimit === null ? `现在没有时段限制（本时段已发 ${periodUsed} 条）` : `现在时段上限：${periodUsed}/${periodLimit}`)
      + `，今日上限：${used}/${limit}。` + (period.sleeping ? '现在是睡觉时间，请停止闲聊，该睡觉了；少量额度留给必要沟通。' : '请注意分配今天的消息额度。');
    return { day, timezone: 'Asia/Shanghai', observedAt: new Date(now).toISOString(), used, limit,
      remaining: Math.max(0, limit - used), period, statusText };
  }
  record(who, quota) { this.store.put('messageQuota', who, { day: quota.day, timezone: 'Asia/Shanghai', used: quota.used + 1 }); }
}
