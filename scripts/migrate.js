import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/app/config.js';
import { createPool, rows } from '../src/app/db.js';

const pool = createPool(loadConfig(process.env, 'migration'));
const db = await pool.getConnection();
try {
  const [lock] = await rows(db, "SELECT GET_LOCK('color-migrations',30) AS acquired");
  if (lock.acquired !== 1) throw new Error('Could not acquire migration lock');
  await rows(db, `CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(150) PRIMARY KEY,
    checksum CHAR(64) NOT NULL, applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)) ENGINE=InnoDB`);
  for (const name of (await readdir('migrations')).filter(n => n.endsWith('.sql')).sort()) {
    const sql = await readFile(`migrations/${name}`, 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const [existing] = await rows(db, 'SELECT checksum FROM schema_migrations WHERE name=?', [name]);
    if (existing) {
      if (existing.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
      continue;
    }
    // MySQL DDL commits implicitly. A partially failed migration requires the
    // documented operator recovery; never mark it applied or silently skip it.
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await rows(db, statement);
    await rows(db, 'INSERT INTO schema_migrations(name,checksum) VALUES(?,?)', [name, checksum]);
    console.log(`Applied ${name}`);
  }
} finally { db.release(); await pool.end(); }
