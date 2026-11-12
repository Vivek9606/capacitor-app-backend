import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../auth.js'
import { one, q } from '../db.js'
import { siteUrl } from '../directory.js'
import { newId, notFound } from '../util.js'

/**
 * Master admin dashboard: the consumer journey and the physio journey, built from what the app and the
 * website already store. Read-only apart from the admins' own notes and tags.
 */

type Row = Record<string, any>
const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : v ? String(v) : undefined)
/** A DATE column ('YYYY-MM-DD') as a timestamp at midday in India, so it sorts sensibly among real timestamps. */
const dayIso = (d: unknown): string | undefined => (d ? new Date(`${d}T12:00:00+05:30`).toISOString() : undefined)
const latest = (...v: (string | undefined)[]) => v.filter(Boolean).sort().pop()
const daysSince = (ts?: string) => (ts ? Math.floor((Date.now() - new Date(ts).getTime()) / 86_400_000) : undefined)

/** active: did something in the last 7 days · slipping: 8 to 21 days · inactive: longer. */
const health = (lastActiveAt?: string) => {
  const d = daysSince(lastActiveAt)
  return d === undefined ? 'inactive' : d <= 7 ? 'active' : d <= 21 ? 'slipping' : 'inactive'
}

const subjectType = z.enum(['patient', 'physio', 'lead'])
const SUBJECT_TABLE = { patient: 'patients', physio: 'physios', lead: 'web_submissions' } as const

// ---------- consumers ----------
const CONSUMER_SQL = `
  select p.id, p.name, p.phone, p.city, p.physio_id, ph.name as physio_name, p.self_signup, p.condition,
         p.created_at, p.last_seen_at, p.consent_at, p.discharged_at,
         a.n as assessments, a.first_at as first_assessment_at, a.last_at as last_assessment_at,
         (select area from assessments where patient_id = p.id and kind = 'pain' order by created_at desc limit 1) as pain_area,
         b.n as bookings, b.first_at as first_booking_at, b.last_at as last_booking_at,
         pl.n as plans, pl.first_at as first_plan_at, pl.opened_at as plan_opened_at,
         s.done as sessions_done, s.skipped as sessions_skipped, s.first_date as first_session_date, s.last_date as last_session_date,
         m.last_at as last_message_at, i.paid as paid_total,
         w.n as web_submissions, w.first_at as first_web_at,
         coalesce(t.tags, '{}') as admin_tags, n.n as notes
  from patients p
  left join physios ph on ph.id = p.physio_id
  left join lateral (select count(*)::int n, min(created_at) first_at, max(created_at) last_at from assessments where patient_id = p.id) a on true
  left join lateral (select count(*)::int n, min(created_at) first_at, max(created_at) last_at from bookings
                     where patient_id = p.id or (patient_id is null and patient_phone = p.phone and physio_id = p.physio_id)) b on true
  left join lateral (select count(*)::int n, min(sent_at) first_at, min(opened_at) opened_at from plans where patient_id = p.id) pl on true
  left join lateral (select count(*) filter (where sl.status = 'done')::int done, count(*) filter (where sl.status = 'skipped')::int skipped,
                            min(sl.date) filter (where sl.status = 'done') first_date, max(sl.date) filter (where sl.status = 'done') last_date
                     from session_logs sl join plans x on x.id = sl.plan_id where x.patient_id = p.id) s on true
  left join lateral (select max(at) last_at from messages where patient_id = p.id and sender = 'patient') m on true
  left join lateral (select coalesce(sum(total), 0)::int paid from invoices where patient_id = p.id and status = 'paid') i on true
  left join lateral (select count(*)::int n, min(created_at) first_at from web_submissions where phone = p.phone) w on true
  left join admin_tags t on t.subject_type = 'patient' and t.subject_id = p.id
  left join lateral (select count(*)::int n from admin_notes where subject_type = 'patient' and subject_id = p.id) n on true`

