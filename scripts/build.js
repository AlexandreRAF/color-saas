import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

await mkdir('dist/assets', { recursive: true });
await cp('public', 'dist', { recursive: true });
await build({ entryPoints: ['web/app.jsx'], outdir: 'dist/assets', entryNames: 'app', bundle: true,
  minify: true, sourcemap: false, target: ['es2022'], format: 'esm', legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' } });
console.log('Built public pages and React application in dist/');
