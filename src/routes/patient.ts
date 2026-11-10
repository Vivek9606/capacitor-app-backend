import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../auth.js'
import { assertSlotFree } from '../calendar.js'
import { one, q, tx } from '../db.js'
import * as M from '../mappers.js'
import { hhmm, id, isoDate, signature, visitType } from '../schemas.js'
import { addDays, badRequest, HttpError, newId, notFound, todayIST } from '../util.js'
import { joinGroup } from './practice.js'
import { suggestPhysio } from '../match.js'

async function me(patientId: string) {
  const p = await one('select * from patients where id = $1', [patientId])
  if (!p) throw new HttpError(401, 'Account not found', 'unauthenticated')
  return p
}

/** Bookings, messages and classes need a physio; someone who signed up alone waits for one. */
async function withPhysio(patientId: string) {
  const p = await me(patientId)
  if (!p.physio_id) throw new HttpError(409, 'You’ll be able to do this once your physio is assigned.', 'no_physio')
  return p
}

export async function patientRoutes(app: FastifyInstance) {
  // Save a pain-assessment result. For someone without a physio, suggest one for the admin to confirm.
  app.post('/patient/assessments', async (req) => {
    const pid = requireRole(req, 'patient')
    const b = z
      .object({
        id: id.optional(),
        slug: z.string().max(80),
        area: z.enum(['back', 'neck', 'shoulder', 'knee']),
        title: z.string().max(120),
        cat: z.enum(['muscle', 'nerve', 'bone', 'joint']).optional(),
        condition: z.string().max(200).optional(),
        result: z.string().max(120).optional(),
        advisory: z.string().max(2000).optional(),
        totals: z.record(z.string(), z.number()).optional(),
      })
      .parse(req.body)
    const p = await me(pid)
    const row = await one(
      'insert into assessments (id, patient_id, slug, area, title, cat, condition, result, advisory, totals) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',
      [b.id ?? newId('as'), pid, b.slug, b.area, b.title, b.cat ?? null, b.condition ?? null, b.result ?? null, b.advisory ?? null, JSON.stringify(b.totals ?? {})],
    )
    let patient = p
    if (!p.physio_id && p.match_status !== 'confirmed') {
      const sug = await suggestPhysio(b.cat, p.city ?? undefined)
      patient = (await one("update patients set suggested_physio_id = $2, match_status = $3, condition = coalesce(condition, $4) where id = $1 returning *", [pid, sug ?? null, sug ? 'suggested' : 'pending', b.condition ?? null]))!
    }
    return { assessment: M.assessment(row!), patient: M.patient(patient) }
  })

  app.patch('/patient/profile', async (req) => {
    const pid = requireRole(req, 'patient')
    const b = z.object({ name: z.string().trim().min(2).max(80).optional(), age: z.number().int().min(1).max(120).optional(), sex: z.enum(['F', 'M', 'O']).optional(), city: z.string().trim().max(80).optional() }).parse(req.body)
    const row = await one('update patients set name = coalesce($2, name), age = coalesce($3, age), sex = coalesce($4, sex), city = coalesce($5, city) where id = $1 returning *', [pid, b.name ?? null, b.age ?? null, b.sex ?? null, b.city ?? null])
    return M.patient(row!)
  })

  app.post('/patient/consent', async (req) => {
    const pid = requireRole(req, 'patient')
    const row = await one('update patients set consent_at = coalesce(consent_at, now()) where id = $1 returning *', [pid])
    return M.patient(row!)
  })

  app.post('/patient/plans/opened', async (req) => {
    const pid = requireRole(req, 'patient')
    await q('update plans set opened_at = now() where patient_id = $1 and opened_at is null', [pid])
    return { ok: true }
  })

  // Log (or re-log) a day's session. One row per plan per day.
  app.put('/patient/sessions', async (req) => {
    const pid = requireRole(req, 'patient')
    const b = z
      .object({
        id: id.optional(),
        planId: id,
        date: isoDate,
        status: z.enum(['done', 'skipped']),
        pain: z.number().int().min(0).max(10).optional(),
        note: z.string().max(500).optional(),
      })
      .parse(req.body)
    const plan = await one('select id, start_date from plans where id = $1 and patient_id = $2', [b.planId, pid])
    if (!plan) throw notFound('Plan not found')
    const today = todayIST()
    if (b.date > today || b.date < addDays(today, -7) || b.date < plan.start_date) throw badRequest('You can log today or the last 7 days')
    const row = await one(
      `insert into session_logs (id, plan_id, date, status, pain, note) values ($1,$2,$3,$4,$5,$6)
       on conflict (plan_id, date) do update set status = excluded.status, pain = excluded.pain, note = excluded.note
       returning *`,
      [b.id ?? newId('s'), b.planId, b.date, b.status, b.pain ?? null, b.note ?? null],
    )
    return M.session(row!)
  })

  // Patient asks for a slot; the physio accepts in the app.
  app.post('/patient/bookings', async (req) => {
    const pid = requireRole(req, 'patient')
    const p = await withPhysio(pid)
    const b = z.object({ id: id.optional(), date: isoDate, time: hhmm, visitType, reason: z.string().max(200).optional(), address: z.string().trim().max(300).optional() }).parse(req.body)
    if (b.date < todayIST()) throw badRequest('Pick a future date')
    if (b.visitType === 'home_visit' && !b.address) throw badRequest('Add the address for the home visit')
    const open = await one("select count(*)::int as n from bookings where patient_id = $1 and status = 'requested' and date >= $2", [pid, todayIST()])
    if ((open?.n ?? 0) >= 3) throw new HttpError(429, 'You already have requests waiting for your physio', 'too_many_requests')
    const physio = await one('select * from physios where id = $1', [p.physio_id])
    await assertSlotFree(physio!, b.date, b.time, b.visitType, { forPatient: true })
    const row = await one(
      `insert into bookings (id, physio_id, patient_id, patient_name, patient_phone, date, time, visit_type, reason, address, is_new_patient, status, send_confirmation, reminder, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,'requested',true,true,'physio') returning *`,
      [b.id ?? newId('bk'), p.physio_id, pid, p.name, p.phone, b.date, b.time, b.visitType, b.reason ?? null, b.visitType === 'home_visit' ? b.address ?? null : null],
    )
    return M.booking(row!)
  })

  // Confirm, or ask to reschedule, one of my appointments.
  app.patch('/patient/bookings/:id', async (req) => {
    const pid = requireRole(req, 'patient')
    const p = await withPhysio(pid)
    const { id: bid } = z.object({ id }).parse(req.params)
    const b = z.object({ status: z.enum(['confirmed', 'reschedule']) }).parse(req.body)
    const cur = await one('select * from bookings where id = $1 and physio_id = $2 and (patient_id = $3 or patient_phone = $4)', [bid, p.physio_id, pid, p.phone])
    if (!cur) throw notFound('Appointment not found')
    if (!['awaiting', 'confirmed', 'reminder_sent', 'reschedule'].includes(cur.status)) throw badRequest('This appointment can’t be changed')
    const row = await one('update bookings set status = $2, patient_id = coalesce(patient_id, $3) where id = $1 returning *', [bid, b.status, pid])
    return M.booking(row!)
  })

  app.post('/patient/messages', async (req) => {
    const pid = requireRole(req, 'patient')
    const p = await withPhysio(pid)
    const b = z.object({ id: id.optional(), text: z.string().trim().min(1).max(2000) }).parse(req.body)
    const recent = await one("select count(*)::int as n from messages where patient_id = $1 and sender = 'patient' and at > now() - interval '1 hour'", [pid])
    if ((recent?.n ?? 0) >= 20) throw new HttpError(429, 'Too many messages. Try again later.', 'rate_limited')
    const row = await one("insert into messages (id, physio_id, patient_id, sender, text) values ($1,$2,$3,'patient',$4) returning *", [b.id ?? newId('m'), p.physio_id, pid, b.text])
    return M.message(row!)
  })

  app.post('/patient/messages/read', async (req) => {
    const pid = requireRole(req, 'patient')
    await q("update messages set read = true where patient_id = $1 and sender = 'physio' and not read", [pid])
    return { ok: true }
  })

  // ---------- treatment consent forms ----------
  app.post('/patient/consents/:id/sign', async (req) => {
    const pid = requireRole(req, 'patient')
    const { id: cid } = z.object({ id }).parse(req.params)
    const s = signature.parse(req.body)
    const row = await one(
      `update consents set status = 'signed', signed_name = $3, signature = $4, guardian = $5, signed_at = now()
        where id = $1 and patient_id = $2 and status = 'pending' returning *`,
      [cid, pid, s.signedName, s.signature ?? null, s.guardian || null],
    )
    if (!row) throw notFound('No pending consent to sign')
    return M.consent(row)
  })

  // Decline a pending request, or withdraw a signed consent.
  app.patch('/patient/consents/:id', async (req) => {
    const pid = requireRole(req, 'patient')
    const { id: cid } = z.object({ id }).parse(req.params)
    const { status } = z.object({ status: z.enum(['declined', 'revoked']) }).parse(req.body)
    const from = status === 'declined' ? 'pending' : 'signed'
    const row = await one('update consents set status = $3 where id = $1 and patient_id = $2 and status = $4 returning *', [cid, pid, status, from])
    if (!row) throw notFound('Consent not found')
    return M.consent(row)
  })

  // ---------- group classes ----------
  app.post('/patient/groups/:id/join', async (req) => {
    const pid = requireRole(req, 'patient')
    const p = await withPhysio(pid)
    const { id: gid } = z.object({ id }).parse(req.params)
    const b = z.object({ id: id.optional() }).parse(req.body ?? {})
    const row = await tx((c) => joinGroup(c, gid, p.physio_id, { id: b.id, patientId: pid, name: p.name, phone: p.phone }, { publicOnly: true }))
    return M.groupForPatient(row, pid, p.phone)
  })
}
