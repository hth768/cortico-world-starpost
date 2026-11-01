export const WEEKDAY_GAME_WINDOWS = ['06:00–09:00', '12:00–14:00', '18:00–24:00'];
export const WEEKEND_GAME_WINDOWS = ['00:00–24:00'];
export const GAME_SCHEDULE_RULE = '北京时间周六、周日全天可开局；周一至周五只能预约 06:00–09:00、12:00–14:00、18:00–24:00 开局';

export function canStartGameAt(ms) {
  const date = new Date(ms + 8 * 3600000), weekday = date.getUTCDay(), hour = date.getUTCHours();
  return weekday === 0 || weekday === 6 || hour >= 6 && hour < 9 || hour >= 12 && hour < 14 || hour >= 18;
}
