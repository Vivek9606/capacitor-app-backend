import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import { requireRole } from '../auth.js'
import { one, q, tx } from '../db.js'
import * as M from '../mappers.js'
import { webUrl } from '../notify.js'
import { hhmm, id, invoiceItem, invoiceTotal, isoDate, paymentMethod, signature } from '../schemas.js'
import { badRequest, firstName, HttpError, newId, normalizePhone, notFound, todayIST } from '../util.js'
import { sendLater } from '../whatsapp.js'
import { ownPatient } from './physio.js'

type Participant = { id: string; patientId?: string; name: string; phone: string; status: 'booked' | 'attended' | 'no_show' | 'cancelled'; joinedAt: string }

const activeSeats = (ps: Participant[]) => ps.filter((p) => p.status !== 'cancelled').length

/**
 * Add someone to a group session, row-locked so two people can't take the last seat.
 * Re-joining (same phone) revives a cancelled seat instead of adding a duplicate.
 */
export async function joinGroup(c: pg.PoolClient, groupId: string, physioId: string, who: { id?: string; patientId?: string; name: string; phone: string }, opts: { publicOnly?: boolean } = {}) {
  const g = (await c.query('select * from group_sessions where id = $1 and physio_id = $2 for update', [groupId, physioId])).rows[0]
  if (!g || (opts.publicOnly && !g.public_booking)) throw notFound('Group session not found')
  if (g.status !== 'scheduled' || g.date < todayIST()) throw badRequest('This session is no longer open')
  const ps: Participant[] = g.participants ?? []
  const existing = ps.find((p) => p.phone === who.phone)
  if (existing && existing.status !== 'cancelled') return g
  if (activeSeats(ps) >= g.capacity) throw new HttpError(409, 'This session is full', 'full')
  if (existing) {
    existing.status = 'booked'
    existing.patientId ??= who.patientId
  } else ps.push({ id: who.id ?? newId('gp'), patientId: who.patientId, name: who.name, phone: who.phone, status: 'booked', joinedAt: new Date().toISOString() })
  return (await c.query('update group_sessions set participants = $2 where id = $1 returning *', [groupId, JSON.stringify(ps)])).rows[0]
}

/** PREFIX-YYYY-0001, numbered per physio per year. Call inside a transaction. */
async function nextNumber(c: pg.PoolClient, physioId: string, date: string) {
  await c.query('select pg_advisory_xact_lock(hashtext($1))', [`invoice:${physioId}`])
  const ph = (await c.query('select billing from physios where id = $1', [physioId])).rows[0]
  const prefix = (ph?.billing?.invoicePrefix as string | undefined) || 'INV'
  const stem = `${prefix}-${date.slice(0, 4)}-`
  const last = (await c.query("select number from invoices where physio_id = $1 and number like $2 || '%' order by number desc limit 1", [physioId, stem])).rows[0]
  const n = last ? Number(String(last.number).slice(stem.length)) + 1 || 1 : 1
  return `${stem}${String(n).padStart(4, '0')}`
}

async function sendInvoice(inv: Record<string, any>) {
  const ph = await one('select name, slug from physios where id = $1', [inv.physio_id])
  const pt = inv.patient_id ? await one('select link_token from patients where id = $1', [inv.patient_id]) : undefined
  sendLater({
    name: 'invoice_shared',
    to: inv.patient_phone,
    patientName: firstName(inv.patient_name),
    physioName: ph!.name,
    number: inv.number,
    amount: `₹${Number(inv.total).toLocaleString('en-IN')}`,
    url: webUrl(pt ? `/plan/${pt.link_token}` : `/dr/${ph!.slug}`),
  })
}

