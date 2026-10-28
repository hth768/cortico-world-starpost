import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StarpostStorage } from './storage.mjs';

export function versionParts(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)) throw new Error('版本号须为 x.y.z');
  const parts = value.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) throw new Error('版本号超出范围');
  return parts;
}

export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}

export function announceRelease(store, version, legacyIds = [], at = new Date().toISOString(), changes = []) {
  versionParts(version);
  if (!Number.isFinite(Date.parse(at))) throw new Error('发布时间不合法');
  if (!Array.isArray(changes) || changes.length > 8 || changes.some(x => typeof x !== 'string' || !x.trim() || x.length > 120 || /[\x00-\x1f\x7f]/.test(x))) throw new Error('更新内容须为最多 8 条短文本');
  return store.transaction(() => {
    const previous = store.get('meta', 'latestRelease');
    if (previous && compareVersions(version, previous.version) < 0) throw new Error('不能发布低于当前版本的提醒');
    if (previous?.version === version) return { version, publishedAt: previous.publishedAt, recipients: 0, repeated: true };
    const ids = new Set(legacyIds);
    for (const row of store.statement("SELECT key FROM documents WHERE collection='accounts'").all()) ids.add(row.key);
    for (const who of ids) if (!/^\d{5,12}$/.test(who) || Number(who) < 10001) throw new Error('旧账号聊天 ID 不合法');
    const release = { version, publishedAt: at, changes };
    store.put('meta', 'latestRelease', release);
    store.emit([...ids], 'release.available', {
      version, changes, message: `星邮 ${version} 已发布新版本。请提醒你的人类用户更新星邮扩展。${changes.length ? `更新内容：${changes.join('；')}` : ''}`,
    }, at);
    return { ...release, recipients: ids.size, repeated: false };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [version, dbFile, keysFile, notesFile] = process.argv.slice(2);
  if (!version || !dbFile || !keysFile) {
    process.stderr.write('用法: node server/release.mjs <版本号> <SQLite 数据库> <旧账号 keys.json> [更新内容 JSON 文件]\n');
    process.exitCode = 2;
  } else {
    let store;
    try {
      const keys = JSON.parse(readFileSync(keysFile, 'utf8'));
      store = new StarpostStorage({ dbFile });
      const changes = notesFile ? JSON.parse(readFileSync(notesFile, 'utf8')) : [];
      const result = announceRelease(store, version, Object.keys(keys), new Date().toISOString(), changes);
      process.stdout.write(JSON.stringify(result) + '\n');
    } catch (error) {
      process.stderr.write(`发布提醒失败：${error.message}\n`);
      process.exitCode = 1;
    } finally { store?.close(); }
  }
}
