import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';

export function createPool(config) {
  const u = new URL(config.DATABASE_URL);
  return mysql.createPool({ host: u.hostname, port: Number(u.port || 3306),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: u.pathname.slice(1), timezone: 'Z', connectionLimit: 12,
    supportBigNumbers: true, bigNumberStrings: false,
    ssl: config.DATABASE_CA_FILE ? { ca: readFileSync(config.DATABASE_CA_FILE), rejectUnauthorized: true } : undefined,
    multipleStatements: false });
}

export async function rows(db, sql, values = []) {
  const [result] = await db.execute(sql, values);
  return result;
}

export async function transaction(pool, callback) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const result = await callback(db);
    await db.commit();
    return result;
  } catch (error) {
    await db.rollback();
    throw error;
  } finally { db.release(); }
}

// Admission, acquisition, settlement and payment adjustments share this lock order.
// The global row makes deployment capacity an exact transactional invariant.
export async function lockControl(db) {
  return (await rows(db, 'SELECT * FROM app_control WHERE id = 1 FOR UPDATE'))[0];
}

export const json = value => typeof value === 'string' ? JSON.parse(value) : value;
