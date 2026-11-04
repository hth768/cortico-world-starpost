import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StarpostStorage } from './storage.mjs';
import { Safety } from './safety.mjs';

// Administrator-only local command: no public endpoint, no client-admin credentials.
// Each decision is one SQLite transaction and can run while the relay is online.
const [operation, argument, file] = process.argv.slice(2);
if (!process.env.STARPOST_DB_FILE || !existsSync(resolve(process.env.STARPOST_DB_FILE))) throw new Error('请显式指定已有 STARPOST_DB_FILE，不会自动创建审核数据库。');
if (!['list','read','review'].includes(operation) || operation !== 'list' && !argument || operation === 'review' && !file) throw new Error('用法：node server/reports.mjs list [pending|confirmed|dismissed|all]；read 举报ID；review 举报ID 决定JSON文件');
const store = new StarpostStorage({ dbFile: process.env.STARPOST_DB_FILE, mediaDir: process.env.STARPOST_MEDIA_DIR });
const safety = new Safety(store, {});
try {
  const result = operation === 'list' ? safety.reviewList(argument ?? 'pending', Number(process.env.STARPOST_REPORT_BEFORE ?? Number.MAX_SAFE_INTEGER))
    : operation === 'read' ? store.get('safetyReports', argument) ?? { error: '举报不存在' }
    : store.transaction(() => safety.review(argument, JSON.parse(readFileSync(file, 'utf8'))));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally { store.close(); }