function consumer(r: Row) {
  const lastActiveAt = latest(iso(r.last_seen_at), dayIso(r.last_session_date), iso(r.last_booking_at), iso(r.last_message_at), iso(r.last_assessment_at), iso(r.created_at))
  // Furthest point reached in care. Taking an assessment is tracked separately: people a physio adds never need one.
  const stage = r.discharged_at ? 'discharged' : r.sessions_done > 0 ? 'exercising' : r.plans > 0 ? 'on_plan' : r.bookings > 0 ? 'booked' : r.physio_id ? 'matched' : r.assessments > 0 ? 'assessed' : 'signed_up'
  return {
    id: r.id as string,
    name: r.name as string,
    phone: r.phone as string,
    city: r.city ?? undefined,
    condition: r.condition ?? undefined,
    painArea: r.pain_area ?? undefined,
    physioId: r.physio_id ?? undefined,
    physioName: r.physio_name ?? undefined,
    origin: r.self_signup ? 'self' : 'physio',
    stage,
    health: r.discharged_at ? 'discharged' : health(lastActiveAt),
    createdAt: iso(r.created_at)!,
    lastSeenAt: iso(r.last_seen_at),
    lastActiveAt,
    firstWebAt: iso(r.first_web_at),
    webSubmissions: r.web_submissions as number,
    assessments: r.assessments as number,
    firstAssessmentAt: iso(r.first_assessment_at),
    bookings: r.bookings as number,
    firstBookingAt: iso(r.first_booking_at),
    plans: r.plans as number,
    firstPlanAt: iso(r.first_plan_at),
    planOpenedAt: iso(r.plan_opened_at),
    sessionsDone: r.sessions_done as number,
    sessionsSkipped: r.sessions_skipped as number,
    firstSessionAt: dayIso(r.first_session_date),
    lastSessionAt: dayIso(r.last_session_date),
    paidTotal: r.paid_total as number,
    dischargedAt: iso(r.discharged_at),
    tags: r.admin_tags as string[],
    notes: r.notes as number,
  }
}

// ---------- physios ----------
// No photo here: it's a data URL and would make the list huge.
const PHYSIO_SQL = `
  select ph.id, ph.name, ph.phone, ph.email, ph.verification, ph.qualification, ph.focus_areas, ph.clinic, ph.practice, ph.availability, ph.billing,
         ph.course_progress, ph.created_at, ph.last_seen_at, ph.photo is not null as has_photo, ph.referred_by is not null as was_referred,
         pt.n as patients, pt.first_at as first_patient_at, pt.last_at as last_patient_at, pt.discharged,
         pl.n as plans, pl.first_at as first_plan_at, pl.last_at as last_plan_at, pl.active as active_plans,
         b.n as bookings, b.public_n as public_bookings, b.first_at as first_booking_at, b.last_at as last_booking_at,
         i.n as invoices, i.first_at as first_invoice_at, i.last_at as last_invoice_at, i.paid as paid_total, i.unpaid as unpaid_total,
         g.n as groups, rf.n as referrals, s.active as active_patients,
         dp.status as listing_status, dp.slug as listing_slug, dp.published_at as listed_at,
         coalesce(t.tags, '{}') as admin_tags, n.n as notes
  from physios ph
  left join lateral (select count(*)::int n, min(created_at) first_at, max(created_at) last_at, count(*) filter (where discharged_at is not null)::int discharged
                     from patients where physio_id = ph.id) pt on true
  left join lateral (select count(*)::int n, min(sent_at) first_at, max(sent_at) last_at, count(*) filter (where status = 'active')::int active from plans where physio_id = ph.id) pl on true
  left join lateral (select count(*)::int n, count(*) filter (where source = 'public_profile')::int public_n, min(created_at) first_at, max(created_at) last_at from bookings where physio_id = ph.id) b on true
  left join lateral (select count(*) filter (where status <> 'void')::int n, min(created_at) first_at, max(created_at) last_at,
                            coalesce(sum(total) filter (where status = 'paid'), 0)::int paid, coalesce(sum(total) filter (where status = 'unpaid'), 0)::int unpaid
                     from invoices where physio_id = ph.id) i on true
  left join lateral (select count(*)::int n from group_sessions where physio_id = ph.id) g on true
  left join lateral (select count(*)::int n from referrals where referrer_id = ph.id) rf on true
  left join lateral (select count(distinct x.patient_id)::int active from session_logs sl join plans x on x.id = sl.plan_id
                     where x.physio_id = ph.id and sl.status = 'done' and sl.date >= (now() - interval '14 days')::date) s on true
  left join directory_profiles dp on dp.physio_id = ph.id
  left join admin_tags t on t.subject_type = 'physio' and t.subject_id = ph.id
  left join lateral (select count(*)::int n from admin_notes where subject_type = 'physio' and subject_id = ph.id) n on true`

