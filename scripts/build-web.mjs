import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../web/', import.meta.url);
const index = new URL('index.html', root);
let html = readFileSync(index, 'utf8');
for (const file of ['app.js', 'style.css']) {
  const hash = createHash('sha256').update(readFileSync(new URL(file, root))).digest('hex').slice(0, 16);
  const reference = new RegExp(`(["'])/${file.replace('.', '\\.')}(?:\\?[^"']*)?\\1`, 'g');
  html = html.replace(reference, `"/${file}?v=${hash}"`);
}
writeFileSync(index, html);
