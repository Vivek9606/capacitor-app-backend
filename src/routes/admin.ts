import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../auth.js'
import { one, q } from '../db.js'
import { queueSiteRebuild, siteUrl } from '../directory.js'
import * as M from '../mappers.js'
import { HttpError, notFound } from '../util.js'

/** Web-only admin dashboard: who signed up, their assessments, and which physio they go to. */
export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/overview', async (req) => {
    requireRole(req, 'admin')
    const [physios, patients, assessments, listings, counts] = await Promise.all([
      q('select ph.*, (select count(*)::int from patients p where p.physio_id = ph.id) as n_patients from physios ph order by ph.created_at desc'),
      q('select * from patients order by created_at desc limit 500'),
      q('select * from assessments order by created_at desc limit 500'),
      q('select physio_id, slug, status, published_at, updated_at from directory_profiles order by updated_at desc'),
      one<{ physios: number; patients: number; self: number; unassigned: number; assessments: number }>(
        `select (select count(*)::int from physios) as physios, (select count(*)::int from patients) as patients,
                (select count(*)::int from patients where self_signup) as self, (select count(*)::int from patients where physio_id is null) as unassigned,
                (select count(*)::int from assessments) as assessments`,
      ),
    ])
    return {
      counts,
      // Full profile (incl. council registration) so admins can check verification requests.
      physios: physios.map((r) => ({ ...M.physio(r), patients: r.n_patients })),
      patients: patients.map(M.patient),
      assessments: assessments.map(M.assessment),
      // betterhood.in directory listings (published by physios from the website or the app).
      listings: listings.map((l) => ({ physioId: l.physio_id, slug: l.slug, status: l.status, url: siteUrl(l.slug), publishedAt: new Date(l.published_at).toISOString(), updatedAt: new Date(l.updated_at).toISOString() })),
    }
  })

  // Pain chats (consumer app): who talked to the assistant, what it understood, and whether it led to a free consult.
  // The list leaves the transcripts out; GET /admin/pain-chats/:id has the full conversation.
  app.get('/admin/pain-chats', async (req) => {
    requireRole(req, 'admin')
    const rows = await q(
      `select c.id, c.status, c.engine, c.assessment, c.created_at, c.updated_at,
              (select count(*)::int from jsonb_array_elements(c.messages) m where m->>'role' = 'user') as user_messages,
              (c.messages -> 1 ->> 'text') as first_message,
              p.id as patient_id, p.name as patient_name, p.phone as patient_phone, p.city as patient_city,
              ph.name as physio_name, b.id as booking_id, b.date as booking_date, b.time as booking_time, b.status as booking_status
       from pain_chats c
       join patients p on p.id = c.patient_id
       left join physios ph on ph.id = c.physio_id
       left join bookings b on b.id = c.booking_id
       order by c.created_at desc limit 500`,
    )
    return {
      chats: rows.map((r) => ({
        id: r.id,
        status: r.status,
        engine: r.engine,
        area: r.assessment?.area ?? 'unknown',
        stage: r.assessment?.stage ?? 'unknown',
        severity: r.assessment?.severity ?? 0,
        redFlags: r.assessment?.red_flags ?? [],
        summary: r.assessment?.summary_for_physio || undefined,
        userMessages: r.user_messages,
        firstMessage: r.first_message ?? undefined,
        patient: { id: r.patient_id, name: r.patient_name, phone: r.patient_phone, city: r.patient_city ?? undefined },
        physioName: r.physio_name ?? undefined,
        booking: r.booking_id ? { id: r.booking_id, date: r.booking_date, time: String(r.booking_time).slice(0, 5), status: r.booking_status } : undefined,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
    }
  })

  app.get('/admin/pain-chats/:id', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params)
    const c = await one('select messages from pain_chats where id = $1', [id])
    if (!c) throw notFound('Chat not found')
    return { messages: c.messages as { role: 'user' | 'assistant'; text: string; at: string }[] }
  })

  // Take a directory listing off betterhood.in (or put it back). Listings go live without review; this is the brake.
  app.post('/admin/directory/:physioId/status', async (req) => {
    requireRole(req, 'admin')
    const { physioId } = z.object({ physioId: z.string().max(40) }).parse(req.params)
    const { status } = z.object({ status: z.enum(['live', 'hidden']) }).parse(req.body)
    const row = await one('update directory_profiles set status = $2, updated_at = now() where physio_id = $1 returning slug, status', [physioId, status])
    if (!row) throw notFound('Listing not found')
    queueSiteRebuild(`listing ${row.slug} ${status}`)
    return { slug: row.slug, status: row.status, url: siteUrl(row.slug) }
  })

  // Approve or reject a physio's verification request (the "Verified" badge on their profile and booking page).
  app.post('/admin/physios/:id/verification', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params)
    const { status } = z.object({ status: z.enum(['verified', 'none']) }).parse(req.body)
    const row = await one('update physios set verification = $2 where id = $1 returning *', [id, status])
    if (!row) throw notFound('Physio not found')
    return M.physio(row)
  })

  // Confirm (or change) the physio for a self-signed-up patient.
  app.post('/admin/patients/:id/assign', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params)
    const { physioId } = z.object({ physioId: z.string().max(40) }).parse(req.body)
    const p = await one('select * from patients where id = $1', [id])
    if (!p) throw notFound('Patient not found')
    if (!(await one('select 1 from physios where id = $1', [physioId]))) throw notFound('Physio not found')
    if (p.physio_id && p.physio_id !== physioId) throw new HttpError(409, 'This patient already has a physio.', 'assigned')
    if (await one('select 1 from patients where physio_id = $1 and phone = $2 and id <> $3', [physioId, p.phone, id]))
      throw new HttpError(409, 'That physio already has this patient (added by them). Ask the patient to log in again.', 'exists')
    const row = await one("update patients set physio_id = $2, match_status = 'confirmed', suggested_physio_id = $2 where id = $1 returning *", [id, physioId])
    return M.patient(row!)
  })
}
