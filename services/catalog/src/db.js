import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({ ...config.db, timezone: 'Z', connectionLimit: 10 });

export async function query(sql, params = [], conn = pool) {
  const [rows] = await conn.execute(sql, params);
  return rows;
}

export async function transaction(work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
