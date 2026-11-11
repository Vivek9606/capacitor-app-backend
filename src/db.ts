import pg from 'pg'
import { env } from './env.js'

// Return DATE columns as 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v)

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Supabase requires TLS. Its pooler certificate chain isn't in Node's default store.
  // A local Postgres (dev/testing) has no TLS.
  ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(env.DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  options: '-c search_path=app',
})

pool.on('error', (err) => console.error('pg pool error', err))

export async function q<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query<T>(text, params)
  return res.rows
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await q<T>(text, params)
  return rows[0]
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const out = await fn(client)
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback')
    throw e
  } finally {
    client.release()
  }
}