function physio(r: Row) {
  const place = [r.clinic?.address, r.clinic?.area, r.practice?.serviceArea, ...((r.practice?.locations ?? []) as Row[]).map((l) => l.address)].filter(Boolean).join(' · ')
  // What a physio needs before patients can find and book them.
  const setup = {
    photo: !!r.has_photo,
    qualification: !!r.qualification,
    focusAreas: (r.focus_areas ?? []).length > 0,
    place: !!place,
    availability: !!r.availability,
    billing: !!r.billing,
  }
  const setupDone = Object.values(setup).filter(Boolean).length
  const lastActiveAt = latest(iso(r.last_seen_at), iso(r.last_patient_at), iso(r.last_plan_at), iso(r.last_booking_at), iso(r.last_invoice_at), iso(r.created_at))
  const stage = r.invoices > 0 && r.plans > 0 ? 'running' : r.plans > 0 ? 'treating' : r.patients > 0 ? 'first_patient' : setupDone >= 4 ? 'set_up' : 'signed_up'
  return {
    id: r.id as string,
    name: r.name as string,
    phone: r.phone as string,
    email: r.email ?? undefined,
    place: place || undefined,
    focusAreas: (r.focus_areas ?? []) as string[],
    verification: r.verification as string,
    stage,
    health: health(lastActiveAt),
    setup,
    setupDone,
    setupTotal: Object.keys(setup).length,
    wasReferred: !!r.was_referred,
    createdAt: iso(r.created_at)!,
    lastSeenAt: iso(r.last_seen_at),
    lastActiveAt,
    listing: r.listing_slug ? { status: r.listing_status as string, url: siteUrl(r.listing_slug), publishedAt: iso(r.listed_at) } : undefined,
    patients: r.patients as number,
    activePatients: r.active_patients as number,
    discharged: r.discharged as number,
    firstPatientAt: iso(r.first_patient_at),
    plans: r.plans as number,
    activePlans: r.active_plans as number,
    firstPlanAt: iso(r.first_plan_at),
    bookings: r.bookings as number,
    publicBookings: r.public_bookings as number,
    firstBookingAt: iso(r.first_booking_at),
    invoices: r.invoices as number,
    firstInvoiceAt: iso(r.first_invoice_at),
    paidTotal: r.paid_total as number,
    unpaidTotal: r.unpaid_total as number,
    groups: r.groups as number,
    referrals: r.referrals as number,
    courseLessons: (r.course_progress ?? []).length as number,
    tags: r.admin_tags as string[],
    notes: r.notes as number,
  }
}

// ---------- website ----------
const WEB_SQL = `
  select w.*, (select id from patients where phone = w.phone order by created_at limit 1) as patient_id,
         (select id from physios where phone = w.phone) as physio_id,
         coalesce(t.tags, '{}') as admin_tags,
         (select count(*)::int from admin_notes where subject_type = 'lead' and subject_id = w.id) as notes
  from web_submissions w
  left join admin_tags t on t.subject_type = 'lead' and t.subject_id = w.id`

