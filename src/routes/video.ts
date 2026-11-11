import type { FastifyInstance } from 'fastify'
import { AccessToken } from 'livekit-server-sdk'
import { z } from 'zod'
import { sessionFrom } from '../auth.js'
import { visitMinutes } from '../calendar.js'
import { one } from '../db.js'
import { env } from '../env.js'
import { badRequest, forbidden, HttpError, notFound } from '../util.js'

/** The call opens this many minutes before the appointment… */
const OPENS_BEFORE_MIN = 15
/** …and stays joinable this long after the booked end time (sessions overrun). */
const CLOSES_AFTER_MIN = 30

const CALLABLE = new Set(['awaiting', 'confirmed', 'reminder_sent', 'reschedule', 'checked_in'])

/** Booking date + time are Indian local time. */
function startsAt(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00+05:30`)
}

export const videoEnabled = () => Boolean(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET)

/**
 * 1:1 video for teleconsult bookings (LiveKit).
 * Each booking gets its own room. Only the booking's physio and patient can get a token for it,
 * and only around the appointment time.
 */
export async function videoRoutes(app: FastifyInstance) {
  app.post('/bookings/:id/call', async (req) => {
    const s = sessionFrom(req)
    if (s.role !== 'physio' && s.role !== 'patient') throw forbidden('Not allowed for this account')
    if (!videoEnabled()) throw new HttpError(503, 'Video calls aren’t set up yet.', 'video_disabled')
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params)

    const b = await one(
      `select b.*, ph.name as physio_name, ph.consult, pt.name as pt_name
         from bookings b
         join physios ph on ph.id = b.physio_id
         left join patients pt on pt.id = $2
        where b.id = $1`,
      [id, s.role === 'patient' ? s.sub : null],
    )
    if (!b) throw notFound('Appointment not found')

    // Same ownership rules as the rest of the API: physios see their own bookings;
    // patients see bookings with their physio that carry their id or phone.
    if (s.role === 'physio' && b.physio_id !== s.sub) throw notFound('Appointment not found')
    if (s.role === 'patient') {
      const p = await one('select id, name, phone, physio_id from patients where id = $1', [s.sub])
      if (!p || b.physio_id !== p.physio_id || (b.patient_id !== p.id && b.patient_phone !== p.phone)) throw notFound('Appointment not found')
    }

    if (b.visit_type !== 'teleconsult') throw badRequest('This appointment isn’t a video consult')
    if (!CALLABLE.has(b.status)) throw badRequest('This appointment is closed')

    const start = startsAt(b.date, b.time)
    const end = start + (b.minutes ?? visitMinutes(b, 'teleconsult')) * 60_000
    const opens = start - OPENS_BEFORE_MIN * 60_000
    const closes = end + CLOSES_AFTER_MIN * 60_000
    const now = Date.now()
    if (now < opens) throw new HttpError(409, `The call opens ${OPENS_BEFORE_MIN} minutes before your appointment.`, 'too_early')
    if (now > closes) throw new HttpError(409, 'This appointment has ended.', 'ended')

    const room = `bk_${b.id}`
    const name = s.role === 'physio' ? b.physio_name : b.pt_name ?? b.patient_name
    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity: `${s.role}:${s.sub}`,
      name,
      // Valid until the call window closes (at least 10 min so a late join can still connect).
      ttl: Math.max(600, Math.ceil((closes - now) / 1000)),
      metadata: JSON.stringify({ role: s.role }),
    })
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true })

    return {
      url: env.LIVEKIT_URL,
      token: await at.toJwt(),
      room,
      role: s.role,
      // Who's on the other end, for the waiting screen.
      peerName: s.role === 'physio' ? b.patient_name : b.physio_name,
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(end).toISOString(),
    }
  })
}
