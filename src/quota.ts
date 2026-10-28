const PERIOD_HOURS = { sleep: [0, 6], early: [6, 9], morning: [9, 12], noon: [12, 14], afternoon: [14, 18], evening: [18, 24] } as const;
export interface MessageQuota {
  day: string; timezone: 'Asia/Shanghai'; observedAt: string; used: number; limit: number; remaining: number;
  period: { id: keyof typeof PERIOD_HOURS; startHour: number; endHour: number; startAt: string; endAt: string;
    used: number; limit: number | null; remaining: number | null; sleeping: boolean };
}
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export function parseMessageQuota(value: any): MessageQuota | null {
  if (!value || value.timezone !== 'Asia/Shanghai' || typeof value.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.day)
    || typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) || !count(value.used) || !count(value.limit)
    || value.remaining !== Math.max(0, value.limit - value.used)) return null;
  const p = value.period, hours = p && Object.hasOwn(PERIOD_HOURS, p.id) ? PERIOD_HOURS[p.id as keyof typeof PERIOD_HOURS] : null;
  if (!hours || p.startHour !== hours[0] || p.endHour !== hours[1] || !count(p.used)
    || (['sleep', 'morning', 'afternoon'].includes(p.id) ? !count(p.limit) : p.limit !== null)
    || p.remaining !== (p.limit === null ? null : Math.max(0, p.limit - p.used))
    || p.sleeping !== (p.id === 'sleep') || typeof p.startAt !== 'string' || typeof p.endAt !== 'string'
    || Date.parse(p.startAt) !== Date.parse(`${value.day}T00:00:00+08:00`) + p.startHour * 3600000
    || Date.parse(p.endAt) !== Date.parse(`${value.day}T00:00:00+08:00`) + p.endHour * 3600000
    || Date.parse(value.observedAt) < Date.parse(p.startAt) || Date.parse(value.observedAt) >= Date.parse(p.endAt)) return null;
  return { day: value.day, timezone: 'Asia/Shanghai', observedAt: value.observedAt, used: value.used, limit: value.limit, remaining: value.remaining,
    period: { id: p.id, startHour: p.startHour, endHour: p.endHour, startAt: p.startAt, endAt: p.endAt,
      used: p.used, limit: p.limit, remaining: p.remaining, sleeping: p.sleeping } };
}

// Build internal notices from validated counters and owned text, excluding server-provided prose.
export function quotaStatusText(quota: MessageQuota): string {
  const p = quota.period;
  return `北京时间 ${String(p.startHour).padStart(2, '0')}:00–${String(p.endHour % 24).padStart(2, '0')}:00：`
    + (p.limit === null ? `现在没有时段限制（本时段已发 ${p.used} 条）` : `现在时段上限：${p.used}/${p.limit}`)
    + `，今日上限：${quota.used}/${quota.limit}。`
    + (p.sleeping ? '现在是睡觉时间，请停止闲聊，该睡觉了；少量额度留给必要沟通。' : '请注意分配今天的消息额度。');
}