const webSubmission = (r: Row) => ({
  id: r.id as string,
  kind: r.kind as 'form' | 'assessment',
  form: r.form as string,
  page: r.page ?? undefined,
  name: r.name ?? undefined,
  phone: r.phone ?? undefined,
  email: r.email ?? undefined,
  data: r.data ?? {},
  createdAt: iso(r.created_at)!,
  // Set when the same phone number later (or earlier) made an app account.
  patientId: r.patient_id ?? undefined,
  physioId: r.physio_id ?? undefined,
  tags: r.admin_tags as string[],
  notes: r.notes as number,
})

const step = (label: string, n: number, hint?: string) => ({ label, n, hint })

const DAYS = 180
const IST = "at time zone 'Asia/Kolkata'"
const METRICS = ['consumers', 'physios', 'assessments', 'web', 'bookings', 'plans', 'sessions', 'skipped', 'revenue'] as const
type Metric = (typeof METRICS)[number]

/** One row per day for the last 180 days (India time), oldest first, with a count for each metric. */
async function dailySeries() {
  const since = `(now() ${IST})::date - ${DAYS - 1}`
  const ts = (table: string, col: string, where = 'true', value = 'count(*)') =>
    q<{ day: string; n: number }>(`select to_char((${col} ${IST})::date, 'YYYY-MM-DD') as day, ${value}::int as n from ${table} where ${where} and (${col} ${IST})::date >= ${since} group by 1`)
  const sl = (status: string) => q<{ day: string; n: number }>(`select date as day, count(*)::int as n from session_logs where status = '${status}' and date >= ${since} group by 1`)
  const parts: Record<Metric, { day: string; n: number }[]> = Object.fromEntries(
    await Promise.all(
      (
        [
          ['consumers', ts('patients', 'created_at')],
          ['physios', ts('physios', 'created_at')],
          ['assessments', ts('assessments', 'created_at')],
          ['web', ts('web_submissions', 'created_at')],
          ['bookings', ts('bookings', 'created_at')],
          ['plans', ts('plans', 'sent_at')],
          ['sessions', sl('done')],
          ['skipped', sl('skipped')],
          ['revenue', ts('invoices', 'paid_at', "status = 'paid' and paid_at is not null", 'coalesce(sum(total), 0)')],
        ] as [Metric, Promise<{ day: string; n: number }[]>][]
      ).map(async ([k, v]) => [k, await v]),
    ),
  )
  const today = (await one<{ d: string }>(`select to_char((now() ${IST})::date, 'YYYY-MM-DD') as d`))!.d
  const [y, m, d] = today.split('-').map(Number)
  const days = Array.from({ length: DAYS }, (_, i) => new Date(Date.UTC(y, m - 1, d - (DAYS - 1 - i))).toISOString().slice(0, 10))
  const idx = new Map(days.map((x, i) => [x, i]))
  const out = days.map((day) => ({ day, ...(Object.fromEntries(METRICS.map((k) => [k, 0])) as Record<Metric, number>) }))
  for (const k of METRICS) for (const r of parts[k]) if (idx.has(String(r.day))) out[idx.get(String(r.day))!][k] = r.n
  return out
}

/**
 * Retention by the week a consumer got their first care plan: how many of them did at least one session
 * in week 0, 1, 2... counted from their own plan date. Last 12 weekly cohorts, oldest first.
 */
