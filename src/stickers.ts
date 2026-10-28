import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { setImmediate } from 'node:timers/promises';

export const MAX_STICKER_BYTES = 1024 * 1024;
const exts: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const fields = ['emotion', 'usage', 'tag', 'label', 'note'] as const;
type Annotation = Record<typeof fields[number], string>;
interface StickerRecord {
  hash: string; file: string; firstSeen: number; lastSeen: number; count: number;
  sources: string[]; eventIds: string[]; annotations: Partial<Annotation>;
}
export interface StickerInfo extends Annotation {
  hash: string; file: string; firstSeen: number; lastSeen: number; count: number; sources: string[]; qqImported: boolean;
}
const clean = (value: unknown, max = 80) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : '';
export const stickerFilename = (value: string) => value.trim().replace(/^\[表情包:/, '').replace(/\]$/, '').trim();
const safeName = (file: string) => file === basename(file) && !/[\\/\x00-\x1f\x7f:]/.test(file)
  && file.length <= 120 && /\.(png|jpe?g|gif|webp)$/i.test(file);
export function stickerMime(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (b.subarray(0, 3).toString('hex') === 'ffd8ff') return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString())) return 'image/gif';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}
export function readStickerImage(directory: string, input: string): { file: string; bytes: Buffer; mime: string } {
  const file = stickerFilename(input);
  if (!safeName(file)) throw new Error('只接受表情包目录内的图片文件名');
  const root = realpathSync(resolve(directory)), path = realpathSync(join(root, file));
  const stat = statSync(path);
  if (!path.startsWith(root + sep) || !stat.isFile() || stat.size > MAX_STICKER_BYTES) throw new Error('图片不在表情包目录内或超过 1 MiB');
  const bytes = readFileSync(path), mime = stickerMime(bytes);
  if (!mime || bytes.length > MAX_STICKER_BYTES) throw new Error('图片格式不支持或超过 1 MiB');
  return { file, bytes, mime };
}