export async function practiceRoutes(app: FastifyInstance) {
  // ---------- blocked time ----------
  app.post('/physio/blocks', async (req) => {
    const me = requireRole(req, 'physio')
    const b = z
      .object({
        blocks: z
          .array(
            z
              .object({ id: id.optional(), date: isoDate, start: hhmm.optional(), end: hhmm.optional(), reason: z.string().trim().max(120).optional() })
              .refine((x) => (x.start === undefined) === (x.end === undefined) && (!x.start || x.start < x.end!), 'Pick a start and end time'),
          )
          .min(1)
          .max(60),
      })
      .parse(req.body)
    const rows = await tx(async (c) => {
      const out = []
      for (const x of b.blocks)
        out.push(
          (
            await c.query('insert into blocks (id, physio_id, date, start_time, end_time, reason) values ($1,$2,$3,$4,$5,$6) on conflict (id) do nothing returning *', [
              x.id ?? newId('bl'),
              me,
              x.date,
              x.start ?? null,
              x.end ?? null,
              x.reason ?? null,
            ])
          ).rows[0],
        )
      return out.filter(Boolean)
    })
    return rows.map(M.block)
  })

  app.delete('/physio/blocks/:id', async (req) => {
    const me = requireRole(req, 'physio')
    const { id: bid } = z.object({ id }).parse(req.params)
    await q('delete from blocks where id = $1 and physio_id = $2', [bid, me])
    return { ok: true }
  })

  // ---------- group sessions ----------
  const groupFields = z.object({
    title: z.string().trim().min(2).max(80),
    description: z.string().trim().max(500).optional(),
    date: isoDate,
    time: hhmm,
    minutes: z.number().int().min(10).max(480),
    capacity: z.number().int().min(1).max(200),
    fee: z.number().int().min(0).max(100000),
    location: z.string().trim().min(1).max(200),
    publicBooking: z.boolean(),
  })

  app.post('/physio/groups', async (req) => {
    const me = requireRole(req, 'physio')
    const b = z.object({ sessions: z.array(groupFields.extend({ id: id.optional(), seriesId: id.optional() })).min(1).max(26) }).parse(req.body)
    const rows = await tx(async (c) => {
      const out = []
      for (const g of b.sessions)
        out.push(
          (
            await c.query(
              `insert into group_sessions (id, physio_id, series_id, title, description, date, time, minutes, capacity, fee, location, public_booking)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
              [g.id ?? newId('gr'), me, g.seriesId ?? null, g.title, g.description ?? null, g.date, g.time, g.minutes, g.capacity, g.fee, g.location, g.publicBooking],
            )
          ).rows[0],
        )
      return out
    })
    return rows.map(M.group)
  })

  app.patch('/physio/groups/:id', async (req) => {
    const me = requireRole(req, 'physio')
    const { id: gid } = z.object({ id }).parse(req.params)
    const b = groupFields.extend({ description: z.string().trim().max(500).nullable(), status: z.enum(['scheduled', 'cancelled', 'done']) }).partial().parse(req.body)
    const cols: Record<string, unknown> = {
      title: b.title,
      description: b.description,
      date: b.date,
      time: b.time,
      minutes: b.minutes,
      capacity: b.capacity,
      fee: b.fee,
      location: b.location,
      public_booking: b.publicBooking,
      status: b.status,
    }
    const entries = Object.entries(cols).filter(([, v]) => v !== undefined)
    const cur = await one('select * from group_sessions where id = $1 and physio_id = $2', [gid, me])
    if (!cur) throw notFound('Group session not found')
    if (b.capacity !== undefined && b.capacity < activeSeats(cur.participants ?? [])) throw badRequest('More people have booked than that capacity')
    if (!entries.length) return M.group(cur)
    const sets = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ')
    const row = await one(`update group_sessions set ${sets} where id = $1 returning *`, [gid, ...entries.map(([, v]) => v)])
    return M.group(row!)
  })

  app.post('/physio/groups/:id/participants', async (req) => {
    const me = requireRole(req, 'physio')
    const { id: gid } = z.object({ id }).parse(req.params)
    const b = z.object({ id: id.optional(), patientId: id.optional(), name: z.string().trim().min(2).max(80), phone: z.string() }).parse(req.body)
    const phone = normalizePhone(b.phone)
    if (!phone) throw badRequest('Enter a valid 10-digit mobile number')
    if (b.patientId) await ownPatient(me, b.patientId)
    const row = await tx((c) => joinGroup(c, gid, me, { ...b, phone }))
    return M.group(row)
  })

  app.patch('/physio/groups/:gid/participants/:pid', async (req) => {
    const me = requireRole(req, 'physio')
    const { gid, pid } = z.object({ gid: id, pid: id }).parse(req.params)
    const { status } = z.object({ status: z.enum(['booked', 'attended', 'no_show', 'cancelled']) }).parse(req.body)
    const row = await tx(async (c) => {
      const g = (await c.query('select * from group_sessions where id = $1 and physio_id = $2 for update', [gid, me])).rows[0]
      if (!g) throw notFound('Group session not found')
      const ps: Participant[] = g.participants ?? []
      const p = ps.find((x) => x.id === pid)
      if (!p) throw notFound('Participant not found')
      if (p.status === 'cancelled' && status !== 'cancelled' && activeSeats(ps) >= g.capacity) throw new HttpError(409, 'This session is full', 'full')
      if (status === 'attended' && p.status !== 'attended' && p.patientId) await c.query('update patients set visits = visits + 1 where id = $1 and physio_id = $2', [p.patientId, me])
      if (p.status === 'attended' && status !== 'attended' && p.patientId) await c.query('update patients set visits = greatest(0, visits - 1) where id = $1 and physio_id = $2', [p.patientId, me])
      p.status = status
      return (await c.query('update group_sessions set participants = $2 where id = $1 returning *', [gid, JSON.stringify(ps)])).rows[0]
    })
    return M.group(row)
  })

  // ---------- invoices ----------
  app.post('/physio/invoices', async (req) => {
    const me = requireRole(req, 'physio')
    const b = z
      .object({
        id: id.optional(),
        patientId: id.optional(),
        patientName: z.string().trim().min(2).max(80),
        patientPhone: z.string(),
        date: isoDate,
        items: z.array(invoiceItem).min(1).max(30),
        discount: z.number().int().min(0).max(10_000_000).default(0),
        taxPct: z.number().min(0).max(28).default(0),
        notes: z.string().trim().max(500).optional(),
        bookingId: id.optional(),
        groupSessionId: id.optional(),
        status: z.enum(['unpaid', 'paid']).default('unpaid'),
        method: paymentMethod.optional(),
        send: z.boolean().default(false),
      })
      .parse(req.body)
    const phone = normalizePhone(b.patientPhone)
    if (!phone) throw badRequest('Invalid mobile number')
    if (b.patientId) await ownPatient(me, b.patientId)
    if (b.bookingId && !(await one('select 1 from bookings where id = $1 and physio_id = $2', [b.bookingId, me]))) throw notFound('Booking not found')
    if (b.groupSessionId && !(await one('select 1 from group_sessions where id = $1 and physio_id = $2', [b.groupSessionId, me]))) throw notFound('Group session not found')
    const total = invoiceTotal(b.items, b.discount, b.taxPct)
    const row = await tx(async (c) => {
      const number = await nextNumber(c, me, b.date)
      return (
        await c.query(
          `insert into invoices (id, physio_id, patient_id, patient_name, patient_phone, number, date, items, discount, tax_pct, total, status, method, paid_at, notes, booking_id, group_session_id, sent_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning *`,
          [
            b.id ?? newId('iv'),
            me,
            b.patientId ?? null,
            b.patientName,
            phone,
            number,
            b.date,
            JSON.stringify(b.items),
            b.discount,
            b.taxPct,
            total,
            b.status,
            b.status === 'paid' ? b.method ?? null : null,
            b.status === 'paid' ? new Date() : null,
            b.notes ?? null,
            b.bookingId ?? null,
            b.groupSessionId ?? null,
            b.send ? new Date() : null,
          ],
        )
      ).rows[0]
    })
    if (b.send) await sendInvoice(row)
    return M.invoice(row)
  })

  // `sent: true` records that the physio shared it from their own WhatsApp; `resend: true` sends it from Betterhood's number.
  app.patch('/physio/invoices/:id', async (req) => {
    const me = requireRole(req, 'physio')
    const { id: iid } = z.object({ id }).parse(req.params)
    const b = z.object({ status: z.enum(['unpaid', 'paid', 'void']), method: paymentMethod, sent: z.boolean(), resend: z.boolean() }).partial().parse(req.body)
    const cur = await one('select * from invoices where id = $1 and physio_id = $2', [iid, me])
    if (!cur) throw notFound('Invoice not found')
    const row = await one(
      `update invoices set status = coalesce($2, status),
              method = case when $2 = 'unpaid' then null else coalesce($3, method) end,
              paid_at = case when $2 = 'paid' then coalesce(paid_at, now()) when $2 is not null then null else paid_at end,
              sent_at = case when $4::boolean then now() else sent_at end
        where id = $1 returning *`,
      [iid, b.status ?? null, b.method ?? null, !!(b.sent || b.resend)],
    )
    if (b.resend && row!.status !== 'void') await sendInvoice(row!)
    return M.invoice(row!)
  })

  // ---------- treatment consent forms ----------
  app.post('/physio/consents', async (req) => {
    const me = requireRole(req, 'physio')
    const b = z
      .object({
        id: id.optional(),
        patientId: id,
        formId: z.string().regex(/^[a-z_]{2,40}$/),
        title: z.string().trim().min(2).max(120),
        body: z.string().trim().min(20).max(8000),
        signedName: z.string().trim().min(2).max(80).optional(),
        signature: signature.shape.signature,
        guardian: z.string().trim().max(80).optional(),
        notify: z.boolean().default(true),
      })
      .parse(req.body)
    const patient = await ownPatient(me, b.patientId)
    const signed = !!b.signedName
    const row = await one(
      `insert into consents (id, physio_id, patient_id, form_id, title, body, status, method, signed_name, signature, guardian, signed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [b.id ?? newId('cs'), me, patient.id, b.formId, b.title, b.body, signed ? 'signed' : 'pending', signed ? 'in_clinic' : 'remote', b.signedName ?? null, b.signature ?? null, b.guardian ?? null, signed ? new Date() : null],
    )
    if (!signed && b.notify) {
      const ph = await one('select name from physios where id = $1', [me])
      sendLater({ name: 'consent_request', to: patient.phone, patientName: firstName(patient.name), physioName: ph!.name, formTitle: b.title, url: webUrl(`/plan/${patient.link_token}`) })
    }
    return M.consent(row!)
  })

  // Patient is in the clinic: sign a pending request on the physio's device.
  app.post('/physio/consents/:id/sign', async (req) => {
    const me = requireRole(req, 'physio')
    const { id: cid } = z.object({ id }).parse(req.params)
    const s = signature.parse(req.body)
    const row = await one(
      `update consents set status = 'signed', method = 'in_clinic', signed_name = $3, signature = $4, guardian = $5, signed_at = now()
        where id = $1 and physio_id = $2 and status = 'pending' returning *`,
      [cid, me, s.signedName, s.signature ?? null, s.guardian || null],
    )
    if (!row) throw notFound('No pending consent to sign')
    return M.consent(row)
  })

  app.patch('/physio/consents/:id', async (req) => {
    const me = requireRole(req, 'physio')
    const { id: cid } = z.object({ id }).parse(req.params)
    const { status } = z.object({ status: z.enum(['declined', 'revoked']) }).parse(req.body)
    const row = await one('update consents set status = $3 where id = $1 and physio_id = $2 returning *', [cid, me, status])
    if (!row) throw notFound('Consent not found')
    return M.consent(row)
  })
}
