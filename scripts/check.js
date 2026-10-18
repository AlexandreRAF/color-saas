import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

async function walk(directory) {
  const files = await readdir(directory, { withFileTypes: true });
  for (const file of files) {
    const path = `${directory}/${file.name}`;
    if (file.isDirectory()) await walk(path);
    else if (file.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
for (const dir of ['src/app', 'scripts', 'tests']) await walk(dir);
console.log('Application JavaScript syntax checks passed');
