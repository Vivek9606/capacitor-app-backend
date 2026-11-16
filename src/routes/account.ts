import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sessionFrom, signSession, type Role } from '../auth.js'
import { one, q } from '../db.js'
import { siteUrl } from '../directory.js'
import { physioByRef } from '../match.js'
import * as M from '../mappers.js'
import { HttpError } from '../util.js'

// One account, two front doors. The website (betterhood.in) and the app (web build / native shell) live on
// different origins, so they can't share a cookie. A signed-in side asks for a short-lived, single-use handoff
// code and opens the other side with it in the URL fragment (#handoff=…, never sent to a server); the other
// side swaps the code for its own session. Codes live in memory: 2 minutes, one use, so a restart only means
// someone taps the link again.
const HANDOFF_TTL_MS = 2 * 60 * 1000
const codes = new Map<string, { sub: string; role: Role; exp: number }>()

function sweep() {
  const now = Date.now()
  for (const [k, v] of codes) if (v.exp < now) codes.delete(k)
}

const mask = (phone: string) => `${phone.slice(0, 2)}xxxxxx${phone.slice(-2)}`

export async function accountRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }

  // Signed-in user → a one-time code for the other front door.
  app.post('/auth/handoff', strict, async (req) => {
    const s = sessionFrom(req)
    if (s.role === 'admin') throw new HttpError(403, 'Not allowed for this account', 'forbidden')
    sweep()
    const code = randomBytes(24).toString('base64url')
    codes.set(code, { sub: s.sub, role: s.role, exp: Date.now() + HANDOFF_TTL_MS })
    return { code, expiresInSec: HANDOFF_TTL_MS / 1000 }
  })

  // The other side swaps the code for its own session.
  app.post('/auth/handoff/redeem', strict, async (req) => {
    const { code } = z.object({ code: z.string().min(20).max(64) }).parse(req.body)
    sweep()
    const c = codes.get(code)
    codes.delete(code)
    if (!c) throw new HttpError(400, 'This sign-in link has expired. Please sign in again.', 'handoff_expired')
    const exists = await one(`select 1 from ${c.role === 'physio' ? 'physios' : 'patients'} where id = $1`, [c.sub])
    if (!exists) throw new HttpError(401, 'Account not found', 'unauthenticated')
    return { token: signSession({ sub: c.sub, role: c.role }), role: c.role, userId: c.sub }
  })

  // Who sent this invite link: shown on the website's assessment pages ("Dr. Rao asked you to take this").
  app.get('/public/physio-invite/:ref', async (req) => {
    const { ref } = z.object({ ref: z.string().max(80) }).parse(req.params)
    const ph = await physioByRef(ref)
    if (!ph) throw new HttpError(404, 'Invite link not found', 'not_found')
    return { name: ph.name, slug: ph.dir_slug }
  })

  // A light "who am I" for the website: name, which profiles this number has, and what to show next.
  app.get('/me/summary', async (req) => {
    const s = sessionFrom(req)
    if (s.role === 'admin') throw new HttpError(403, 'Not allowed for this account', 'forbidden')
    if (s.role === 'physio') {
      const me = await one('select * from physios where id = $1', [s.sub])
      if (!me) throw new HttpError(401, 'Account not found', 'unauthenticated')
      const [listing, counts, patientSide] = await Promise.all([
        one<{ slug: string; status: string }>('select slug, status from directory_profiles where physio_id = $1', [s.sub]),
        one<{ patients: number; upcoming: number }>(
          "select (select count(*)::int from patients where physio_id = $1) as patients, (select count(*)::int from bookings where physio_id = $1 and status not in ('cancelled','no_show') and date >= (now() at time zone 'Asia/Kolkata')::date) as upcoming",
          [s.sub],
        ),
        one('select 1 from patients where phone = $1 limit 1', [me.phone]),
      ])
      const invited = await one<{ n: number }>('select count(*)::int as n from patients where invited_by = $1', [s.sub])
      return {
        role: 'physio',
        userId: s.sub,
        name: me.name,
        phone: mask(me.phone),
        hasPatientProfile: !!patientSide,
        listing: listing ? { slug: listing.slug, status: listing.status, url: siteUrl(listing.slug) } : null,
        patients: counts?.patients ?? 0,
        upcomingBookings: counts?.upcoming ?? 0,
        // ?physio=<inviteRef> on any assessment link links the patient to this physio (see /patient/assessments)
        inviteRef: listing?.status === 'live' ? listing.slug : (me.slug ?? s.sub),
        invitedPatients: invited?.n ?? 0,
      }
    }
    const me = await one('select * from patients where id = $1', [s.sub])
    if (!me) throw new HttpError(401, 'Account not found', 'unauthenticated')
    const [physio, assessments, physioSide, plan] = await Promise.all([
      one<{ name: string }>('select name from physios where id = $1', [me.physio_id ?? me.suggested_physio_id ?? '']),
      q('select * from assessments where patient_id = $1 order by created_at desc limit 5', [s.sub]),
      one('select 1 from physios where phone = $1', [me.phone]),
      one("select 1 from plans where patient_id = $1 and status = 'active' limit 1", [s.sub]),
    ])
    return {
      role: 'patient',
      userId: s.sub,
      name: me.name,
      phone: mask(me.phone),
      hasPhysioProfile: !!physioSide,
      physioName: me.physio_id ? (physio?.name ?? null) : null,
      suggestedPhysioName: !me.physio_id && me.suggested_physio_id ? (physio?.name ?? null) : null,
      matchStatus: me.match_status ?? null,
      activePlan: !!plan,
      assessments: assessments.map(M.assessment),
    }
  })
}
