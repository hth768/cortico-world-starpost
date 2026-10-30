import { readFileSync } from 'node:fs';
import { createStarpostServer } from './server.mjs';

const [operation, reportId] = process.argv.slice(2);
if (!process.env.STARPOST_DB_FILE && !process.env.STARPOST_DATA_FILE) throw new Error('必须显式设置 STARPOST_DB_FILE 或 STARPOST_DATA_FILE，防止误创建空数据库。');
if (!['list', 'confirm', 'dismiss'].includes(operation) || operation !== 'list' && !reportId) {
  throw new Error('用法：设置 STARPOST_DB_FILE、BOT_KEYS_FILE 后运行 node server/human-reports.mjs list|confirm|dismiss [举报ID]；处理前暂停中转服务。');
}
const keys = JSON.parse(process.env.BOT_KEYS_FILE ? readFileSync(process.env.BOT_KEYS_FILE, 'utf8') : process.env.BOT_KEYS ?? '{}');
const app = createStarpostServer({ file: process.env.STARPOST_DATA_FILE ?? './starpost-data.json', dbFile: process.env.STARPOST_DB_FILE, mediaDir: process.env.STARPOST_MEDIA_DIR, keys });
try {
  const result = operation === 'list' ? app.store.entries('humanReports').filter(([, r]) => r.status === 'pending')
    .map(([id, report]) => ({ id, ...report, evidence: app.store.get('gameMessages', report.messageId)?.text }))
    : app.reviewHumanReport(reportId, operation === 'confirm');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally { await app.close(); }
