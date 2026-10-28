import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync, mkdirSync, cpSync, chmodSync, writeFileSync } from 'node:fs';
import { resolve, join, sep, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function backupStarpost(dbFile, mediaDir, destination) {
  const source = resolve(dbFile), images = resolve(mediaDir), output = resolve(destination);
  if (!existsSync(source) || !existsSync(images)) throw new Error('数据库或图片目录不存在');
  if (output === images || output.startsWith(images + sep)) throw new Error('备份目录不能位于图片目录内');
  if (existsSync(output)) throw new Error('备份目录已存在，请使用新的目录');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    const target = join(output, 'data.sqlite');
    await backup(db, target);
    chmodSync(target, 0o600);
    // Images are immutable and are persisted before their database references commit.
    // Copying them after the SQLite snapshot includes every image that snapshot can reference.
    cpSync(images, join(output, 'media'), { recursive: true, filter: path => path === images || !basename(path).startsWith('.') });
    writeFileSync(join(output, 'backup.json'), JSON.stringify({ format: 1, createdAt: new Date().toISOString() }), { mode: 0o600 });
    return output;
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5) throw new Error('用法：node server/backup.mjs <数据库路径> <图片目录> <新的备份目录>');
  process.stdout.write(`${await backupStarpost(...process.argv.slice(2))}\n`);
}
