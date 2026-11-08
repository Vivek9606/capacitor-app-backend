import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message)
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, what, 'not_found')
export const forbidden = (what = 'Not allowed') => new HttpError(403, what, 'forbidden')
export const badRequest = (what: string) => new HttpError(400, what, 'bad_request')

/** Short, URL-safe random id with a type prefix, e.g. "pt_k3j9x2m1qa". */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10).padEnd(10, '0')}`
}

/** Client-supplied ids are accepted if they look like ours (lets the app stay optimistic). */
export const ID_RE = /^[a-z]{1,3}_[a-z0-9]{6,24}$/

/** Unguessable token for WhatsApp plan links. */
export function linkToken(): string {
  return randomBytes(12).toString('base64url')
}

export function otpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

/** Indian mobile → 10 digits, or undefined if invalid. */
export function normalizePhone(input: string): string | undefined {
  const d = input.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '')
  return /^[6-9]\d{9}$/.test(d) ? d : undefined
}

/** Today's date in India (the product's timezone), as YYYY-MM-DD. */
export function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return dt.toISOString().slice(0, 10)
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/^dr\.?\s+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40)
}

export function firstName(name: string): string {
  return name.replace(/^Dr\.?\s+/i, '').split(/\s+/)[0] ?? name
}

export function fmtDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)))
}

export function fmtTime(t: string): string {
  const [h, m] = t.split(':').map(Number)
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`
}
