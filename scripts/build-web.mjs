import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

await build({ entryPoints:['src/title-style.ts'],outfile:'web/title-style.js',bundle:true,platform:'browser',format:'iife',globalName:'StarpostTitleStyles',target:'es2022',minify:true });

const root = new URL('../web/', import.meta.url);
const index = new URL('index.html', root);
let html = readFileSync(index, 'utf8');
for (const file of ['title-style.js', 'theme.js', 'background.js', 'game-ui.js', 'message-ui.js', 'voice-ui.js', 'history-search.js', 'chat-scroll.js', 'community.js', 'capsules.js', 'avatars.js', 'safety-ui.js', 'app.js', 'style.css']) {
  const hash = createHash('sha256').update(readFileSync(new URL(file, root))).digest('hex').slice(0, 16);
  const reference = new RegExp(`(["'])/${file.replace('.', '\\.')}(?:\\?[^"']*)?\\1`, 'g');
  html = html.replace(reference, `"/${file}?v=${hash}"`);
}
writeFileSync(index, html);
