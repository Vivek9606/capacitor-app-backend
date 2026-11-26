import { readFileSync } from 'node:fs'

// TLS for the Postgres connection.
// - Local Postgres (dev/testing): no TLS.
// - DB_CA_FILE set (AWS RDS: the image ships Amazon's RDS certificate bundle): verify the server certificate.
// - Otherwise (Supabase pooler, whose chain isn't in Node's default store): encrypt without verifying.
export function dbSsl(url: string) {
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(url)) return false
  const ca = process.env.DB_CA_FILE
  if (ca) return { ca: readFileSync(ca, 'utf8'), rejectUnauthorized: true }
  return { rejectUnauthorized: false }
}
