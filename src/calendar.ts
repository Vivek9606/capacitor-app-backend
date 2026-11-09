import { q } from './db.js'
import { addDays, HttpError, todayIST } from './util.js'

// Server-side mirror of the app's slot rules (capacitor-app-physio/src/lib/slots.ts), used to
// reject bookings made by patients / the public page that don't fit the physio's calendar.

type Row = Record<string, any>
type Range = { start: string; end: string }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
const OCCUPYING = ['requested', 'awaiting', 'confirmed', 'reminder_sent', 'reschedule', 'checked_in', 'done']

function dayOf(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

export function availabilityOf(p: Row) {
  if (p.availability) return p.availability as { weekly: Record<string, Range[]>; bufferMin: number; minNoticeHours: number; maxDaysAhead: number }
  const start: string = p.hours?.start ?? '09:00'
  const end: string = p.hours?.end ?? '18:30'
  const windows: Range[] = toMin(start) < 13 * 60 && toMin(end) > 14 * 60 ? [{ start, end: '13:00' }, { start: '14:00', end }] : [{ start, end }]
  const working: string[] = p.working_days ?? []
  return { weekly: Object.fromEntries(DAYS.map((d) => [d, working.includes(d) ? windows : []])), bufferMin: 0, minNoticeHours: 2, maxDaysAhead: 30 }
}

export function visitMinutes(p: Row, visitType: string): number {
  return visitType === 'home_visit' ? p.consult?.homeVisit?.minutes || 60 : p.consult?.inClinic?.minutes || 45
}

const bufferAfter = (p: Row, visitType: string) => (availabilityOf(p).bufferMin ?? 0) + (visitType === 'home_visit' ? p.practice?.travelBufferMin ?? 0 : 0)

/** Busy times on the public booking page: no names, just what's taken. */
export async function publicCalendar(physioId: string, from: string, to: string) {
  const [busy, blocks, groups] = await Promise.all([
    q('select id, date, time, minutes, visit_type from bookings where physio_id = $1 and status = any($2) and date >= $3 and date < $4 order by date, time', [physioId, OCCUPYING, from, to]),
    q('select date, start_time, end_time from blocks where physio_id = $1 and date >= $2 and date < $3', [physioId, from, to]),
    q("select * from group_sessions where physio_id = $1 and status <> 'cancelled' and date >= $2 and date < $3 order by date, time", [physioId, from, to]),
  ])
  return { busy, blocks, groups }
}

/**
 * Throws 409 unless [time, time + visit length) sits inside the physio's hours and doesn't
 * overlap another appointment (plus buffer/travel), blocked time, or a group session.
 */
export async function assertSlotFree(p: Row, date: string, time: string, visitType: string, opts: { forPatient?: boolean } = {}) {
  const av = availabilityOf(p)
  const today = todayIST()
  if (opts.forPatient) {
    if (date < today || date > addDays(today, av.maxDaysAhead ?? 30)) throw new HttpError(400, `Pick a date in the next ${av.maxDaysAhead ?? 30} days`, 'bad_request')
    const now = new Date(Date.now() + 330 * 60_000) // IST wall clock
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes()
    if (date === today && toMin(time) < nowMin + (av.minNoticeHours ?? 0) * 60) throw new HttpError(409, 'That time is too soon. Pick a later slot.', 'slot_taken')
  }
  const start = toMin(time)
  const end = start + visitMinutes(p, visitType)
  const windows: Range[] = av.weekly[dayOf(date)] ?? []
  if (!windows.some((w) => start >= toMin(w.start) && end <= toMin(w.end))) throw new HttpError(409, 'The physio isn’t available at that time. Pick another slot.', 'slot_taken')

  const { busy, blocks, groups } = await publicCalendar(p.id, date, addDays(date, 1))
  const ranges: [number, number][] = [
    ...busy.map((b): [number, number] => [toMin(b.time), toMin(b.time) + (b.minutes ?? visitMinutes(p, b.visit_type)) + bufferAfter(p, b.visit_type)]),
    ...blocks.map((b): [number, number] => (b.start_time ? [toMin(b.start_time), toMin(b.end_time)] : [0, 24 * 60])),
    ...groups.map((g): [number, number] => [toMin(g.time), toMin(g.time) + g.minutes + (av.bufferMin ?? 0)]),
  ]
  // Same overlap rule as the app's openSlots(): existing items carry their buffer, the new visit doesn't.
  if (ranges.some(([s, e]) => start < e && s < end)) throw new HttpError(409, 'That slot was just taken. Pick another time.', 'slot_taken')
}
