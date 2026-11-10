import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { signSession, signSignup, verifySignup } from '../auth.js'
import { one, q, tx } from '../db.js'
import { adminPhones, env } from '../env.js'
import { practice } from '../schemas.js'
import { sendWhatsApp } from '../whatsapp.js'
import * as M from '../mappers.js'
import { badRequest, HttpError, linkToken, newId, normalizePhone, otpCode, safeEqual, sha256, slugify, todayIST } from '../util.js'

const OTP_TTL_MIN = 10
const OTP_MAX_ATTEMPTS = 5
const OTP_MAX_PER_HOUR = 5
const LINK_MAX_ATTEMPTS = 5
const LINK_LOCK_MIN = 30

const phoneBody = z.object({ phone: z.string() })

function phoneOrThrow(raw: string): string {
  const p = normalizePhone(raw)
  if (!p) throw badRequest('Enter a valid 10-digit Indian mobile number')
  return p
}

async function accountFor(phone: string) {
  const ph = await one('select id from physios where phone = $1', [phone])
  if (ph) return { role: 'physio' as const, id: ph.id as string }
  const pt = await one('select id from patients where phone = $1 order by created_at desc limit 1', [phone])
  if (pt) return { role: 'patient' as const, id: pt.id as string }
  return undefined
}

