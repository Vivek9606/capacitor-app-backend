import type pg from 'pg'
import { z } from 'zod'
import { practice } from './schemas.js'
import { newId, slugify } from './util.js'

export interface NewPhysio {
  phone: string
  name: string
  email?: string
  focusAreas: string[]
  practiceSettings: string[]
  practice?: z.infer<typeof practice>
  referredBy?: string
  qualification?: string
  experienceYrs?: number
  councilRegNo?: string
  photo?: string
}

export const withDr = (name: string) => (/^dr\.?\s/i.test(name) ? name : `Dr. ${name}`)

/**
 * Creates a physio account. Used by the app's quick setup (/auth/signup) and by the directory sign-up on
 * betterhood.in (/directory/signup), so a physio who lists themselves on the website can log in to the app
 * with the same number and find everything there.
 */
export async function createPhysio(c: pg.PoolClient, b: NewPhysio) {
  const name = withDr(b.name)
  const id = newId('ph')
  const base = slugify(name) || 'physio'
  // Reads go through the transaction's client (not the pool) so one request holds one connection.
  const has = async (sql: string, v: unknown) => ((await c.query(sql, [v])).rowCount ?? 0) > 0
  const slug = (await has('select 1 from physios where slug = $1', base)) ? `${base}-${id.slice(-4)}` : base
  const first = (name.replace(/^Dr\.?\s*/i, '').split(' ')[0] || 'PHYSIO').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'PHYSIO'
  let inviteCode = `${first}-BH`
  if (await has('select 1 from physios where invite_code = $1', inviteCode)) inviteCode = `${first}-${id.slice(-3).toUpperCase()}`

  const referrer = b.referredBy ? (await c.query('select id from physios where invite_code = $1', [b.referredBy.toUpperCase()])).rows[0] : undefined
  const r = await c.query(
    `insert into physios (id, phone, name, email, focus_areas, practice_settings, slug, consult, invite_code, referred_by, practice,
                          qualification, experience_yrs, council_reg_no, photo, verification)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
    [
      id,
      b.phone,
      name,
      b.email || null,
      b.focusAreas,
      b.practiceSettings,
      slug,
      {
        inClinic: { enabled: !b.practice || b.practice.modes.some((m) => m !== 'home'), fee: 600, minutes: 45 },
        homeVisit: { enabled: !!b.practice?.modes.includes('home'), fee: 1000, radiusKm: 5, minutes: 60 },
      },
      inviteCode,
      referrer?.id ?? null,
      b.practice ? JSON.stringify(b.practice) : null,
      b.qualification || null,
      b.experienceYrs ?? null,
      b.councilRegNo || null,
      b.photo || null,
      // A registration number means there's something for an admin to verify.
      b.councilRegNo ? 'pending' : 'none',
    ],
  )
  if (referrer) {
    // Upgrade a pending invite if the referrer added one, else record a new "joined".
    const up = await c.query("update referrals set status = 'joined', referred_id = $2 where id = (select id from referrals where referrer_id = $1 and status = 'pending' and referred_id is null order by at limit 1) returning id", [referrer.id, id])
    if (!up.rowCount) await c.query("insert into referrals (id, referrer_id, referred_id, name, status) values ($1,$2,$3,$4,'joined')", [newId('rf'), referrer.id, id, name])
  }
  return r.rows[0]
}
