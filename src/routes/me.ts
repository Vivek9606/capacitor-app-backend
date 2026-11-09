import type { FastifyInstance } from 'fastify'
import { sessionFrom } from '../auth.js'
import { one, q } from '../db.js'
import * as M from '../mappers.js'
import { HttpError } from '../util.js'

/**
 * Everything the signed-in user is allowed to see, in the web app's DB shape.
 * The app loads this once after login and keeps it in memory; actions then call the
 * specific endpoints and patch local state.
 */
export async function meRoutes(app: FastifyInstance) {
  app.get('/me/bootstrap', async (req) => {
    const s = sessionFrom(req)
    const exercises = (await q('select * from exercises where active order by region, name')).map(M.exercise)

    if (s.role === 'physio') {
      const me = await one('select * from physios where id = $1', [s.sub])
      if (!me) throw new HttpError(401, 'Account not found', 'unauthenticated')
      const [patients, plans, sessions, bookings, messages, referrals, templates, blocks, groups, invoices, consents] = await Promise.all([
        q('select * from patients where physio_id = $1 order by name', [s.sub]),
        q('select * from plans where physio_id = $1 order by sent_at', [s.sub]),
        q('select sl.* from session_logs sl join plans p on p.id = sl.plan_id where p.physio_id = $1 order by sl.date', [s.sub]),
        q("select * from bookings where physio_id = $1 and date > (now() - interval '120 days')::date order by date, time", [s.sub]),
        q('select * from messages where physio_id = $1 order by at', [s.sub]),
        q('select * from referrals where referrer_id = $1 order by at', [s.sub]),
        q('select * from plan_templates where physio_id = $1 order by created_at', [s.sub]),
        q("select * from blocks where physio_id = $1 and date >= (now() - interval '30 days')::date order by date", [s.sub]),
        q("select * from group_sessions where physio_id = $1 and date > (now() - interval '120 days')::date order by date, time", [s.sub]),
        q('select * from invoices where physio_id = $1 order by date, created_at', [s.sub]),
        q('select * from consents where physio_id = $1 order by requested_at', [s.sub]),
      ])
      return {
        session: { role: 'physio', userId: s.sub },
        db: {
          physios: [M.physio(me)],
          patients: patients.map(M.patient),
          exercises,
          plans: plans.map(M.plan),
          sessions: sessions.map(M.session),
          bookings: bookings.map(M.booking),
          messages: messages.map(M.message),
          referrals: referrals.map(M.referral),
          templates: templates.map(M.template),
          blocks: blocks.map(M.block),
          groups: groups.map(M.group),
          invoices: invoices.map(M.invoice),
          consents: consents.map(M.consent),
        },
      }
    }

    const me = await one('select * from patients where id = $1', [s.sub])
    if (!me) throw new HttpError(401, 'Account not found', 'unauthenticated')
    const physio = await one('select * from physios where id = $1', [me.physio_id])
    const [plans, sessions, bookings, messages, invoices, consents, groups, blocks] = await Promise.all([
      q('select * from plans where patient_id = $1 order by sent_at', [s.sub]),
      q('select sl.* from session_logs sl join plans p on p.id = sl.plan_id where p.patient_id = $1 order by sl.date', [s.sub]),
      q('select * from bookings where physio_id = $1 and (patient_id = $2 or patient_phone = $3) order by date, time', [me.physio_id, s.sub, me.phone]),
      q('select * from messages where patient_id = $1 order by at', [s.sub]),
      q("select * from invoices where patient_id = $1 and status <> 'void' order by date", [s.sub]),
      q('select * from consents where patient_id = $1 order by requested_at', [s.sub]),
      // Groups I'm in, plus upcoming public classes I could join.
      q(
        "select * from group_sessions where physio_id = $1 and (participants @> jsonb_build_array(jsonb_build_object('phone', $2::text)) or (public_booking and status = 'scheduled' and date >= (now() at time zone 'Asia/Kolkata')::date)) order by date, time",
        [me.physio_id, me.phone],
      ),
      q("select id, physio_id, date, start_time, end_time from blocks where physio_id = $1 and date >= (now() at time zone 'Asia/Kolkata')::date", [me.physio_id]),
    ])
    // Busy slots (no names) so the patient can request an open time.
    const busy = await q(
      "select id, date, time, minutes, visit_type from bookings where physio_id = $1 and status not in ('cancelled', 'no_show') and date >= (now() at time zone 'Asia/Kolkata')::date and date < (now() at time zone 'Asia/Kolkata')::date + 181",
      [me.physio_id],
    )
    const mine = new Set(bookings.map((b) => b.id))
    const others = busy
      .filter((b) => !mine.has(b.id))
      .map((b) => ({ id: `busy_${b.id}`, physioId: me.physio_id, patientName: '', patientPhone: '', date: b.date, time: b.time, minutes: b.minutes ?? undefined, visitType: b.visit_type, isNewPatient: false, status: 'confirmed', sendConfirmation: false, reminder: false, source: 'physio', createdAt: '', hidden: true }))
    return {
      session: { role: 'patient', userId: s.sub },
      db: {
        physios: physio ? [M.physioPublic(physio)] : [],
        patients: [M.patient(me)],
        exercises,
        plans: plans.map(M.plan),
        sessions: sessions.map(M.session),
        bookings: [...bookings.map(M.booking), ...others],
        messages: messages.map(M.message),
        referrals: [],
        templates: [],
        // Blocked time without the private reason.
        blocks: blocks.map((b) => ({ ...M.block(b), reason: undefined })),
        groups: groups.map((g) => M.groupForPatient(g, s.sub, me.phone)),
        invoices: invoices.map(M.invoice),
        consents: consents.map(M.consent),
      },
    }
  })
}
