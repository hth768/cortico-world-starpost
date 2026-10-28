import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backupStarpost } from './backup.mjs';
import { StarpostStorage } from './storage.mjs';

const IMAGE_NAME = /^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/;
const AUTO_BACKUP = /^auto-(\d{4}-\d{2}-\d{2})$/;
const DAY_MS = 86400000;
const imageExtension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function safeDirectory(path) {
  const target = resolve(path);
  if (!existsSync(target) || !lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink()) throw new Error(`目录不存在或不是普通目录：${target}`);
  return realpathSync(target);
}
function childDirectory(root, name) {
  if (!AUTO_BACKUP.test(name)) throw new Error('自动备份名称不合法');
  const target = resolve(root, name);
  if (!target.startsWith(root + sep) || !existsSync(target) || !lstatSync(target).isDirectory() || lstatSync(target).isSymbolicLink() || realpathSync(target) !== target) throw new Error('自动备份目录不安全');
  return target;
}
function beijingDay(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}
function weekOf(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}
function validateBackup(directory) {
  const marker = JSON.parse(readFileSync(join(directory, 'backup.json'), 'utf8'));
  if (marker?.format !== 1 || !Number.isFinite(Date.parse(marker.createdAt))) throw new Error('备份完成标记无效');
  safeDirectory(join(directory, 'media'));
  const file = join(directory, 'data.sqlite');
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('备份数据库文件不安全');
  const db = new DatabaseSync(file, { readOnly: true });
  try { if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('备份数据库完整性检查失败'); }
  finally { db.close(); }
  return marker;
}
function mediaSize(mediaDir) {
  let bytes = 0;
  for (const name of readdirSync(mediaDir)) {
    const path = join(mediaDir, name);
    if (lstatSync(path).isFile()) bytes += statSync(path).size;
  }
  return bytes;
}
export async function createDailyBackup({ dbFile, mediaDir, backupRoot, now = Date.now() }) {
  const root = safeDirectory(backupRoot), media = safeDirectory(mediaDir);
  const destination = join(root, `auto-${beijingDay(now)}`);
  let repeated = false;
  if (existsSync(destination)) {
    childDirectory(root, basename(destination));
    validateBackup(destination);
    repeated = true;
  } else {
    const disk = statfsSync(root);
    const available = disk.bavail * disk.bsize;
    const estimate = statSync(dbFile).size + mediaSize(media);
    if (available < Math.ceil(estimate * 1.2) + 1024 ** 3) throw new Error('剩余空间不足以安全创建新备份');
    await backupStarpost(dbFile, media, destination);
    validateBackup(destination);
  }
  const names = readdirSync(root).filter(name => AUTO_BACKUP.test(name)).sort().reverse();
  const valid = [], invalid = [];
  for (const name of names) {
    try { validateBackup(childDirectory(root, name)); valid.push(name); }
    catch { invalid.push(name); }
  }
  const keep = new Set(valid.slice(0, 7));
  const weeks = new Set(valid.slice(0, 7).map(name => weekOf(AUTO_BACKUP.exec(name)[1])));
  let weekly = 0;
  for (const name of valid.slice(7)) {
    const week = weekOf(AUTO_BACKUP.exec(name)[1]);
    if (weekly >= 4) break;
    if (!weeks.has(week)) { weeks.add(week); keep.add(name); weekly++; }
  }
  const removed = [];
  for (const name of valid) {
    if (keep.has(name) || name === basename(destination)) continue;
    rmSync(childDirectory(root, name), { recursive: true });
    removed.push(name);
  }
  return { destination, repeated, removed, invalid };
}

function collectReferences(dbFile) {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const refs = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.mediaId === 'string' && /^[a-f0-9]{64}$/.test(value.mediaId) && imageExtension[value.mime]) refs.add(`${value.mediaId}.${imageExtension[value.mime]}`);
    if (Array.isArray(value)) for (const item of value) visit(item);
    else for (const item of Object.values(value)) if (item && typeof item === 'object') visit(item);
  }
  try {
    for (const row of db.prepare('SELECT data FROM documents').iterate()) visit(JSON.parse(row.data));
    for (const row of db.prepare('SELECT data FROM events').iterate()) visit(JSON.parse(row.data));
  } finally { db.close(); }
  return refs;
}
function readManifest(path) {
  if (!existsSync(path)) return { version: 1, observedAt: '', candidates: [] };
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value?.version !== 1 || !Number.isFinite(Date.parse(value.observedAt)) || !Array.isArray(value.candidates) || value.candidates.length > 1000000 || value.candidates.some(item => !item || !IMAGE_NAME.test(item.name) || !Number.isSafeInteger(item.size) || !Number.isFinite(item.mtimeMs))) throw new Error('图片清理清单损坏');
  return value;
}
function manifestPath(stateDir) { return join(safeDirectory(stateDir), 'pending-media-gc.json'); }
function imageCandidates(mediaDir, refs, now) {
  const candidates = [];
  for (const name of readdirSync(mediaDir)) {
    if (!IMAGE_NAME.test(name) || refs.has(name)) continue;
    const path = join(mediaDir, name), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || now - info.mtimeMs < 7 * DAY_MS) continue;
    candidates.push({ name, size: info.size, mtimeMs: info.mtimeMs });
  }
  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}
