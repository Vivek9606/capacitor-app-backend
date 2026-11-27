// Slouch Catcher, the posture game on betterhood.in/slouch-catcher/ (it used to be a separate service).
//
//   1. Anyone uploads a photo → POST /slouch/analyze → posture animal, score, zones, products, plus a signed
//      copy of the result (catchToken) so a catch can only come from a real analysis.
//   2. To share it for points they sign in with their betterhood account (the website's normal WhatsApp OTP;
//      a new number gets a free patient account). POST /slouch/catches saves the catch and pays the snap points.
//   3. The WhatsApp message links to betterhood.in/slouch-catcher/c/?code=…. The caught person signs in there,
//      POST /slouch/catches/:code/join shows them their full report and pays the catcher the join points.
//   4. 1000 points → POST /slouch/redeem → a ₹200 shop coupon (Shopify, the coupon pool, or a test code).
//
// Points belong to the account's phone number. Photos are never stored, only results.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import { sessionFrom } from '../auth.js'
import { one, pool, q, tx } from '../db.js'
import { env } from '../env.js'
import { analysePhoto, slouchDemo } from '../slouch/ai.js'
import { PERSONAS, personaById, routePersona, zoneScore, type Zones } from '../slouch/personas.js'
import { productById, productsFor } from '../slouch/products.js'
import { createDiscountCode, shopifyConfigured } from '../slouch/shopify.js'
import { HttpError, newId, safeEqual } from '../util.js'

export const SLOUCH_POINTS = {
  welcome: 50, // the first time someone uses Slouch Catcher signed in
  snap: 20, // each catch shared (up to snapDailyCap a day)
  snapDailyCap: 5,
  join: 150, // when the caught person opens the link and signs in (once per pair of people)
  couponPoints: 1000,
  couponValue: 200,
  couponMinOrder: 0,
}
const P = SLOUCH_POINTS
const SHOP_HOME = 'https://shop.betterhood.in/'

// ---------- signed results ----------
const KEY = createHmac('sha256', env.JWT_SECRET).update('slouch-catcher result v1').digest()
const sign = (s: string) => createHmac('sha256', KEY).update(s).digest('base64url')
interface Signed { id: string; at: number; persona: string; verdict: string; score: number; zones: Zones; summary: string; issues: string[] }
function signResult(r: Omit<Signed, 'id' | 'at'>) {
  const payload = Buffer.from(JSON.stringify({ id: randomUUID(), at: Date.now(), ...r })).toString('base64url')
  return `${payload}.${sign(payload)}`
}
function readResult(token: string): Signed {
  const [payload, sig] = String(token || '').split('.')
  if (!payload || !sig || !safeEqual(sig, sign(payload))) throw new HttpError(400, 'This result could not be verified. Please run the check again.', 'bad_result')
  const r = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Signed
  if (Date.now() - r.at > 24 * 3600_000) throw new HttpError(400, 'This result is too old to share for points. Please run the check again.', 'result_expired')
  if (!personaById[r.persona]) throw new HttpError(400, 'Unknown posture animal.', 'bad_result')
  return r
}

// ---------- who is playing ----------
interface Player { phone: string; name: string | null }
/** The signed-in betterhood account (patient or physio) behind this request; welcome points on first use. */
async function player(req: FastifyRequest, required: true): Promise<Player>
async function player(req: FastifyRequest, required?: false): Promise<Player | null>
async function player(req: FastifyRequest, required = false): Promise<Player | null> {
  if (!req.headers.authorization) {
    if (required) throw new HttpError(401, 'Please sign in with your betterhood account first.', 'unauthenticated')
    return null
  }
  const s = sessionFrom(req)
  if (s.role === 'admin') throw new HttpError(403, 'Use a patient or physio account to play Slouch Catcher.', 'forbidden')
  const me = await one<{ phone: string; name: string | null }>(`select phone, name from ${s.role === 'physio' ? 'physios' : 'patients'} where id = $1`, [s.sub])
  if (!me) throw new HttpError(401, 'Account not found', 'unauthenticated')
  await award(pool, me.phone, P.welcome, 'welcome', `welcome:${me.phone}`)
  return { phone: me.phone, name: me.name }
}

type Db = pg.Pool | pg.PoolClient
async function award(db: Db, phone: string, delta: number, reason: string, key: string, refs: { catchId?: string; couponId?: string } = {}) {
  const r = await db.query(
    'insert into slouch_points (phone, delta, reason, dedupe_key, catch_id, coupon_id) values ($1, $2, $3, $4, $5, $6) on conflict (dedupe_key) do nothing',
    [phone, delta, reason, key, refs.catchId ?? null, refs.couponId ?? null],
  )
  return r.rowCount === 1
}
async function balance(db: Db, phone: string) {
  const r = await db.query<{ points: number }>('select coalesce(sum(delta), 0)::int as points from slouch_points where phone = $1', [phone])
  return r.rows[0].points
}

