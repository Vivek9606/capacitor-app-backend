import { z } from 'zod'
import type pg from 'pg'
import { env } from './env.js'

// Physio directory listings on betterhood.in.
//
// The listing form lives on the website (/physio-directory/join/). The app opens that same page inside
// the app. Listings are stored here, and the website pulls the live ones at build time (GET /public/directory)
// and renders them at /physio/{slug}/ next to the profiles carried over from WordPress.
// Every publish asks GitHub to rebuild the site (repository_dispatch), so a listing goes live a few minutes
// after the physio submits it.

export const MODES = ['Clinic Visit', 'Home Visit', 'Video Consultation', 'Hospital Visit'] as const

const line = (max: number) => z.string().trim().max(max)
const list = (max: number, n: number) => z.array(line(max).min(1)).max(n).default([])

export const listingInput = z.object({
  name: line(80).min(2),
  email: z.string().trim().email().max(120).optional().or(z.literal('')),
  // Small square JPEG/PNG/WebP made in the browser. Kept as a data URL, served from /public/directory/:slug/photo.
  photo: z
    .string()
    .max(600_000, 'Photo is too large. Use a smaller image.')
    .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/, 'Unsupported photo')
    .optional(),
  degree: line(120).min(2),
  years: z.number().int().min(0).max(60),
  regNo: line(60).optional(),
  council: line(120).optional(),
  city: z.string().regex(/^[a-z0-9-]*$/).max(60).default(''), // website taxonomy slug, '' if not listed
  cityName: line(60).min(2),
  state: z.string().regex(/^[a-z0-9-]*$/).max(60).default(''),
  stateName: line(60).min(2),
  locality: line(120).optional(),
  address: line(300).optional(),
  modes: z.array(z.enum(MODES)).min(1).max(4),
  fee: z.string().regex(/^\d{0,6}$/, 'Fee should be a number in ₹').optional(),
  specializations: list(60, 15),
  about: line(4000).min(40, 'Tell patients a little more about yourself (at least 40 characters)'),
  education: z.array(z.object({ degree: line(120).min(1), institute: line(160).default(''), year: line(30).default('') })).min(1).max(8),
  experience: z.array(z.object({ role: line(160).min(1), place: line(160).default(''), date: line(60).default('') })).max(10).default([]),
  certifications: list(160, 15),
  awards: list(160, 15),
})
export type ListingInput = z.infer<typeof listingInput>

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const slugPart = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^dr\.?\s+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')

export const siteUrl = (slug: string) => `${env.PUBLIC_SITE_URL.replace(/\/$/, '')}/physio/${slug}/`

