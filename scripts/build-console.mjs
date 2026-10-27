import { build } from 'esbuild';
await build({ entryPoints: ['src/console/client.ts'], outfile: 'dist/console.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true });