const cleanName = (v: unknown) => String(v ?? '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O/1/I/L
const randomCode = (n: number) => Array.from(randomBytes(n), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('')
const codeParam = z.object({ code: z.string().regex(/^[A-Za-z0-9]{4,12}$/).transform((s) => s.toUpperCase()) })

export async function slouchRoutes(app: FastifyInstance) {
  // The 20 animals without their routing rules, for the website's grid and result cards.
  app.get('/slouch/personas', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=3600')
    return { personas: PERSONAS.map(({ id, name, emoji, tier, pattern, remark }) => ({ id, name, emoji, tier, pattern, remark })) }
  })

  // Photo → posture animal. Public; photos are small JPEGs (the browser resizes them to 1024px first).
  app.post('/slouch/analyze', {
    bodyLimit: 4_000_000,
    config: { rateLimit: { max: slouchDemo() ? 60 : 8, timeWindow: '1 minute' } },
  }, async (req) => {
    const { image } = z.object({ image: z.string().max(4_000_000) }).parse(req.body)
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image)
    if (!m) throw new HttpError(400, 'Please upload a JPG, PNG or WebP photo.', 'bad_photo')
    const raw = await analysePhoto(m[1], m[2])
    const summary = String(raw.summary || '').trim()
    const setting = raw.setting || 'other'
    const base = { summary, setting, demo: !!raw.demo, test: env.SLOUCH_TEST_MODE }
    let out
    if (raw.verdict === 'unclear') {
      out = { verdict: 'unclear' as const, score: null, zones: null, persona: null, issues: [], products: [], catchToken: null, ...base }
    } else {
      const { persona, zones } = routePersona({ N: raw.neck, S: raw.shoulder, B: raw.back, K: raw.knee })
      const verdict = persona.tier === 'good' ? ('good' as const) : ('bad' as const)
      const score = zoneScore(zones)
      const issues = Array.isArray(raw.issues) ? raw.issues.slice(0, 3).map(String) : []
      out = {
        verdict, score, zones, persona: persona.id, issues, products: productsFor(persona, setting), ...base,
        catchToken: signResult({ persona: persona.id, verdict, score, zones, summary, issues }),
      }
    }
    pool.query('insert into slouch_analyses (persona, verdict, score, setting, test) values ($1, $2, $3, $4, $5)',
      [out.persona, out.verdict, out.score, setting, !!raw.demo]).catch((e) => req.log.warn(e, 'slouch analysis log failed'))
    return out
  })

  // Points, coupons and catches for the signed-in account (user: null when signed out).
  app.get('/slouch/me', async (req) => {
    const me = await player(req)
    const base = { enabled: true, betterhood: true, testMode: env.SLOUCH_TEST_MODE, config: P }
    if (!me) return { ...base, user: null }
    const [points, coupons, catches] = await Promise.all([
      balance(pool, me.phone),
      q('select code, value_inr, created_at from slouch_coupons where phone = $1 order by created_at desc', [me.phone]),
      q(`select code, target_name, persona, score, verdict, created_at, joined_at is not null as joined
         from slouch_catches where catcher_phone = $1 order by created_at desc limit 30`, [me.phone]),
    ])
    return {
      ...base,
      user: { name: me.name, phone: `${me.phone.slice(0, 2)}******${me.phone.slice(-2)}` },
      points,
      coupons: coupons.map((c) => ({ code: c.code, value: c.value_inr, at: c.created_at })),
      catches: catches.map((c) => ({ code: c.code, target: c.target_name, persona: c.persona, score: Number(c.score), verdict: c.verdict, at: c.created_at, joined: c.joined })),
    }
  })

  // Save a result as a catch (for the share link) and pay the snap points.
  app.post('/slouch/catches', async (req) => {
    const me = await player(req, true)
    const b = z.object({ token: z.string().max(4000), targetName: z.string().max(80), catcherName: z.string().max(80).optional() }).parse(req.body)
    const r = readResult(b.token)
    const target = cleanName(b.targetName)
    if (!target) throw new HttpError(400, 'Who did you catch? Add their name.', 'bad_request')
    const catcherName = cleanName(b.catcherName) || me.name
    const out = await tx(async (c) => {
      const existing = (await c.query('select id, code, catcher_phone from slouch_catches where analysis_id = $1', [r.id])).rows[0]
      if (existing) {
        if (existing.catcher_phone !== me.phone) throw new HttpError(409, 'This result was already shared by someone else.', 'taken')
        return { code: existing.code as string, pointsEarned: 0, points: await balance(c, me.phone) }
      }
      let row: { id: string; code: string } | undefined
      for (let i = 0; i < 5 && !row; i++) {
        row = (await c.query(
          `insert into slouch_catches (id, code, analysis_id, catcher_phone, catcher_name, target_name, persona, verdict, score, zones, summary, issues)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) on conflict (code) do nothing returning id, code`,
          [newId('sc'), randomCode(6), r.id, me.phone, catcherName, target, r.persona, r.verdict, r.score, JSON.stringify(r.zones), r.summary || null, JSON.stringify(r.issues || [])],
        )).rows[0]
      }
      if (!row) throw new Error('could not allocate a catch code')
      const today = (await c.query(
        `select count(*)::int as n from slouch_points where phone = $1 and reason = 'snap'
         and created_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')`, [me.phone])).rows[0].n
      const paid = today < P.snapDailyCap && (await award(c, me.phone, P.snap, 'snap', `snap:${row.id}`, { catchId: row.id }))
      return { code: row.code, pointsEarned: paid ? P.snap : 0, points: await balance(c, me.phone) }
    })
    return { ...out, joinPoints: P.join }
  })

  // The catch link page. The full report only goes to the caught person, once they've signed in and joined.
  app.get('/slouch/catches/:code', async (req) => {
    const { code } = codeParam.parse(req.params)
    const c = await one('select * from slouch_catches where code = $1', [code])
    if (!c) throw new HttpError(404, "We couldn't find this catch. The link may be wrong.", 'not_found')
    const me = await player(req)
    const viewer = !me ? null : me.phone === c.catcher_phone ? 'catcher' : me.phone === c.target_phone ? 'target' : 'other'
    return {
      catcher: c.catcher_name || 'A friend', target: c.target_name, persona: c.persona, verdict: c.verdict, score: Number(c.score),
      joined: !!c.target_phone, viewer, joinPoints: P.join, welcomePoints: P.welcome,
      ...(viewer === 'target' ? { report: { zones: c.zones, summary: c.summary, issues: c.issues } } : {}),
    }
  })

  app.post('/slouch/catches/:code/join', async (req) => {
    const { code } = codeParam.parse(req.params)
    const me = await player(req, true)
    const c = await one('select * from slouch_catches where code = $1', [code])
    if (!c) throw new HttpError(404, "We couldn't find this catch. The link may be wrong.", 'not_found')
    if (c.catcher_phone === me.phone) return { status: 'self', catcher: c.catcher_name }
    const out = await tx(async (t) => {
      // The first person to sign in from the link claims it.
      const claimed = (await t.query('update slouch_catches set target_phone = $1, joined_at = now() where id = $2 and target_phone is null returning id', [me.phone, c.id])).rowCount === 1
      if (!claimed && c.target_phone !== me.phone) return { status: 'taken' as const }
      // The catcher is paid once per pair of people, however often they catch each other.
      const paid = claimed && (await award(t, c.catcher_phone, P.join, 'join', `join:${c.catcher_phone}:${me.phone}`, { catchId: c.id }))
      return { status: 'joined' as const, catcherPaid: paid }
    })
    return {
      ...out, catcher: c.catcher_name || 'your friend',
      ...(out.status === 'joined' ? { report: { zones: c.zones, summary: c.summary, issues: c.issues } } : {}),
    }
  })

  // 1000 points → a ₹200 shop coupon.
  app.post('/slouch/redeem', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    const me = await player(req, true)
    const out = await tx(async (c) => {
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [`slouch-redeem:${me.phone}`]) // one redemption at a time per person
      const points = await balance(c, me.phone)
      if (points < P.couponPoints) throw new HttpError(400, `You need ${P.couponPoints} points for a coupon. You have ${points}.`, 'not_enough_points')
      let code: string, value = P.couponValue, source: 'test' | 'shopify' | 'pool'
      if (env.SLOUCH_TEST_MODE) {
        code = env.SLOUCH_TEST_COUPON; source = 'test'
      } else if (shopifyConfigured()) {
        code = 'SLOUCH-' + randomCode(6)
        try { await createDiscountCode(code, value, P.couponMinOrder) } catch (e) {
          req.log.error(e, 'slouch coupon: shopify')
          throw new HttpError(502, "We couldn't create your coupon just now. Your points are safe, please try again.", 'coupon_failed')
        }
        source = 'shopify'
      } else {
        const row = (await c.query(
          `update slouch_coupon_pool set claimed_by = $1, claimed_at = now()
           where code = (select code from slouch_coupon_pool where claimed_by is null order by added_at, code limit 1 for update skip locked)
           returning code, value_inr`, [me.phone])).rows[0]
        if (!row) throw new HttpError(503, 'Coupons are being restocked. Your points are safe, please try again soon.', 'coupons_out')
        code = row.code; value = row.value_inr; source = 'pool'
      }
      const id = newId('cp')
      await c.query('insert into slouch_coupons (id, phone, code, value_inr, points_spent, source) values ($1, $2, $3, $4, $5, $6)', [id, me.phone, code, value, P.couponPoints, source])
      await award(c, me.phone, -P.couponPoints, 'redeem', `redeem:${id}`, { couponId: id })
      return { code, value, points: points - P.couponPoints }
    })
    req.log.info({ value: out.value }, 'slouch coupon issued')
    return out
  })

  // Short product links for the WhatsApp message: /slouch/go/<product id> (or "shop"), with the UTM tags added here.
  app.get('/slouch/go/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params)
    const target = new URL(productById[id]?.url || SHOP_HOME)
    target.searchParams.set('utm_source', 'slouch-catcher')
    target.searchParams.set('utm_medium', 'whatsapp')
    reply.header('Cache-Control', 'no-store')
    return reply.redirect(target.toString(), 302)
  })
}
