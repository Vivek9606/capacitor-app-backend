import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../auth.js'
import { one, q } from '../db.js'
import * as M from '../mappers.js'
import { HttpError, notFound } from '../util.js'

/** Web-only admin dashboard: who signed up, their assessments, and which physio they go to. */
export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/overview', async (req) => {
    requireRole(req, 'admin')
    const [physios, patients, assessments, counts] = await Promise.all([
      q('select ph.*, (select count(*)::int from patients p where p.physio_id = ph.id) as n_patients from physios ph order by ph.created_at desc'),
      q('select * from patients order by created_at desc limit 500'),
      q('select * from assessments order by created_at desc limit 500'),
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
    }
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