export function scanOrphanMedia({ dbFile, mediaDir, stateDir, now = Date.now() }) {
  const media = safeDirectory(mediaDir), path = manifestPath(stateDir);
  const candidates = imageCandidates(media, collectReferences(dbFile), now);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: 1, observedAt: new Date(now).toISOString(), candidates }), { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
  return { candidates: candidates.length, bytes: candidates.reduce((sum, item) => sum + item.size, 0), manifest: path };
}
export function pendingSweep({ stateDir, now = Date.now() }) {
  const manifest = readManifest(manifestPath(stateDir));
  return manifest.candidates.length > 0 && now - Date.parse(manifest.observedAt) >= DAY_MS;
}
export function sweepOrphanMedia({ dbFile, mediaDir, stateDir, now = Date.now(), offline = false }) {
  if (!offline) throw new Error('图片删除须在中转服务停止后运行');
  const media = safeDirectory(mediaDir), manifest = readManifest(manifestPath(stateDir));
  if (!manifest.candidates.length || now - Date.parse(manifest.observedAt) < DAY_MS) return { removed: 0, bytes: 0 };
  const current = new Map(imageCandidates(media, collectReferences(dbFile), now).map(item => [item.name, item]));
  let removed = 0, bytes = 0;
  for (const old of manifest.candidates) {
    const next = current.get(old.name);
    if (!next || next.size !== old.size || next.mtimeMs !== old.mtimeMs) continue;
    const path = join(media, old.name);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) continue;
    unlinkSync(path); removed++; bytes += old.size;
  }
  return { removed, bytes };
}

export function checkDisk({ dbFile, diskPath, adminBotId = '', now = Date.now(), usageOverride }) {
  const disk = statfsSync(diskPath);
  const total = disk.blocks * disk.bsize, available = disk.bavail * disk.bsize;
  const percent = usageOverride ?? Math.round(100 * (1 - available / total));
  const level = percent >= 85 ? 85 : percent >= 70 ? 70 : 0;
  const store = new StarpostStorage({ dbFile });
  try {
    return store.transaction(() => {
      const previous = store.get('meta', 'diskAlertLevel') ?? 0;
      const at = new Date(now).toISOString();
      if (level > previous && adminBotId) {
        if (!/^\d{5,12}$/.test(adminBotId)) throw new Error('管理员 bot ID 不合法');
        store.emit([adminBotId], 'maintenance.warning', { threshold: level, percent, availableBytes: available, at }, at);
      }
      if (level !== previous) store.put('meta', 'diskAlertLevel', level > previous && !adminBotId ? previous : level);
      store.put('meta', 'lastMaintenance', { at, diskUsedPercent: percent, diskFreeBytes: available });
      return { percent, availableBytes: available, threshold: level, alerted: level > previous && Boolean(adminBotId) };
    });
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, dbFile, mediaDir, backupRoot, stateDir] = process.argv.slice(2);
  if (!['backup', 'scan', 'pending', 'sweep', 'alert'].includes(command) || !dbFile || !mediaDir || !backupRoot || !stateDir) throw new Error('用法：maintenance.mjs backup|scan|pending|sweep|alert <SQLite> <图片目录> <备份目录> <状态目录>');
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const options = { dbFile, mediaDir, backupRoot, stateDir };
  let result;
  if (command === 'backup') result = await createDailyBackup(options);
  else if (command === 'scan') result = scanOrphanMedia(options);
  else if (command === 'pending') { result = pendingSweep(options); if (!result) process.exitCode = 1; }
  else if (command === 'sweep') result = sweepOrphanMedia({ ...options, offline: process.env.STARPOST_MAINTENANCE_OFFLINE === '1' });
  else result = checkDisk({ dbFile, diskPath: backupRoot, adminBotId: process.env.STARPOST_ADMIN_BOT_ID ?? '' });
  process.stdout.write(JSON.stringify({ command, result }) + '\n');
}
