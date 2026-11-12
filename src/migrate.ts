import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import 'dotenv/config'

// Applies migrations/*.sql in order, once each. Safe to run on every deploy.
const here = dirname(fileURLToPath(import.meta.url))
const dir = join(here, '..', 'migrations')

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  // Tables live in the "app" schema (see 001); default to it so a migration that forgets `set search_path` still works.
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, options: '-c search_path=app' })
  await client.connect()
  try {
    await client.query('create table if not exists public.betterhood_migrations (name text primary key, applied_at timestamptz not null default now())')
    await client.query('alter table public.betterhood_migrations enable row level security')
    const done = new Set((await client.query<{ name: string }>('select name from public.betterhood_migrations')).rows.map((r) => r.name))
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
    for (const f of files) {
      if (done.has(f)) continue
      const sql = await readFile(join(dir, f), 'utf8')
      console.log(`applying ${f}`)
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into public.betterhood_migrations (name) values ($1)', [f])
        await client.query('commit')
      } catch (e) {
        await client.query('rollback')
        throw e
      }
    }
    console.log('migrations up to date')
  } finally {
    await client.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
