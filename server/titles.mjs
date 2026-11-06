import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StarpostStorage } from './storage.mjs';
import { AccountTitles } from './account-titles.mjs';
import { TITLE_STYLE_PRESETS } from './title-styles.mjs';

// Local administrator command. No HTTP endpoint, shared password or client role.
const [operation, id, ...words] = process.argv.slice(2);
if(operation==='presets'){process.stdout.write(JSON.stringify(TITLE_STYLE_PRESETS,null,2)+'\n');process.exit(0);}
if (!process.env.STARPOST_DB_FILE || !existsSync(resolve(process.env.STARPOST_DB_FILE))) throw new Error('请显式指定已有 STARPOST_DB_FILE，不会创建新数据库。');
if (!['list', 'read', 'grant', 'style', 'revoke', 'history'].includes(operation) || !['list', 'history'].includes(operation) && !id || ['grant','style','revoke'].includes(operation) && !words.join(' ').trim()) throw new Error('用法：node server/titles.mjs presets | list | read ID | grant ID "头衔" [样式选项] | style ID 头衔ID [样式选项] | revoke ID 头衔ID或all | history [ID]');
const args=[],style={};
for(let i=0;i<words.length;i++){
  if(!words[i].startsWith('--')){args.push(words[i]);continue;}
  const key=words[i].slice(2),value=words[++i];
  if(!['grant','style'].includes(operation)||!['background','fill','font','weight','italic'].includes(key)||value===undefined)throw new Error('未知选项或缺少选项值');
  if(key==='italic'&&!['true','false'].includes(value))throw new Error('--italic 须为 true 或 false');
  style[key]=key==='italic'?value==='true':value;
}
if(['grant','style','revoke'].includes(operation)&&!args.join(' ').trim())throw new Error('缺少头衔文字或头衔 ID');
const keys = process.env.BOT_KEYS_FILE ? JSON.parse(readFileSync(process.env.BOT_KEYS_FILE, 'utf8')) : {};
const store = new StarpostStorage({ dbFile: process.env.STARPOST_DB_FILE, mediaDir: process.env.STARPOST_MEDIA_DIR });
const titles = new AccountTitles(store, { known: who => Object.hasOwn(keys, who) });
try {
  const result = operation === 'grant' ? titles.grant(id, args.join(' '), style) : operation === 'style' ? titles.restyle(id,args.join(' '),style) : operation === 'revoke' ? titles.revoke(id, args.join(' '))
    : operation === 'read' ? titles.inventory(titles.target(id))
    : operation === 'history' ? store.list('accountTitleAudit', id ? 'owner=?' : '1=1', id ? [titles.canonical(id)] : [], { limit: 100, reverse: true })
    : store.list('accountTitles', '1=1', [], { limit: -1 });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally { store.close(); }
