import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StarpostStorage } from './storage.mjs';

const validBatch = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);

export function generateInvitations({ count = 100, outputPrefix, label = '测试注册码' }) {
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('数量须为 1 至 10000');
  if (!outputPrefix || typeof label !== 'string' || label.length > 80) throw new Error('请提供输出路径及不超过 80 字的备注');
  const prefix = resolve(outputPrefix), batchId = randomUUID(), createdAt = new Date().toISOString();
  const files = { text: `${prefix}.txt`, csv: `${prefix}.csv`, manifest: `${prefix}.hashes.json` };
  if (Object.values(files).some(path => existsSync(path))) throw new Error('输出文件已存在，拒绝覆盖注册码');
  mkdirSync(dirname(prefix), { recursive: true, mode: 0o700 });
  const codes = new Set();
  while (codes.size < count) codes.add(`SPT-${randomBytes(24).toString('hex')}`);
  const values = [...codes];
  // Only local delivery files contain plaintext; the import manifest contains hashes.
  const manifest = { version: 1, batchId, label, createdAt, hashes: values.map(code => createHash('sha256').update(code).digest('hex')) };
  writeFileSync(files.text, `${values.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  const csv = ['序号,注册码,最多注册账号数,批次', ...values.map((code, index) => `${index + 1},${code},1,${batchId}`)].join('\r\n');
  writeFileSync(files.csv, `\uFEFF${csv}\r\n`, { flag: 'wx', mode: 0o600 });
  writeFileSync(files.manifest, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { batchId, count, files };
}

export function importInvitations(store, manifest) {
  if (manifest?.version !== 1 || !validBatch(manifest.batchId) || typeof manifest.label !== 'string' || manifest.label.length > 80 ||
      typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || !Array.isArray(manifest.hashes) ||
      manifest.hashes.length < 1 || manifest.hashes.length > 10000 || manifest.hashes.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) ||
      new Set(manifest.hashes).size !== manifest.hashes.length) throw new Error('注册码导入文件不合法');
  let imported = 0;
  store.transaction(() => {
    for (const hash of manifest.hashes) {
      const existing = store.get('registrationCodes', hash);
      if (existing) {
        if (existing.batchId !== manifest.batchId) throw new Error('注册码与其他批次冲突');
        continue; // Reimporting must never reset redeemed or revoked codes.
      }
      store.put('registrationCodes', hash, { batchId: manifest.batchId, label: manifest.label, createdAt: manifest.createdAt, usedBy: null, usedAt: null, revoked: false });
      imported++;
    }
  });
  return { batchId: manifest.batchId, imported, ...invitationStatus(store, manifest.batchId) };
}

export function invitationStatus(store, batchId) {
  if (batchId !== undefined && !validBatch(batchId)) throw new Error('批次 ID 不合法');
  const values = store.list('registrationCodes', batchId === undefined ? '1' : 'owner=?', batchId === undefined ? [] : [batchId], { limit: -1 });
  return { total: values.length, unused: values.filter(value => !value.usedBy && !value.revoked).length, used: values.filter(value => Boolean(value.usedBy)).length, revoked: values.filter(value => value.revoked).length };
}

export function revokeInvitations(store, batchId) {
  if (!validBatch(batchId)) throw new Error('批次 ID 不合法');
  store.transaction(() => {
    const rows = store.statement("SELECT key,data FROM documents WHERE collection='registrationCodes' AND owner=?").all(batchId);
    for (const row of rows) store.put('registrationCodes', row.key, { ...JSON.parse(row.data), revoked: true });
  });
  return { batchId, ...invitationStatus(store, batchId) };
}

function options(args, allowed) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || !allowed.includes(args[i].slice(2)) || args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error('命令参数不合法');
    const key = args[i].slice(2);
    if (result[key] !== undefined) throw new Error('命令参数重复');
    result[key] = args[i + 1];
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  if (command === 'generate') {
    const args = options(process.argv.slice(3), ['count', 'output', 'label']);
    console.log(JSON.stringify(generateInvitations({ count: args.count === undefined ? 100 : Number(args.count), outputPrefix: args.output, label: args.label })));
  } else if (['import', 'status', 'revoke'].includes(command)) {
    const args = options(process.argv.slice(3), command === 'import' ? ['db', 'manifest', 'media-dir'] : ['db', 'batch', 'media-dir']);
    if (!args.db || !existsSync(args.db)) throw new Error('请提供已存在的数据库路径 --db');
    if (command === 'import' && !args.manifest) throw new Error('请提供哈希文件路径 --manifest');
    const store = new StarpostStorage({ dbFile: args.db, mediaDir: args['media-dir'] });
    try {
      const result = command === 'import' ? importInvitations(store, JSON.parse(readFileSync(args.manifest, 'utf8'))) :
        command === 'revoke' ? revokeInvitations(store, args.batch) : { batchId: args.batch, ...invitationStatus(store, args.batch) };
      console.log(JSON.stringify(result));
    } finally { store.close(); }
  } else throw new Error('用法：invitations.mjs generate|import|status|revoke；注册码明文只写入 generate 的 --output 文件');
}