async function planCohorts() {
  const fp = `select patient_id, min((sent_at ${IST})::date) as d0 from plans group by 1`
  const [sizes, kept] = await Promise.all([
    q<{ cohort: string; size: number }>(`select to_char(date_trunc('week', d0::timestamp), 'YYYY-MM-DD') as cohort, count(*)::int as size from (${fp}) fp where d0 >= (now() ${IST})::date - 83 group by 1 order by 1`),
    q<{ cohort: string; wk: number; n: number }>(
      `select to_char(date_trunc('week', fp.d0::timestamp), 'YYYY-MM-DD') as cohort, ((sl.date - fp.d0) / 7)::int as wk, count(distinct fp.patient_id)::int as n
       from (${fp}) fp join plans x on x.patient_id = fp.patient_id join session_logs sl on sl.plan_id = x.id and sl.status = 'done' and sl.date >= fp.d0
       where fp.d0 >= (now() ${IST})::date - 83 group by 1, 2`,
    ),
  ])
  return sizes.map((c) => {
    const weeks: number[] = []
    for (const k of kept) if (k.cohort === c.cohort && k.wk >= 0 && k.wk < 8) weeks[k.wk] = k.n
    return { cohort: c.cohort, size: c.size, weeks: Array.from({ length: 8 }, (_, i) => weeks[i] ?? 0) }
  })
}

