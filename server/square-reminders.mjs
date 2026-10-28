export class SquareReminders {
  constructor(store, timezone) {
    this.store = store;
    this.timezone = timezone;
    this.day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    if (store.get('meta', 'squareRemindersVersion') !== 1) {
      store.transaction(() => {
        const latest = store.statement(`SELECT data FROM documents WHERE collection='square' AND rowid IN (
          SELECT max(rowid) FROM documents WHERE collection='square' GROUP BY kind,target
        )`);
        for (const row of latest.iterate()) this.schedule(JSON.parse(row.data));
        store.put('meta', 'squareRemindersVersion', 1);
      });
    }
    // Calendar-day quotas follow the current server timezone after configuration changes.
    const changed = store.list('squareReminders', "json_extract(data,'$.kind')='group' AND json_extract(data,'$.timezone')<>?", [timezone], { limit: -1 });
    if (changed.length) store.transaction(() => {
      for (const reminder of changed) {
        const entry = store.get('square', reminder.listingId);
        if (entry) this.schedule(entry);
      }
    });
  }

  nextDay(at) {
    const start = Date.parse(at), day = this.day.format(start);
    let low = start, high = start + 48 * 60 * 60 * 1000;
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (this.day.format(middle) === day) low = middle; else high = middle;
    }
    return new Date(high).toISOString();
  }

  schedule(entry) {
    if (!['bot', 'group'].includes(entry.kind)) return;
    const key = `${entry.kind}:${entry.target}`;
    const owner = entry.kind === 'group' ? this.store.get('groups', entry.target)?.owner : entry.author;
    if (!owner) { this.store.remove('squareReminders', key); return; }
    const availableAt = entry.kind === 'bot' ? new Date(Date.parse(entry.at) + 12 * 60 * 60 * 1000).toISOString() : this.nextDay(entry.at);
    const previous = this.store.get('squareReminders', key);
    const notifiedAt = previous?.listingId === entry.id && previous.availableAt === availableAt ? previous.notifiedAt : null;
    this.store.put('squareReminders', key, { kind: entry.kind, target: entry.target, owner, listingId: entry.id, availableAt, notifiedAt, timezone: this.timezone });
  }

  groupChanged(groupId, owner) {
    const key = `group:${groupId}`, reminder = this.store.get('squareReminders', key);
    if (!reminder) return;
    if (!owner) this.store.remove('squareReminders', key);
    else if (reminder.owner !== owner) this.store.put('squareReminders', key, { ...reminder, owner });
  }

  hasDue(who, now) {
    return this.store.count('squareReminders', "owner=? AND kind='pending' AND at<=?", [who, new Date(now).toISOString()]) > 0;
  }

  nextDueMs(who, now) {
    const row = this.store.statement("SELECT min(at) AS next FROM documents WHERE collection='squareReminders' AND owner=? AND kind='pending'").get(who);
    return row?.next ? Math.max(0, Date.parse(row.next) - now) : Infinity;
  }

  deliver(who, now, discoverable) {
    const due = this.store.list('squareReminders', "owner=? AND kind='pending' AND at<=?", [who, new Date(now).toISOString()], { limit: -1 });
    for (const reminder of due) {
      const key = `${reminder.kind}:${reminder.target}`;
      if (reminder.kind === 'group') {
        const group = this.store.get('groups', reminder.target);
        if (!group || group.owner !== who) { this.groupChanged(reminder.target, group?.owner); continue; }
      }
      const subject = reminder.kind === 'bot' ? '个人展示' : `群聊 ${reminder.target} 宣传`;
      const availability = discoverable ? '现在可以发布新的广场消息。' : '账号目前不可见，发布前需要先设为可见。';
      const message = `星邮广场：${subject}的等待时间已结束。${availability}是否发布由你自己决定，也可以不发。`;
      this.store.emit([who], 'square.ready', { kind: reminder.kind, target: reminder.target, listingId: reminder.listingId, availableAt: reminder.availableAt, discoverable, message }, new Date(now).toISOString());
      this.store.put('squareReminders', key, { ...reminder, notifiedAt: new Date(now).toISOString() });
    }
  }
}
