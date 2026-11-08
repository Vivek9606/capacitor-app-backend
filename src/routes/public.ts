import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { one, q } from '../db.js'
import * as M from '../mappers.js'
import { hhmm, isoDate, visitType } from '../schemas.js'
import { addDays, badRequest, HttpError, newId, normalizePhone, notFound, todayIST } from '../util.js'

export async function publicRoutes(app: FastifyInstance) {
  // P1 · public physio profile + busy slots (no patient details).
  app.get('/public/physios/:slug', async (req) => {
    const { slug } = z.object({ slug: z.string().max(60) }).parse(req.params)
    const r = await one('select * from physios where slug = $1', [slug])
    if (!r) throw notFound('Profile not found')
    const today = todayIST()
    const busy = await q("select date, time from bookings where physio_id = $1 and status <> 'cancelled' and date >= $2 and date < $3 order by date, time", [r.id, today, addDays(today, 21)])
    const counts = await one<{ patients: number }>('select count(*)::int as patients from patients where physio_id = $1', [r.id])
    return { physio: { ...M.physioPublic(r), phone: '' }, busy: busy.map((b) => ({ date: b.date, time: b.time })), stats: { patients: counts?.patients ?? 0 } }
  })

  // P2 · booking request from the public profile. The physio accepts in the app.
  app.post('/public/physios/:slug/booking-requests', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
    const { slug } = z.object({ slug: z.string().max(60) }).parse(req.params)
    const b = z
      .object({
        name: z.string().trim().min(2).max(80),
        phone: z.string(),
        date: isoDate,
        time: hhmm,
        visitType,
        reason: z.string().max(200).optional(),
        // Honeypot: real users never fill this hidden field.
        website: z.string().max(0).optional(),
      })
      .parse(req.body)
    const phone = normalizePhone(b.phone)
    if (!phone) throw badRequest('Enter a valid 10-digit mobile number')
    const ph = await one('select id from physios where slug = $1', [slug])
    if (!ph) throw notFound('Profile not found')
    const today = todayIST()
    if (b.date < today || b.date > addDays(today, 30)) throw badRequest('Pick a date in the next 30 days')
    const dup = await one("select count(*)::int as n from bookings where physio_id = $1 and patient_phone = $2 and status = 'requested' and date >= $3", [ph.id, phone, today])
    if ((dup?.n ?? 0) >= 2) throw new HttpError(429, 'You already have a request waiting. The physio will reply on WhatsApp.', 'too_many_requests')
    const clash = await one("select 1 from bookings where physio_id = $1 and date = $2 and time = $3 and status <> 'cancelled'", [ph.id, b.date, b.time])
    if (clash) throw new HttpError(409, 'That slot was just taken. Pick another time.', 'slot_taken')
    const existing = await one('select id from patients where physio_id = $1 and phone = $2', [ph.id, phone])
    const row = await one(
      `insert into bookings (id, physio_id, patient_id, patient_name, patient_phone, date, time, visit_type, reason, is_new_patient, status, send_confirmation, reminder, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'requested',true,true,'public_profile') returning id, date, time, status`,
      [newId('bk'), ph.id, existing?.id ?? null, b.name, phone, b.date, b.time, b.visitType, b.reason ?? null, !existing],
    )
    return { id: row!.id, date: row!.date, time: row!.time, status: row!.status }
  })
}