// ---------- slugs ----------
// Slugs must not clash with the ~1,800 profiles carried over from WordPress. Those are listed in the
// website's /physios-index.json, which we cache for an hour.
let reserved: { at: number; slugs: Set<string> } | undefined
async function siteSlugs(): Promise<Set<string>> {
  if (reserved && Date.now() - reserved.at < 3_600_000) return reserved.slugs
  try {
    const res = await fetch(`${env.PUBLIC_SITE_URL.replace(/\/$/, '')}/physios-index.json`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const rows = (await res.json()) as { s: string }[]
    reserved = { at: Date.now(), slugs: new Set(rows.map((r) => r.s)) }
  } catch (e) {
    console.warn('directory: could not load site slugs, checking our own listings only', (e as Error).message)
    reserved = { at: Date.now() - 3_000_000, slugs: reserved?.slugs ?? new Set() } // retry in ~10 min
  }
  return reserved.slugs
}

/** Same pattern as the old site's profiles: dr-{name}-physiotherapist-{city}. Fixed once published. */
export async function newSlug(c: pg.PoolClient, name: string, cityName: string): Promise<string> {
  const base = `dr-${slugPart(name).slice(0, 40)}-physiotherapist-${slugPart(cityName).slice(0, 30) || 'india'}`.replace(/-+/g, '-')
  const site = await siteSlugs()
  for (let i = 1; i < 50; i++) {
    const s = i === 1 ? base : `${base}-${i}`
    if (site.has(s)) continue
    if ((await c.query('select 1 from directory_profiles where slug = $1', [s])).rowCount) continue
    return s
  }
  throw new Error('Could not find a free profile URL')
}

// ---------- shapes ----------
/** What the app sends back into the form when a physio edits their listing. */
export function stored(input: ListingInput): Omit<ListingInput, 'photo'> {
  const { photo: _photo, ...rest } = input
  return rest
}

/** App focus areas, guessed from the listing's specializations (for physios who sign up on the website). */
export function focusFrom(specs: string[]): string[] {
  const t = specs.join(' | ').toLowerCase()
  const out: string[] = []
  if (/ortho|musculo|joint|spine|back|pain/.test(t)) out.push('Orthopaedic')
  if (/sport/.test(t)) out.push('Sports')
  if (/neuro|stroke|parkinson/.test(t)) out.push('Neuro')
  if (/women|antenatal|postnatal|pelvic|pregnan/.test(t)) out.push('Women’s health')
  if (/geriat|elder|senior/.test(t)) out.push('Geriatric')
  if (/paediat|pediat|child/.test(t)) out.push('Paediatric')
  if (/cardio|pulmon|respir/.test(t)) out.push('Cardio-pulmonary')
  return out.length ? out : ['Orthopaedic']
}

/** App practice modes from the website's modes of treatment. */
export function practiceFrom(modes: ListingInput['modes']) {
  const m: ('clinic' | 'home' | 'individual')[] = []
  if (modes.includes('Clinic Visit')) m.push('clinic')
  if (modes.includes('Home Visit')) m.push('home')
  if (modes.includes('Hospital Visit') || modes.includes('Video Consultation') || !m.length) m.push('individual')
  const labels = { clinic: 'Own clinic', home: 'Home visits', individual: 'Individual practice' }
  return { practice: { modes: m }, practiceSettings: m.map((x) => labels[x]) }
}

type Row = Record<string, any>

/**
 * A listing in the exact shape of the website's src/data/physios.json, so /physio/{slug}/, the directory,
 * city pages and the search index treat it like every other profile.
 */
export function toWebsite(r: Row, apiBase: string) {
  const p = r.profile as ListingInput
  const place = `${p.cityName}, ${p.stateName}`
  const location = p.locality ? `${p.locality}, ${place}` : place
  const hasPhoto = !!(r.photo || r.physio_photo)
  const about = p.about
    .split(/\n\s*\n/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`)
    .join('\n')
  const lead = p.about.replace(/\s+/g, ' ').trim()
  return {
    slug: r.slug,
    name: r.name,
    title: `${r.name} (PT), ${place}`,
    degree: p.degree,
    image: hasPhoto ? `${apiBase}/public/directory/${r.slug}/photo?v=${new Date(r.updated_at).getTime()}` : '',
    place,
    years: p.years,
    about,
    specializations: p.specializations,
    modes: p.modes,
    education: p.education,
    certifications: p.certifications,
    experience: p.experience,
    location,
    fee: p.fee ?? '',
    practice: [
      ...(p.regNo ? [{ label: 'Registration Number', value: p.regNo }] : []),
      ...(p.council ? [{ label: 'Registration Council', value: p.council }] : []),
      { label: 'Practice Location', value: location },
    ],
    address: p.address || location,
    awards: p.awards,
    city: p.city,
    state: p.state,
    area: [],
    speciality: [],
    experienceBand: [],
    qualification: [],
    date: new Date(r.updated_at).toISOString().slice(0, 19),
    seo: {
      title: `${r.name} - Physiotherapist in ${p.cityName} - betterhood`,
      description: lead.length > 155 ? `${lead.slice(0, 152).replace(/\s+\S*$/, '')}…` : lead,
    },
    // Extras the website uses for listings made through the app/API.
    source: 'app',
    verified: r.verification === 'verified',
    bookingUrl: `${(env.PUBLIC_APP_URL ?? env.PUBLIC_WEB_URL).replace(/\/$/, '')}/dr/${r.physio_slug}/book`,
  }
}

// ---------- website rebuild ----------
// Edits often come in bursts, so wait a little and send one rebuild for all of them.
let pending: NodeJS.Timeout | undefined
const REBUILD_DELAY_MS = 20_000

export function rebuildConfigured() {
  return !!(env.SITE_REBUILD_TOKEN && env.SITE_REBUILD_REPO)
}

export function queueSiteRebuild(reason: string) {
  if (!rebuildConfigured()) {
    console.log(`directory: ${reason} (site rebuild not configured; set SITE_REBUILD_TOKEN and SITE_REBUILD_REPO)`)
    return
  }
  if (pending) return
  pending = setTimeout(async () => {
    pending = undefined
    try {
      const res = await fetch(`https://api.github.com/repos/${env.SITE_REBUILD_REPO}/dispatches`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.SITE_REBUILD_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'betterhood-api',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ event_type: 'directory-updated', client_payload: { reason } }),
      })
      if (!res.ok) console.error('directory: site rebuild request failed', res.status, await res.text())
    } catch (e) {
      console.error('directory: site rebuild request failed', e)
    }
  }, REBUILD_DELAY_MS)
}
