import type { FastifyInstance, FastifyRequest } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'
import { createPhysio } from '../accounts.js'
import { requireRole, signSession, verifySignup } from '../auth.js'
import { one, q, tx } from '../db.js'
import { focusFrom, listingInput, newSlug, practiceFrom, queueSiteRebuild, rebuildConfigured, siteUrl, stored, toWebsite, type ListingInput } from '../directory.js'
import { HttpError, notFound } from '../util.js'

const LISTING_SQL = `select d.*, ph.name, ph.verification, ph.photo as physio_photo, ph.slug as physio_slug
                       from directory_profiles d join physios ph on ph.id = d.physio_id`

const apiBase = (req: FastifyRequest) => `${req.protocol}://${req.headers.host}`

/** Insert or update a physio's listing and keep their app profile in step with it. */
async function saveListing(c: pg.PoolClient, physioId: string, b: ListingInput) {
  const cur = (await c.query('select slug from directory_profiles where physio_id = $1', [physioId])).rows[0]
  // The URL never changes once published: it's been shared.
  const slug = cur?.slug ?? (await newSlug(c, b.name, b.cityName))
  const row = (
    await c.query(
      `insert into directory_profiles (physio_id, slug, status, profile, photo) values ($1, $2, 'live', $3, $4)
       on conflict (physio_id) do update set profile = excluded.profile, photo = coalesce(excluded.photo, directory_profiles.photo), updated_at = now()
       returning *`,
      [physioId, slug, JSON.stringify(stored(b)), b.photo ?? null],
    )
  ).rows[0]
  // Same person, one profile: the app shows these too.
  await c.query(
    `update physios set qualification = $2, experience_yrs = $3,
            email = coalesce(nullif($4, ''), email),
            photo = coalesce($5, photo),
            council_reg_no = coalesce(nullif($6, ''), council_reg_no),
            verification = case when verification = 'none' and coalesce($6, '') <> '' then 'pending' else verification end
      where id = $1`,
    [physioId, b.degree, b.years, b.email ?? '', b.photo ?? null, b.regNo ?? ''],
  )
  return row
}

function published(row: Record<string, any>) {
  return {
    slug: row.slug,
    status: row.status,
    url: siteUrl(row.slug),
    updatedAt: new Date(row.updated_at).toISOString(),
    // The website is static: a new listing appears after the next build (a few minutes).
    goesLiveIn: rebuildConfigured() ? 'minutes' : 'next_site_update',
  }
}

export async function directoryRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }

  // Website build: every live listing, in the website's profile shape.
  app.get('/public/directory', async (req) => {
    const rows = await q(`${LISTING_SQL} where d.status = 'live' order by d.published_at`)
    return { physios: rows.map((r) => toWebsite(r, apiBase(req))) }
  })

  app.get('/public/directory/:slug/photo', async (req, reply) => {
    const { slug } = z.object({ slug: z.string().max(120) }).parse(req.params)
    const r = await one(`select coalesce(d.photo, ph.photo) as photo from directory_profiles d join physios ph on ph.id = d.physio_id where d.slug = $1 and d.status = 'live'`, [slug])
    const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(r?.photo ?? '')
    if (!m) throw notFound('No photo')
    return reply.header('Content-Type', m[1]).header('Cache-Control', 'public, max-age=604800, immutable').send(Buffer.from(m[2], 'base64'))
  })

  // Signed-in physio (app, or the website form after OTP): their listing, or what we already know to prefill it.
  app.get('/directory/me', async (req) => {
    const pid = requireRole(req, 'physio')
    const ph = await one('select * from physios where id = $1', [pid])
    if (!ph) throw new HttpError(401, 'Account not found', 'unauthenticated')
    const d = await one('select * from directory_profiles where physio_id = $1', [pid])
    return {
      listing: d ? { ...published(d), profile: d.profile, hasPhoto: !!(d.photo || ph.photo) } : null,
      prefill: {
        name: ph.name,
        email: ph.email ?? '',
        degree: ph.qualification ?? '',
        years: ph.experience_yrs ?? undefined,
        regNo: ph.council_reg_no ?? '',
        locality: ph.clinic?.area ?? '',
        address: ph.clinic?.address ?? '',
        modes: [
          ...(ph.practice?.modes?.includes('clinic') || ph.consult?.inClinic?.enabled ? ['Clinic Visit'] : []),
          ...(ph.practice?.modes?.includes('home') || ph.consult?.homeVisit?.enabled ? ['Home Visit'] : []),
        ],
        fee: ph.consult?.inClinic?.enabled ? String(ph.consult.inClinic.fee ?? '') : '',
        hasPhoto: !!ph.photo,
      },
    }
  })

  // Create or update my listing (existing physio account).
  app.put('/directory/me', strict, async (req) => {
    const pid = requireRole(req, 'physio')
    const b = listingInput.parse(req.body)
    const row = await tx(async (c) => {
      const r = await saveListing(c, pid, b)
      await c.query('update physios set name = $2 where id = $1', [pid, b.name.match(/^dr\.?\s/i) ? b.name : `Dr. ${b.name}`])
      return r
    })
    queueSiteRebuild(`listing ${row.slug} saved`)
    return published(row)
  })

  // Website: a new physio lists themselves. Verified number (OTP sign-up token) → app account + live listing.
  app.post('/directory/signup', strict, async (req) => {
    const body = z.object({ signupToken: z.string(), profile: listingInput, referredBy: z.string().max(20).optional() }).parse(req.body)
    const phone = verifySignup(body.signupToken)
    if (await one('select 1 from physios where phone = $1', [phone])) throw new HttpError(409, 'An account already exists for this number. Verify again to edit your listing.', 'exists')
    if (await one('select 1 from patients where phone = $1', [phone])) throw new HttpError(409, 'This number is registered as a patient on Betterhood. Use your practice number to list yourself.', 'patient_number')
    const b = body.profile
    const { practice, practiceSettings } = practiceFrom(b.modes)
    const { physio, row } = await tx(async (c) => {
      const physio = await createPhysio(c, {
        phone,
        name: b.name,
        email: b.email,
        focusAreas: focusFrom(b.specializations),
        practiceSettings,
        practice,
        referredBy: body.referredBy,
        qualification: b.degree,
        experienceYrs: b.years,
        councilRegNo: b.regNo,
        photo: b.photo,
      })
      return { physio, row: await saveListing(c, physio.id, b) }
    })
    queueSiteRebuild(`listing ${row.slug} created`)
    return { token: signSession({ sub: physio.id, role: 'physio' }), role: 'physio', userId: physio.id, ...published(row) }
  })
}
