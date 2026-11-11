import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { assertSlotFree, availabilityOf, publicCalendar } from '../calendar.js'
import { one, tx } from '../db.js'
import * as M from '../mappers.js'
import { hhmm, isoDate, visitType } from '../schemas.js'
import { addDays, badRequest, HttpError, newId, normalizePhone, notFound, todayIST } from '../util.js'
import { joinGroup } from './practice.js'

export async function publicRoutes(app: FastifyInstance) {
  // P1 · public physio profile + busy slots (no patient details).
  app.get('/public/physios/:slug', async (req) => {
    const { slug } = z.object({ slug: z.string().max(60) }).parse(req.params)
    const r = await one('select * from physios where slug = $1', [slug])
    if (!r) throw notFound('Profile not found')
    const today = todayIST()
    const { busy, blocks, groups } = await publicCalendar(r.id, today, addDays(today, (availabilityOf(r).maxDaysAhead ?? 30) + 1))
    const counts = await one<{ patients: number }>('select count(*)::int as patients from patients where physio_id = $1', [r.id])
    return {
      physio: { ...M.physioPublic(r), phone: '', billing: undefined },
      busy: busy.map((b) => ({ date: b.date, time: b.time, minutes: b.minutes ?? undefined, visitType: b.visit_type })),
      // Reasons for blocked time stay private.
      blocks: blocks.map((b) => ({ date: b.date, start: b.start_time ?? undefined, end: b.end_time ?? undefined })),
      groups: groups.filter((g) => g.public_booking).map(M.groupPublic),
      stats: { patients: counts?.patients ?? 0 },
    }
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
        address: z.string().trim().max(300).optional(),
        location: z.string().trim().max(300).optional(),
        // Honeypot: real users never fill this hidden field.
        website: z.string().max(0).optional(),
      })
      .parse(req.body)
    const phone = normalizePhone(b.phone)
    if (!phone) throw badRequest('Enter a valid 10-digit mobile number')
    const ph = await one('select * from physios where slug = $1', [slug])
    if (!ph) throw notFound('Profile not found')
    const today = todayIST()
    if (b.visitType === 'home_visit' && !ph.consult?.homeVisit?.enabled) throw badRequest('This physio doesn’t offer home visits')
    if (b.visitType === 'home_visit' && !b.address) throw badRequest('Add the address for the home visit')
    const dup = await one("select count(*)::int as n from bookings where physio_id = $1 and patient_phone = $2 and status = 'requested' and date >= $3", [ph.id, phone, today])
    if ((dup?.n ?? 0) >= 2) throw new HttpError(429, 'You already have a request waiting. The physio will reply on WhatsApp.', 'too_many_requests')
    await assertSlotFree(ph, b.date, b.time, b.visitType, { forPatient: true })
    const existing = await one('select id from patients where physio_id = $1 and phone = $2', [ph.id, phone])
    const row = await one(
      `insert into bookings (id, physio_id, patient_id, patient_name, patient_phone, date, time, visit_type, reason, address, is_new_patient, status, send_confirmation, reminder, source, location)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'requested',true,true,'public_profile',$12) returning id, date, time, status`,
      [newId('bk'), ph.id, existing?.id ?? null, b.name, phone, b.date, b.time, b.visitType, b.reason ?? null, b.visitType === 'home_visit' ? b.address ?? null : null, !existing, b.visitType === 'home_visit' ? null : b.location ?? null],
    )
    return { id: row!.id, date: row!.date, time: row!.time, status: row!.status }
  })

  // P3 · take a seat in a public group class.
  app.post('/public/physios/:slug/groups/:id/join', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
    const { slug, id: gid } = z.object({ slug: z.string().max(60), id: z.string().max(40) }).parse(req.params)
    const b = z.object({ name: z.string().trim().min(2).max(80), phone: z.string(), website: z.string().max(0).optional() }).parse(req.body)
    const phone = normalizePhone(b.phone)
    if (!phone) throw badRequest('Enter a valid 10-digit mobile number')
    const ph = await one('select id from physios where slug = $1', [slug])
    if (!ph) throw notFound('Profile not found')
    const existing = await one('select id from patients where physio_id = $1 and phone = $2', [ph.id, phone])
    const row = await tx((c) => joinGroup(c, gid, ph.id, { patientId: existing?.id, name: b.name, phone }, { publicOnly: true }))
    return M.groupPublic(row)
  })
}