// QQ's index is read only. Local edits live in a separate, atomically replaced index.
export class StarpostStickerStore {
  private readonly records = new Map<string, StickerRecord>();
  private readonly qq = new Map<string, Partial<Annotation>>();
  private readonly files = new Map<string, { signature: string; hash: string }>();
  private refreshing: Promise<void> | null = null;
  private qqSignature = '';
  private qqWarning = '';
  private lastScan = -Infinity;
  constructor(readonly directory: string, private readonly indexFile: string, private readonly qqIndexFile: string,
    private readonly maxFiles = 10000, private readonly clock: () => number = Date.now) {
    if (existsSync(indexFile)) {
      if (statSync(indexFile).size > 16 * 1024 * 1024) throw new Error('星邮表情包索引过大');
      const saved = JSON.parse(readFileSync(indexFile, 'utf8'));
      if (saved?.version !== 1 || !Array.isArray(saved.records)) throw new Error('星邮表情包索引格式不合法');
      for (const row of saved.records.slice(0, maxFiles)) {
        if (!/^[a-f0-9]{64}$/.test(row?.hash) || typeof row.file !== 'string' || !safeName(row.file)) continue;
        this.records.set(row.hash, { hash: row.hash, file: row.file,
          firstSeen: Number(row.firstSeen) || 0, lastSeen: Number(row.lastSeen) || 0, count: Number(row.count) || 0,
          sources: Array.isArray(row.sources) ? row.sources.map((s: unknown) => clean(s, 160)).slice(-20) : [],
          eventIds: Array.isArray(row.eventIds) ? row.eventIds.filter((s: unknown) => typeof s === 'string').slice(-64) : [],
          annotations: Object.fromEntries(fields.filter(key => typeof row.annotations?.[key] === 'string')
            .map(key => [key, clean(row.annotations[key], key === 'note' ? 500 : 80)])) });
      }
    }
  }
  private save(): void {
    mkdirSync(dirname(this.indexFile), { recursive: true });
    const temp = `${this.indexFile}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, records: [...this.records.values()] }), { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temp, this.indexFile);
    } finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  private loadQQ(): void {
    if (!this.qqIndexFile || !existsSync(this.qqIndexFile)) { this.qq.clear(); this.qqSignature = ''; this.qqWarning = ''; return; }
    const stat = statSync(this.qqIndexFile), signature = `${stat.mtimeMs}:${stat.size}`;
    if (this.qqSignature === signature) return;
    try {
      if (stat.size > 16 * 1024 * 1024) throw new Error('QQ 表情包索引超过 16 MiB');
      const raw = JSON.parse(readFileSync(this.qqIndexFile, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('QQ 表情包索引格式不合法');
      const imported = new Map<string, Partial<Annotation>>();
      for (const row of Object.values(raw) as any[]) {
        if (!/^[a-f0-9]{64}$/.test(row?.hash) || typeof row.file !== 'string' || !safeName(row.file)) continue;
        // A matching hash must also have a matching file in the configured directory.
        if (this.files.get(row.file)?.hash !== row.hash) continue;
        imported.set(row.hash, Object.fromEntries(fields.map(key => [key, clean(row[key], key === 'note' ? 500 : 80)])
          .filter(([, value]) => value)));
      }
      this.qq.clear(); for (const [hash, annotation] of imported) this.qq.set(hash, annotation);
      this.qqSignature = signature; this.qqWarning = '';
    } catch (error) { this.qqWarning = `QQ 标签未导入：${(error as Error).message}`; }
  }
  private info(row: StickerRecord): StickerInfo {
    return { hash: row.hash, file: row.file, firstSeen: row.firstSeen, lastSeen: row.lastSeen, count: row.count, sources: [...row.sources],
      emotion: '未知', usage: '未知', tag: '', label: '表情包', note: '', ...this.qq.get(row.hash), ...row.annotations, qqImported: this.qq.has(row.hash) };
  }
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.scan();
    try { await this.refreshing; this.lastScan = this.clock(); } finally { this.refreshing = null; }
  }
  private async scan(): Promise<void> {
    mkdirSync(this.directory, { recursive: true });
    let changed = false, checked = 0;
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !safeName(entry.name)) continue;
      if (++checked > this.maxFiles) break;
      try {
        const stat = statSync(join(this.directory, entry.name)), signature = `${stat.mtimeMs}:${stat.size}`;
        if (stat.size > MAX_STICKER_BYTES) { this.files.delete(entry.name); this.qqSignature = ''; continue; }
        const cached = this.files.get(entry.name);
        if (cached?.signature === signature) continue;
        const { bytes } = readStickerImage(this.directory, entry.name), hash = createHash('sha256').update(bytes).digest('hex');
        this.files.set(entry.name, { signature, hash }); this.qqSignature = '';
        const row = this.records.get(hash);
        if (row) { if (!existsSync(join(this.directory, row.file))) { row.file = entry.name; changed = true; } }
        else if (this.records.size < this.maxFiles) {
          this.records.set(hash, { hash, file: entry.name, firstSeen: stat.mtimeMs, lastSeen: stat.mtimeMs, count: 0, sources: [], eventIds: [], annotations: {} }); changed = true;
        }
      } catch { this.files.delete(entry.name); this.qqSignature = ''; }
      if (checked % 32 === 0) await setImmediate();
    }
    for (const [file] of this.files) if (!existsSync(join(this.directory, file))) { this.files.delete(file); this.qqSignature = ''; }
    for (const [hash, row] of this.records) {
      if (this.files.get(row.file)?.hash === hash) continue;
      const matching = [...this.files].find(([, cached]) => cached.hash === hash)?.[0];
      if (matching) { row.file = matching; changed = true; }
      else if (!existsSync(join(this.directory, row.file)) || this.files.has(row.file)) { this.records.delete(hash); changed = true; }
    }
    this.loadQQ();
    if (changed) this.save();
  }
  async ingest(bytes: Uint8Array, mime: string, source: string, eventId: string): Promise<StickerInfo> {
    if (this.refreshing || this.clock() - this.lastScan >= 30000) await this.refresh();
    if (bytes.length > MAX_STICKER_BYTES || stickerMime(bytes) !== mime || !exts[mime]) throw new Error('表情包格式或大小不合法');
    const hash = createHash('sha256').update(bytes).digest('hex');
    let row = this.records.get(hash);
    if (!row && this.records.size >= this.maxFiles) throw new Error('表情包收藏已达数量上限');
    mkdirSync(this.directory, { recursive: true });
    const now = this.clock(), file = row?.file ?? `sticker-${hash.slice(0, 16)}${exts[mime]}`, path = join(this.directory, file);
    if (existsSync(path) || (() => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } })()) {
      const current = readStickerImage(this.directory, file);
      if (lstatSync(path).isSymbolicLink() || createHash('sha256').update(current.bytes).digest('hex') !== hash) throw new Error('表情包文件名冲突，未覆盖现有文件');
    } else writeFileSync(path, bytes, { flag: 'wx', mode: 0o600, flush: true });
    row ??= { hash, file, firstSeen: now, lastSeen: now, count: 0, sources: [], eventIds: [], annotations: {} };
    if (!row.eventIds.includes(eventId)) {
      row.count++; row.lastSeen = now; row.eventIds = [...row.eventIds, eventId].slice(-64);
      if (!row.sources.includes(source)) row.sources = [...row.sources, clean(source, 160)].slice(-20);
    }
    this.records.set(hash, row);
    const stat = statSync(path); this.files.set(file, { signature: `${stat.mtimeMs}:${stat.size}`, hash });
    this.qqSignature = ''; this.loadQQ(); this.save();
    return this.info(row);
  }
  async stats(query = '', limit = 20, offset = 0) {
    await this.refresh();
    const all = [...this.records.values()].map(row => this.info(row)).sort((a, b) => b.lastSeen - a.lastSeen || a.file.localeCompare(b.file));
    const q = clean(query, 200).toLocaleLowerCase(), matching = all.filter(row => !q || [row.file, row.label, row.tag, row.note, row.emotion, row.usage].some(s => s.toLocaleLowerCase().includes(q)));
    const byEmotion: Record<string, number> = Object.create(null);
    for (const row of all) byEmotion[row.emotion] = (byEmotion[row.emotion] ?? 0) + 1;
    const take = Number.isInteger(limit) ? Math.min(50, Math.max(1, limit)) : 20;
    const start = Number.isInteger(offset) ? Math.max(0, offset) : 0;
    return { total: all.length, matched: matching.length, byEmotion, qqImported: all.filter(row => row.qqImported).length,
      warning: this.qqWarning, items: matching.slice(start, start + take), nextOffset: matching.length > start + take ? start + take : null };
  }
  async tag(input: string, patch: Record<string, unknown>): Promise<StickerInfo> {
    await this.refresh();
    const wanted = stickerFilename(input).toLocaleLowerCase();
    const row = [...this.records.values()].find(row => row.file.toLocaleLowerCase() === wanted || row.hash === wanted
      || row.file.slice(0, -extname(row.file).length).toLocaleLowerCase() === wanted);
    if (!row) throw new Error('未找到表情包，请先查询真实文件名');
    if (!fields.some(key => patch[key] !== undefined)) throw new Error('至少填写一项标注');
    for (const key of fields) if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'string' || (patch[key] as string).length > (key === 'note' ? 500 : 80)) throw new Error('标注须为文本，备注最多 500 字，其余最多 80 字');
    }
    for (const key of fields) if (patch[key] !== undefined) row.annotations[key] = clean(patch[key], key === 'note' ? 500 : 80);
    this.save(); return this.info(row);
  }
}