export async function adminJourneyRoutes(app: FastifyInstance) {
  app.get('/admin/journeys', async (req) => {
    requireRole(req, 'admin')
    const [daily, cohorts, sessionDays, bookingRows, assessmentRows] = await Promise.all([
      dailySeries(),
      planCohorts(),
      // Who exercised on which day (for "consumers exercising" in any period).
      q<{ day: string; patient_id: string; physio_id: string }>(`select distinct sl.date as day, x.patient_id, x.physio_id from session_logs sl join plans x on x.id = sl.plan_id where sl.status = 'done' and sl.date >= (now() ${IST})::date - ${DAYS - 1}`),
      q(`select to_char((created_at ${IST})::date, 'YYYY-MM-DD') as day, visit_type, source, status from bookings where (created_at ${IST})::date >= (now() ${IST})::date - ${DAYS - 1}`),
      q(`select to_char((created_at ${IST})::date, 'YYYY-MM-DD') as day, kind, area from assessments where (created_at ${IST})::date >= (now() ${IST})::date - ${DAYS - 1}`),
    ])
    const [cRows, pRows, wRows, web, weeks] = await Promise.all([
      q(`${CONSUMER_SQL} order by p.created_at desc limit 5000`),
      q(`${PHYSIO_SQL} order by ph.created_at desc limit 5000`),
      q(`${WEB_SQL} order by w.created_at desc limit 1000`),
      one<{ total: number; forms: number; assessments: number; with_phone: number; converted: number }>(
        `select count(*)::int total, count(*) filter (where kind = 'form')::int forms, count(*) filter (where kind = 'assessment')::int assessments,
                count(distinct phone)::int with_phone,
                (select count(distinct w.phone)::int from web_submissions w where exists (select 1 from patients p where p.phone = w.phone) or exists (select 1 from physios ph where ph.phone = w.phone)) converted
         from web_submissions`,
      ),
      // Monday-start weeks in India time, oldest first.
      q(
        `with w as (select generate_series(date_trunc('week', now() at time zone 'Asia/Kolkata') - interval '11 weeks', date_trunc('week', now() at time zone 'Asia/Kolkata'), interval '1 week') as wk)
         select to_char(wk, 'YYYY-MM-DD') as week,
           (select count(*)::int from patients where date_trunc('week', created_at at time zone 'Asia/Kolkata') = wk) as consumers,
           (select count(*)::int from physios where date_trunc('week', created_at at time zone 'Asia/Kolkata') = wk) as physios,
           (select count(*)::int from assessments where date_trunc('week', created_at at time zone 'Asia/Kolkata') = wk) as assessments,
           (select count(*)::int from web_submissions where date_trunc('week', created_at at time zone 'Asia/Kolkata') = wk) as web,
           (select count(*)::int from bookings where date_trunc('week', created_at at time zone 'Asia/Kolkata') = wk) as bookings,
           (select count(*)::int from plans where date_trunc('week', sent_at at time zone 'Asia/Kolkata') = wk) as plans,
           (select count(*)::int from session_logs where status = 'done' and date_trunc('week', date::timestamp) = wk) as sessions
         from w order by wk`,
      ),
    ])
    const consumers = cRows.map(consumer)
    const physios = pRows.map(physio)
    const c = (f: (x: (typeof consumers)[number]) => unknown) => consumers.filter(f).length
    const p = (f: (x: (typeof physios)[number]) => unknown) => physios.filter(f).length
    return {
      generatedAt: new Date().toISOString(),
      consumers,
      physios,
      web: { ...web, recent: wRows.map(webSubmission) },
      weeks,
      daily,
      cohorts,
      sessionDays: sessionDays.map((r) => [String(r.day), r.patient_id, r.physio_id] as const),
      bookingEvents: bookingRows.map((r) => ({ day: r.day as string, type: r.visit_type as string, source: r.source as string, status: r.status as string })),
      assessmentEvents: assessmentRows.map((r) => ({ day: r.day as string, kind: r.kind as string, area: r.area as string })),
      // Milestones, not a strict funnel: each bar counts everyone who has done that thing.
      consumerSteps: [
        step('Accounts', consumers.length),
        step('Took an assessment', c((x) => x.assessments > 0), 'Saved to their account in the app'),
        step('Has a physio', c((x) => x.physioId)),
        step('Booked a visit', c((x) => x.bookings > 0)),
        step('Got a care plan', c((x) => x.plans > 0)),
        step('Opened the plan', c((x) => x.planOpenedAt)),
        step('Logged a session', c((x) => x.sessionsDone > 0)),
        step('Discharged', c((x) => x.dischargedAt)),
      ],
      physioSteps: [
        step('Accounts', physios.length),
        step('Profile set up', p((x) => x.setupDone >= 4), 'At least 4 of 6: photo, qualification, focus areas, place, availability, billing'),
        step('Listed on betterhood.in', p((x) => x.listing?.status === 'live')),
        step('Verified', p((x) => x.verification === 'verified')),
        step('Added a patient', p((x) => x.patients > 0)),
        step('Sent a care plan', p((x) => x.plans > 0)),
        step('Took a booking', p((x) => x.bookings > 0)),
        step('Raised an invoice', p((x) => x.invoices > 0)),
        step('Referred a physio', p((x) => x.referrals > 0)),
      ],
      health: {
        consumers: { active: c((x) => x.health === 'active'), slipping: c((x) => x.health === 'slipping'), inactive: c((x) => x.health === 'inactive'), discharged: c((x) => x.health === 'discharged') },
        physios: { active: p((x) => x.health === 'active'), slipping: p((x) => x.health === 'slipping'), inactive: p((x) => x.health === 'inactive') },
      },
    }
  })

  // Everything that happened for one consumer, physio or website lead, newest first, plus the admins' notes.
  app.get('/admin/timeline/:type/:id', async (req) => {
    requireRole(req, 'admin')
    const { type, id } = z.object({ type: subjectType, id: z.string().max(40) }).parse(req.params)
    const events: { at: string; kind: string; title: string; detail?: string }[] = []
    const add = (at: string | undefined, kind: string, title: string, detail?: string | null) => at && events.push({ at, kind, title, detail: detail || undefined })
    let phone: string | undefined

    if (type === 'patient') {
      const p = await one('select p.*, ph.name as physio_name from patients p left join physios ph on ph.id = p.physio_id where p.id = $1', [id])
      if (!p) throw notFound('Consumer not found')
      phone = p.phone
      add(iso(p.created_at), 'account', p.self_signup ? 'Signed up in the app' : `Added by ${p.physio_name ?? 'their physio'}`, p.city)
      add(iso(p.consent_at), 'account', 'Agreed to the terms')
      add(iso(p.discharged_at), 'discharge', 'Discharged', [p.discharge?.outcome?.replace(/_/g, ' '), p.discharge?.note].filter(Boolean).join(' · '))
      const [as, bk, pl, sl, ms, inv, cs] = await Promise.all([
        q('select * from assessments where patient_id = $1', [id]),
        q('select * from bookings where patient_id = $1 or (patient_id is null and patient_phone = $2 and physio_id = $3)', [id, p.phone, p.physio_id]),
        q('select * from plans where patient_id = $1', [id]),
        q('select sl.*, x.title from session_logs sl join plans x on x.id = sl.plan_id where x.patient_id = $1', [id]),
        // Message text stays between the patient and the physio: only that a message was sent.
        q("select sender, (at at time zone 'Asia/Kolkata')::date as day, count(*)::int n, max(at) last_at from messages where patient_id = $1 group by 1, 2", [id]),
        q("select * from invoices where patient_id = $1 and status <> 'void'", [id]),
        q('select * from consents where patient_id = $1', [id]),
      ])
      for (const a of as) add(iso(a.created_at), 'assessment', `Took ${a.title}`, a.condition ?? (a.scores?.overall != null ? `Overall ${a.scores.overall}/10` : undefined))
      for (const b of bk) add(iso(b.created_at), 'booking', `${b.source === 'public_profile' ? 'Requested' : 'Booked'} a ${String(b.visit_type).replace(/_/g, ' ')} visit for ${b.date} ${b.time}`, `Now: ${String(b.status).replace(/_/g, ' ')}`)
      for (const x of pl) {
        add(iso(x.sent_at), 'plan', `Care plan sent: ${x.title}`, `${x.days_per_week} days a week for ${x.weeks} weeks · ${x.status}`)
        add(iso(x.opened_at), 'plan', `Opened the plan: ${x.title}`)
      }
      for (const s of sl) add(dayIso(s.date), 'session', s.status === 'done' ? `Did their exercises (${s.title})` : `Skipped a session (${s.title})`, s.pain != null ? `Pain ${s.pain}/10` : undefined)
      for (const m of ms) add(iso(m.last_at), 'message', m.sender === 'patient' ? `Sent ${m.n} message${m.n > 1 ? 's' : ''} to the physio` : `Got ${m.n} message${m.n > 1 ? 's' : ''} from the physio`)
      for (const i of inv) {
        add(iso(i.created_at), 'invoice', `Invoice ${i.number} for ₹${i.total}`, i.status)
        add(iso(i.paid_at), 'invoice', `Paid invoice ${i.number} (₹${i.total})`, i.method)
      }
      for (const x of cs) {
        add(iso(x.requested_at), 'consent', `Consent requested: ${x.title}`)
        add(iso(x.signed_at), 'consent', `Consent ${x.status}: ${x.title}`)
      }
    } else if (type === 'physio') {
      const ph = await one('select id, name, phone, created_at, referred_by from physios where id = $1', [id])
      if (!ph) throw notFound('Physio not found')
      phone = ph.phone
      add(iso(ph.created_at), 'account', ph.referred_by ? 'Signed up (invited by another physio)' : 'Signed up')
      const [dp, pts, pl, bk, inv, gr, rf] = await Promise.all([
        one('select * from directory_profiles where physio_id = $1', [id]),
        q('select name, created_at, discharged_at, self_signup from patients where physio_id = $1', [id]),
        q('select p.sent_at, p.title, pt.name from plans p join patients pt on pt.id = p.patient_id where p.physio_id = $1', [id]),
        q('select * from bookings where physio_id = $1', [id]),
        q("select * from invoices where physio_id = $1 and status <> 'void'", [id]),
        q('select * from group_sessions where physio_id = $1', [id]),
        q('select * from referrals where referrer_id = $1', [id]),
      ])
      add(iso(dp?.published_at), 'listing', 'Published a directory listing on betterhood.in', dp ? siteUrl(dp.slug) : undefined)
      for (const x of pts) {
        add(iso(x.created_at), 'patient', x.self_signup ? `${x.name} joined (assigned by admin)` : `Added patient ${x.name}`)
        add(iso(x.discharged_at), 'discharge', `Discharged ${x.name}`)
      }
      for (const x of pl) add(iso(x.sent_at), 'plan', `Sent a care plan to ${x.name}`, x.title)
      for (const b of bk) add(iso(b.created_at), 'booking', b.source === 'public_profile' ? `Booking request from ${b.patient_name} (public profile)` : `Booked ${b.patient_name}`, `${b.date} ${b.time} · ${String(b.status).replace(/_/g, ' ')}`)
      for (const i of inv) {
        add(iso(i.created_at), 'invoice', `Raised invoice ${i.number} for ₹${i.total}`, i.patient_name)
        add(iso(i.paid_at), 'invoice', `Invoice ${i.number} paid (₹${i.total})`, i.method)
      }
      for (const g of gr) add(iso(g.created_at), 'group', `Set up a group session: ${g.title}`, `${g.date} ${g.time}`)
      for (const r of rf) add(iso(r.at), 'referral', `Referred ${r.name}`, r.status)
    } else {
      const w = await one('select * from web_submissions where id = $1', [id])
      if (!w) throw notFound('Submission not found')
      phone = w.phone ?? undefined
      if (!phone) add(iso(w.created_at), 'web', w.kind === 'assessment' ? `Took ${w.data?.title ?? w.form} on the website` : `Sent the "${w.form}" form on the website`, w.page)
    }

    // What the same phone number did on the website.
    if (phone) {
      for (const w of await q('select * from web_submissions where phone = $1', [phone]))
        add(iso(w.created_at), 'web', w.kind === 'assessment' ? `Took ${w.data?.title ?? w.form} on the website` : `Sent the "${w.form}" form on the website`, w.kind === 'assessment' ? w.data?.condition ?? w.page : w.page)
    }

    const [notes, tags] = await Promise.all([
      q('select * from admin_notes where subject_type = $1 and subject_id = $2 order by created_at desc', [type, id]),
      one<{ tags: string[] }>('select tags from admin_tags where subject_type = $1 and subject_id = $2', [type, id]),
    ])
    return {
      events: events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 400),
      notes: notes.map((n) => ({ id: n.id, text: n.text, author: n.author, createdAt: iso(n.created_at)! })),
      tags: tags?.tags ?? [],
    }
  })

  app.post('/admin/notes', async (req) => {
    const author = requireRole(req, 'admin')
    const b = z.object({ subjectType, subjectId: z.string().max(40), text: z.string().trim().min(1).max(2000) }).parse(req.body)
    if (!(await one(`select 1 from ${SUBJECT_TABLE[b.subjectType]} where id = $1`, [b.subjectId]))) throw notFound('Not found')
    const n = await one('insert into admin_notes (id, subject_type, subject_id, text, author) values ($1,$2,$3,$4,$5) returning *', [newId('an'), b.subjectType, b.subjectId, b.text, author])
    return { id: n!.id, text: n!.text, author: n!.author, createdAt: iso(n!.created_at)! }
  })

  app.delete('/admin/notes/:id', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params)
    if (!(await one('delete from admin_notes where id = $1 returning id', [id]))) throw notFound('Note not found')
    return { ok: true }
  })

  app.put('/admin/tags', async (req) => {
    requireRole(req, 'admin')
    const b = z.object({ subjectType, subjectId: z.string().max(40), tags: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(12) }).parse(req.body)
    if (!(await one(`select 1 from ${SUBJECT_TABLE[b.subjectType]} where id = $1`, [b.subjectId]))) throw notFound('Not found')
    const tags = [...new Set(b.tags)]
    await q(
      `insert into admin_tags (subject_type, subject_id, tags) values ($1,$2,$3)
       on conflict (subject_type, subject_id) do update set tags = excluded.tags, updated_at = now()`,
      [b.subjectType, b.subjectId, tags],
    )
    return { tags }
  })
}
