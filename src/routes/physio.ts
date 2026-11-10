import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../auth.js'
import { one, q, tx } from '../db.js'
import * as M from '../mappers.js'
import { sendBookingMessage, webUrl } from '../notify.js'
import { availability, billing, bookingStatus, hhmm, id, isoDate, planItem, practice, rx, visitType } from '../schemas.js'
import { badRequest, firstName, linkToken, newId, normalizePhone, notFound, todayIST } from '../util.js'
import { sendLater } from '../whatsapp.js'

const MAX_PHOTO = 400_000 // data URL chars (~300 KB image). Move to object storage later.

export async function ownPatient(physioId: string, patientId: string) {
  const p = await one('select * from patients where id = $1 and physio_id = $2', [patientId, physioId])
  if (!p) throw notFound('Patient not found')
  return p
}

export async function physioRoutes(app: FastifyInstance) {
  // ---------- profile ----------
  app.patch('/physio/me', async (req) => {
    const me = requireRole(req, 'physio')
    const b = z
      .object({
        name: z.string().trim().min(2).max(80),
        email: z.string().trim().email().max(120).nullable(),
        qualification: z.string().trim().max(80).nullable(),
        experienceYrs: z.number().int().min(0).max(60).nullable(),
        councilRegNo: z.string().trim().max(60).nullable(),
        photo: z.string().startsWith('data:image/').max(MAX_PHOTO).nullable(),
        focusAreas: z.array(z.string().max(40)).max(12),
        practiceSettings: z.array(z.string().max(40)).max(8),
        clinic: z.object({ name: z.string().max(120), address: z.string().max(300), area: z.string().max(80) }).nullable(),
        consult: z.object({
          inClinic: z.object({ enabled: z.boolean(), fee: z.number().int().min(0).max(100000), minutes: z.number().int().min(10).max(240) }),
          homeVisit: z.object({ enabled: z.boolean(), fee: z.number().int().min(0).max(100000), radiusKm: z.number().int().min(0).max(100), minutes: z.number().int().min(10).max(240).optional() }),
        }),
        workingDays: z.array(z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])),
        hours: z.object({ start: hhmm, end: hhmm }).nullable(),
        practice: practice.nullable(),
        availability: availability.nullable(),
        billing: billing.nullable(),
        courseProgress: z.array(z.string().regex(/^l\d{1,3}$/)).max(100),
        partnerOptIns: z.array(z.string().max(30)).max(10),
        communityWaitlist: z.boolean(),
        communityTopics: z.array(z.string().max(60)).max(20),
        verification: z.literal('pending'), // physio may only request verification; admins verify
      })
      .partial()
      .parse(req.body)

    const cols: Record<string, unknown> = {
      name: b.name,
      email: b.email,
      qualification: b.qualification,
      experience_yrs: b.experienceYrs,
      council_reg_no: b.councilRegNo,
      photo: b.photo,
      focus_areas: b.focusAreas,
      practice_settings: b.practiceSettings,
      clinic: b.clinic === undefined ? undefined : b.clinic && JSON.stringify(b.clinic),
      consult: b.consult && JSON.stringify(b.consult),
      working_days: b.workingDays,
      hours: b.hours === undefined ? undefined : b.hours && JSON.stringify(b.hours),
      practice: b.practice === undefined ? undefined : b.practice && JSON.stringify(b.practice),
      availability: b.availability === undefined ? undefined : b.availability && JSON.stringify(b.availability),
      billing: b.billing === undefined ? undefined : b.billing && JSON.stringify(b.billing),
      course_progress: b.courseProgress,
      partner_opt_ins: b.partnerOptIns,
      community_waitlist: b.communityWaitlist,
      community_topics: b.communityTopics,
    }
    if (b.verification === 'pending') {
      const cur = await one('select verification from physios where id = $1', [me])
      if (cur?.verification === 'none') cols.verification = 'pending'
    }
    const entries = Object.entries(cols).filter(([, v]) => v !== undefined)
    if (!entries.length) return M.physio((await one('select * from physios where id = $1', [me]))!)
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')
    const row = await one(`update physios set ${sets} where id = $1 returning *`, [me, ...entries.map(([, v]) => v)])
    return M.physio(row!)
  })

  // ---------- patients ----------
  app.post('/physio/patients', async (req) => {
    const me = requireRole(req, 'physio')
    const b = z
      .object({
        id: id.optional(),
        name: z.string().trim().min(2).max(80),
        phone: z.string(),
        age: z.number().int().min(0).max(120).optional(),
        sex: z.enum(['F', 'M', 'O']).optional(),
        condition: z.string().trim().max(200).optional(),
      })
      .parse(req.body)
    const phone = normalizePhone(b.phone)
    if (!phone) throw badRequest('Enter a valid 10-digit mobile number')
    const existing = await one('select * from patients where physio_id = $1 and phone = $2', [me, phone])
    if (existing) return M.patient(existing)
    // Someone who signed up on their own: this physio takes them on (keeps their assessments).
    const solo = await one("update patients set physio_id = $1, match_status = 'confirmed', suggested_physio_id = null where phone = $2 and physio_id is null returning *", [me, phone])
    if (solo) return M.patient(solo)
    const row = await one(
      `insert into patients (id, physio_id, phone, name, age, sex, condition, since, link_token)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [b.id ?? newId('pt'), me, phone, b.name, b.age ?? null, b.sex ?? null, b.condition ?? null, todayIST(), linkToken()],
    )
    return M.patient(row!)
  })

  app.patch('/physio/patients/:id', async (req) => {
    const me = requireRole(req, 'physio')
    const { id: pid } = z.object({ id }).parse(req.params)
    await ownPatient(me, pid)
    const b = z
      .object({ name: z.string().trim().min(2).max(80), age: z.number().int().min(0).max(120).nullable(), sex: z.enum(['F', 'M', 'O']).nullable(), condition: z.string().max(200).nullable(), tags: z.array(z.string().max(30)).max(10) })
      .partial()
      .parse(req.body)
    const row = await one(
      `update patients set name = coalesce($2, name), age = case when $3::boolean then $4 else age end,
              sex = case when $5::boolean then $6 else sex end, condition = case when $7::boolean then $8 else condition end,
              tags = coalesce($9, tags)
        where id = $1 returning *`,
      [pid, b.name ?? null, b.age !== undefined, b.age ?? null, b.sex !== undefined, b.sex ?? null, b.condition !== undefined, b.condition ?? null, b.tags ?? null],
    )
    return M.patient(row!)
  })

  // ---------- care plans (R4 send) ----------
  // Edit the active plan in place (same plan, same start date and logged sessions). The reason is logged.
  app.patch('/physio/plans/:id', async (req) => {
    const me = requireRole(req, 'physio')
    const { id: planId } = z.object({ id }).parse(req.params)
    const b = z
      .object({
        title: z.string().trim().max(80),
        items: z.array(planItem).min(1).max(30),
        daysPerWeek: z.number().int().min(1).max(7),
        weeks: z.number().int().min(1).max(52),
        rx: rx.optional(),
        reason: z.string().trim().min(3, 'Add a reason for the change').max(500),
        summary: z.array(z.string().max(200)).max(40).default([]),
      })
      .parse(req.body)
    const cur = await one('select * from plans where id = $1 and physio_id = $2', [planId, me])
    if (!cur) throw notFound('Plan not found')
    if (cur.status !== 'active') throw badRequest('Only the active plan can be edited')
    const known = new Set((await q('select id from exercises where id = any($1)', [b.items.map((i) => i.exerciseId)])).map((r) => r.id))
    const bad = b.items.find((i) => !known.has(i.exerciseId))
    if (bad) throw badRequest(`Unknown exercise: ${bad.exerciseId}`)
    const change = { at: new Date().toISOString(), reason: b.reason, summary: b.summary }
    const row = await one(
      `update plans set title = $2, items = $3, days_per_week = $4, weeks = $5, rx = coalesce($6, rx),
              changes = changes || $7::jsonb, updated_at = now()
        where id = $1 returning *`,
      [planId, b.title || cur.title, JSON.stringify(b.items), b.daysPerWeek, b.weeks, b.rx ? JSON.stringify(b.rx) : null, JSON.stringify([change])],
    )
    return M.plan(row!)
  })

  app.post('/physio/plans', async (req) => {
    const me = requireRole(req, 'physio')
    const b = z
      .object({
        id: id.optional(),
        patientId: id,
        title: z.string().trim().max(80),
        items: z.array(planItem).max(30),
        daysPerWeek: z.number().int().min(1).max(7),
        weeks: z.number().int().min(1).max(52),
        rx: rx.optional(),
        sendWhatsApp: z.boolean().default(true),
      })
      .parse(req.body)
    const patient = await ownPatient(me, b.patientId)
    const rxOnly = b.items.length === 0
    if (rxOnly && !b.rx) throw badRequest('Add exercises or a prescription')
    if (b.items.length) {
      const known = new Set((await q('select id from exercises where id = any($1)', [b.items.map((i) => i.exerciseId)])).map((r) => r.id))
      const bad = b.items.find((i) => !known.has(i.exerciseId))
      if (bad) throw badRequest(`Unknown exercise: ${bad.exerciseId}`)
    }

    const plan = await tx(async (c) => {
      if (!rxOnly) await c.query("update plans set status = 'replaced' where patient_id = $1 and status = 'active'", [patient.id])
      const r = await c.query(
        `insert into plans (id, patient_id, physio_id, title, items, days_per_week, weeks, start_date, status, rx)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
        [b.id ?? newId('pl'), patient.id, me, b.title || (rxOnly ? 'Prescription' : 'Care plan'), JSON.stringify(b.items), b.daysPerWeek, b.weeks, todayIST(), rxOnly ? 'completed' : 'active', b.rx ? JSON.stringify(b.rx) : null],
      )
      if (!patient.condition && b.rx?.diagnosis) await c.query('update patients set condition = $2 where id = $1', [patient.id, b.rx.diagnosis])
      // Referral activation: this physio's first plan activates whoever invited them.
      await c.query("update referrals set status = 'activated' where referred_id = $1 and status = 'joined'", [me])
      return r.rows[0]
    })

    if (b.sendWhatsApp) {
      const physio = await one('select name from physios where id = $1', [me])
      const url = webUrl(`/plan/${patient.link_token}`)
      if (rxOnly) sendLater({ name: 'rx_shared', to: patient.phone, patientName: firstName(patient.name), physioName: physio!.name, url })
      else
        sendLater({
          name: 'care_plan_shared',
          to: patient.phone,
          patientName: firstName(patient.name),
          physioName: physio!.name,
          summary: `${b.weeks}-week plan · ${b.items.length} exercises · ${b.daysPerWeek} days a week`,
          url,
        })
    }
    return M.plan(plan)
  })

  app.post('/physio/templates', async (req) => {
    const me = requireRole(req, 'physio')
    const b = z.object({ id: id.optional(), title: z.string().trim().min(1).max(80), items: z.array(planItem).min(1).max(30), daysPerWeek: z.number().int().min(1).max(7), weeks: z.number().int().min(1).max(52) }).parse(req.body)
    const row = await one('insert into plan_templates (id, physio_id, title, items, days_per_week, weeks) values ($1,$2,$3,$4,$5,$6) returning *', [b.id ?? newId('tp'), me, b.title, JSON.stringify(b.items), b.daysPerWeek, b.weeks])
    return M.template(row!)
  })

  // ---------- bookings ----------
  app.post('/physio/bookings', async (req) => {
    const me = requireRole(req, 'physio')
    const b = z
      .object({
        id: id.optional(),
        patientId: id.optional(),
        patientName: z.string().trim().min(2).max(80),
        patientPhone: z.string(),
        date: isoDate,
        time: hhmm,
        visitType,
        minutes: z.number().int().min(5).max(480).optional(),
        reason: z.string().max(200).optional(),
        address: z.string().trim().max(300).optional(),
        isNewPatient: z.boolean().default(false),
        status: z.enum(['awaiting', 'confirmed', 'checked_in']),
        sendConfirmation: z.boolean().default(true),
        reminder: z.boolean().default(true),
        source: z.enum(['physio', 'walk_in']).default('physio'),
      })
      .parse(req.body)
    const phone = normalizePhone(b.patientPhone)
    if (!phone) throw badRequest('Invalid mobile number')
    if (b.patientId) await ownPatient(me, b.patientId)
    // A walk-in is someone at the clinic right now: no confirmation or reminder to send.
    const walkIn = b.source === 'walk_in' || b.status === 'checked_in'
    const row = await one(
      `insert into bookings (id, physio_id, patient_id, patient_name, patient_phone, date, time, visit_type, minutes, reason, address, is_new_patient, status, send_confirmation, reminder, source, checked_in_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
      [b.id ?? newId('bk'), me, b.patientId ?? null, b.patientName, phone, b.date, b.time, b.visitType, b.minutes ?? null, b.reason ?? null, b.address ?? null, b.isNewPatient, b.status, walkIn ? false : b.sendConfirmation, walkIn ? false : b.reminder, b.source, b.status === 'checked_in' ? new Date() : null],
    )
    if (row!.send_confirmation) await sendBookingMessage(row!.id, 'booking_confirmation')
    return M.booking(row!)
  })

  app.patch('/physio/bookings/:id', async (req) => {
    const me = requireRole(req, 'physio')
    const { id: bid } = z.object({ id }).parse(req.params)
    const b = z
      .object({ status: bookingStatus, date: isoDate, time: hhmm, visitType, minutes: z.number().int().min(5).max(480), address: z.string().trim().max(300).nullable(), sendConfirmation: z.boolean(), reminder: z.boolean(), patientId: id })
      .partial()
      .parse(req.body)
    const cur = await one('select * from bookings where id = $1 and physio_id = $2', [bid, me])
    if (!cur) throw notFound('Booking not found')
    if (b.patientId) await ownPatient(me, b.patientId)
    const moved = (b.date && b.date !== cur.date) || (b.time && b.time !== cur.time)

    const row = await tx(async (c) => {
      const r = await c.query(
        `update bookings set status = coalesce($2, status), date = coalesce($3, date), time = coalesce($4, time),
                visit_type = coalesce($5, visit_type), send_confirmation = coalesce($6, send_confirmation),
                reminder = coalesce($7, reminder), patient_id = coalesce($8, patient_id),
                reminder_sent_at = case when $9::boolean then null else reminder_sent_at end,
                minutes = coalesce($10, minutes), address = case when $11::boolean then $12 else address end,
                checked_in_at = case when $2 = 'checked_in' then coalesce(checked_in_at, now()) else checked_in_at end
          where id = $1 returning *`,
        [bid, b.status ?? null, b.date ?? null, b.time ?? null, b.visitType ?? null, b.sendConfirmation ?? null, b.reminder ?? null, b.patientId ?? null, !!moved, b.minutes ?? null, b.address !== undefined, b.address ?? null],
      )
      if (b.status === 'done' && cur.status !== 'done' && cur.patient_id) await c.query('update patients set visits = visits + 1 where id = $1', [cur.patient_id])
      return r.rows[0]
    })

    const accepted = cur.status === 'requested' && b.status === 'confirmed'
    if ((moved && row.send_confirmation) || accepted) await sendBookingMessage(bid, 'booking_confirmation')
    if (b.status === 'reminder_sent' && cur.status !== 'reminder_sent') {
      await sendBookingMessage(bid, 'booking_reminder')
      await q('update bookings set reminder_sent_at = now() where id = $1', [bid])
    }
    return M.booking(row)
  })

  // ---------- messages ----------
  app.post('/physio/messages', async (req) => {
    const me = requireRole(req, 'physio')
    const b = z.object({ id: id.optional(), patientId: id, text: z.string().trim().min(1).max(2000) }).parse(req.body)
    const patient = await ownPatient(me, b.patientId)
    const row = await one("insert into messages (id, physio_id, patient_id, sender, text) values ($1,$2,$3,'physio',$4) returning *", [b.id ?? newId('m'), me, patient.id, b.text])
    const physio = await one('select name from physios where id = $1', [me])
    sendLater({ name: 'physio_reply', to: patient.phone, patientName: firstName(patient.name), physioName: physio!.name, text: b.text.slice(0, 900), url: webUrl(`/plan/${patient.link_token}`) })
    return M.message(row!)
  })

  app.post('/physio/messages/read', async (req) => {
    const me = requireRole(req, 'physio')
    const b = z.object({ patientId: id }).parse(req.body)
    await q("update messages set read = true where physio_id = $1 and patient_id = $2 and sender = 'patient' and not read", [me, b.patientId])
    return { ok: true }
  })

  // ---------- referrals ----------
  app.post('/physio/referrals', async (req) => {
    const me = requireRole(req, 'physio')
    const b = z.object({ id: id.optional(), name: z.string().trim().min(2).max(80) }).parse(req.body)
    const row = await one("insert into referrals (id, referrer_id, name, status) values ($1,$2,$3,'pending') returning *", [b.id ?? newId('rf'), me, b.name])
    return M.referral(row!)
  })

}