export async function authRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }

  // O2 · send a one-time code on WhatsApp
  app.post('/auth/otp/request', strict, async (req) => {
    const phone = phoneOrThrow(phoneBody.parse(req.body).phone)
    const recent = await one<{ n: number }>("select count(*)::int as n from otp_codes where phone = $1 and created_at > now() - interval '1 hour'", [phone])
    if ((recent?.n ?? 0) >= OTP_MAX_PER_HOUR) throw new HttpError(429, 'Too many codes requested. Try again in an hour.', 'otp_rate_limited')

    const code = env.OTP_DEV_CODE ?? otpCode()
    await q('delete from otp_codes where created_at < now() - interval \'1 day\'')
    await q(`insert into otp_codes (phone, code_hash, expires_at) values ($1, $2, now() + interval '${OTP_TTL_MIN} minutes')`, [phone, sha256(`${phone}:${code}`)])
    if (!env.OTP_DEV_CODE) await sendWhatsApp({ name: 'auth_otp', to: phone, code })
    return { ok: true, expiresInSec: OTP_TTL_MIN * 60 }
  })

  // O3 · verify the code → session (existing user) or sign-up token (new physio)
  app.post('/auth/otp/verify', strict, async (req) => {
    const body = z.object({ phone: z.string(), code: z.string().regex(/^\d{6}$/), as: z.enum(['admin']).optional() }).parse(req.body)
    const phone = phoneOrThrow(body.phone)
    const row = await one<{ id: number; code_hash: string; attempts: number }>(
      'select id, code_hash, attempts from otp_codes where phone = $1 and not used and expires_at > now() order by created_at desc limit 1',
      [phone],
    )
    if (!row) throw new HttpError(400, 'Code expired. Request a new one.', 'otp_expired')
    if (row.attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(429, 'Too many wrong attempts. Request a new code.', 'otp_locked')
    if (!safeEqual(row.code_hash, sha256(`${phone}:${body.code}`))) {
      await q('update otp_codes set attempts = attempts + 1 where id = $1', [row.id])
      throw new HttpError(400, 'That code didn’t match. Check WhatsApp and try again.', 'otp_invalid')
    }
    await q('update otp_codes set used = true where id = $1', [row.id])

    // Admin dashboard sign-in: only numbers listed in ADMIN_PHONES.
    if (body.as === 'admin') {
      if (!adminPhones.has(phone)) throw new HttpError(403, 'This number is not an admin.', 'forbidden')
      return { token: signSession({ sub: phone, role: 'admin' }), role: 'admin', userId: phone }
    }

    const acct = await accountFor(phone)
    if (acct) return { token: signSession({ sub: acct.id, role: acct.role }), role: acct.role, userId: acct.id }
    return { signupToken: signSignup(phone) }
  })

  // O4 · quick setup creates the physio account
  app.post('/auth/signup', strict, async (req) => {
    const body = z
      .object({
        signupToken: z.string(),
        name: z.string().trim().min(2).max(80),
        email: z.string().trim().email().max(120).optional().or(z.literal('')),
        focusAreas: z.array(z.string().max(40)).max(12),
        practiceSettings: z.array(z.string().max(40)).max(8),
        practice: practice.optional(),
        referredBy: z.string().max(20).optional(),
      })
      .parse(req.body)
    const phone = verifySignup(body.signupToken)
    if (await one('select 1 from physios where phone = $1', [phone])) throw new HttpError(409, 'An account already exists for this number. Log in instead.', 'exists')

    const name = /^dr\.?\s/i.test(body.name) ? body.name : `Dr. ${body.name}`
    const id = newId('ph')
    const base = slugify(name) || 'physio'
    const slug = (await one('select 1 from physios where slug = $1', [base])) ? `${base}-${id.slice(-4)}` : base
    const first = (name.replace(/^Dr\.?\s*/i, '').split(' ')[0] || 'PHYSIO').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'PHYSIO'
    let inviteCode = `${first}-BH`
    if (await one('select 1 from physios where invite_code = $1', [inviteCode])) inviteCode = `${first}-${id.slice(-3).toUpperCase()}`

    const physio = await tx(async (c) => {
      const referrer = body.referredBy ? (await c.query('select id from physios where invite_code = $1', [body.referredBy.toUpperCase()])).rows[0] : undefined
      const r = await c.query(
        `insert into physios (id, phone, name, email, focus_areas, practice_settings, slug, consult, invite_code, referred_by, practice)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [
          id,
          phone,
          name,
          body.email || null,
          body.focusAreas,
          body.practiceSettings,
          slug,
          {
            inClinic: { enabled: !body.practice || body.practice.modes.some((m) => m !== 'home'), fee: 600, minutes: 45 },
            homeVisit: { enabled: !!body.practice?.modes.includes('home'), fee: 1000, radiusKm: 5, minutes: 60 },
          },
          inviteCode,
          referrer?.id ?? null,
          body.practice ? JSON.stringify(body.practice) : null,
        ],
      )
      if (referrer) {
        // Upgrade a pending invite if the referrer added one, else record a new "joined".
        const up = await c.query("update referrals set status = 'joined', referred_id = $2 where id = (select id from referrals where referrer_id = $1 and status = 'pending' and referred_id is null order by at limit 1) returning id", [referrer.id, id])
        if (!up.rowCount) await c.query("insert into referrals (id, referrer_id, referred_id, name, status) values ($1,$2,$3,$4,'joined')", [newId('rf'), referrer.id, id, name])
      }
      return r.rows[0]
    })
    return { token: signSession({ sub: physio.id, role: 'physio' }), role: 'physio', userId: physio.id }
  })

  // A patient joining on their own (no physio yet). They take an assessment next and an admin assigns a physio.
  app.post('/auth/signup-patient', strict, async (req) => {
    const body = z
      .object({
        signupToken: z.string(),
        name: z.string().trim().min(2).max(80),
        age: z.number().int().min(1).max(120).optional(),
        sex: z.enum(['F', 'M', 'O']).optional(),
        city: z.string().trim().max(80).optional(),
        email: z.string().trim().email().max(120).optional().or(z.literal('')),
      })
      .parse(req.body)
    const phone = verifySignup(body.signupToken)
    const existing = await accountFor(phone)
    if (existing) return { token: signSession({ sub: existing.id, role: existing.role }), role: existing.role, userId: existing.id }
    const row = await one(
      `insert into patients (id, physio_id, phone, name, age, sex, city, email, since, link_token, consent_at, self_signup, match_status)
       values ($1, null, $2, $3, $4, $5, $6, $7, $8, $9, now(), true, 'pending') returning *`,
      [newId('pt'), phone, body.name, body.age ?? null, body.sex ?? null, body.city || null, body.email || null, todayIST(), linkToken()],
    )
    return { token: signSession({ sub: row!.id, role: 'patient' }), role: 'patient', userId: row!.id, patient: M.patient(row!) }
  })

  // Patient entry from WhatsApp: last 4 digits of the number the plan was sent to.
  app.post('/auth/plan-link/verify', strict, async (req) => {
    const body = z.object({ token: z.string().min(6).max(64), last4: z.string().regex(/^\d{4}$/) }).parse(req.body)
    const patient = await one('select * from patients where link_token = $1', [body.token])
    if (!patient) throw new HttpError(404, 'This link has expired', 'link_invalid')

    const att = await one<{ attempts: number; locked_until: Date | null }>('select attempts, locked_until from link_attempts where link_token = $1', [body.token])
    if (att?.locked_until && att.locked_until > new Date()) throw new HttpError(429, 'Too many tries. Log in with a WhatsApp code instead.', 'link_locked')

    if (patient.phone.slice(-4) !== body.last4) {
      const attempts = (att?.attempts ?? 0) + 1
      await q(
        `insert into link_attempts (link_token, attempts, locked_until, updated_at) values ($1, $2, $3, now())
         on conflict (link_token) do update set attempts = $2, locked_until = $3, updated_at = now()`,
        [body.token, attempts >= LINK_MAX_ATTEMPTS ? 0 : attempts, attempts >= LINK_MAX_ATTEMPTS ? new Date(Date.now() + LINK_LOCK_MIN * 60_000) : null],
      )
      throw new HttpError(400, 'Those digits don’t match the number this plan was sent to.', 'link_mismatch')
    }
    await q('delete from link_attempts where link_token = $1', [body.token])
    return {
      token: signSession({ sub: patient.id, role: 'patient' }),
      role: 'patient',
      userId: patient.id,
      consentGiven: !!patient.consent_at,
    }
  })

  // Public preview for the plan link page — no health details before verification.
  app.get('/public/plan-link/:token', async (req) => {
    const { token } = z.object({ token: z.string().max(64) }).parse(req.params)
    const r = await one(
      `select pt.name as patient_name, pt.phone, pt.consent_at, ph.*,
              pl.weeks, pl.days_per_week, jsonb_array_length(pl.items) as n_items, pl.rx is not null as has_rx
         from patients pt join physios ph on ph.id = pt.physio_id
         left join plans pl on pl.patient_id = pt.id and pl.status = 'active'
        where pt.link_token = $1`,
      [token],
    )
    if (!r) throw new HttpError(404, 'This link has expired', 'link_invalid')
    return {
      patientFirstName: String(r.patient_name).split(' ')[0],
      consentGiven: !!r.consent_at,
      physio: { name: r.name, qualification: r.qualification ?? undefined, area: r.clinic?.area ?? undefined, photo: r.photo ?? undefined },
      plan: r.weeks ? { weeks: r.weeks, daysPerWeek: r.days_per_week, items: r.n_items, hasRx: r.has_rx } : undefined,
    }
  })

  app.get('/public/invite/:code', async (req) => {
    const { code } = z.object({ code: z.string().max(20) }).parse(req.params)
    const r = await one('select name, photo from physios where invite_code = $1', [code.toUpperCase()])
    if (!r) throw new HttpError(404, 'Invite not found', 'not_found')
    return { name: r.name, photo: r.photo ?? undefined }
  })
}
