import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../auth.js'
import { one, q } from '../db.js'
import { PHYSIO_SQL, physio as physioRow } from './adminJourneys.js'

/**
 * The admin dashboard's single source of truth. Every number on every admin screen is computed from what this
 * returns, so two screens can never disagree:
 *
 * - A person is one phone number: an account, website submissions, or both. Website-only people (gave their details
 *   but never verified their number) are included, once each, however many times they submitted.
 * - Everyone moves through the same eight steps. Each step carries the date it was first reached (or null).
 * - Activity (assessments, exercise sessions, bookings, payments) comes as dated events tied to a person, so any
 *   period can be counted without another request.
 * - Phone numbers on the test list are flagged, never removed: the dashboard hides them by default.
 */

type Row = Record<string, any>
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : null)
/** A DATE ('YYYY-MM-DD') as midday India time. */
const dayIso = (d: unknown): string | null => (d ? new Date(`${typeof d === 'string' ? d.slice(0, 10) : (d as Date).toISOString().slice(0, 10)}T12:00:00+05:30`).toISOString() : null)
const min = (...v: (string | null | undefined)[]) => v.filter((x): x is string => !!x).sort()[0] ?? null
const max = (...v: (string | null | undefined)[]) => v.filter((x): x is string => !!x).sort().pop() ?? null
const DAY = 86_400_000

export const STEPS = ['details', 'assessed', 'account', 'matched', 'booked', 'plan', 'exercised', 'improved'] as const
type Step = (typeof STEPS)[number]

const PATIENT_SQL = `
  select p.id, p.name, p.phone, p.email, p.city, p.self_signup, p.signup_via, p.whatsapp_opt_in, p.created_at, p.last_seen_at, p.consent_at, p.discharged_at,
         p.physio_id, p.matched_at, p.match_status, ph.name as physio_name,
         a.first_at as first_assessment_at, a.n as assessments,
         la.title as la_title, la.condition as la_condition, la.scores as la_scores, la.area as la_area, la.kind as la_kind,
         la.advisory as la_advisory, la.advisory_reasons as la_reasons, la.pain_score as la_pain, la.source as la_source, la.at as la_at,
         b.n as bookings, b.first_at as first_booking_at, b.last_at as last_booking_at,
         pl.n as plans, pl.first_at as first_plan_at,
         s.done as sessions_done, s.first_date as first_session_date, s.last_date as last_session_date, s.first_pain, s.last_pain, s.improved_date,
         m.last_at as last_message_at, i.paid as paid_total,
         (select min(at) from consents_log where subject_type = 'patient' and subject_id = p.id and channel = 'web') as web_consent_at,
         coalesce(t.tags, '{}') as tags, n.n as notes
  from patients p
  left join physios ph on ph.id = p.physio_id
  left join lateral (select count(*)::int n, min(coalesce(taken_at, created_at)) first_at from assessments where patient_id = p.id) a on true
  left join lateral (select title, condition, scores, area, kind, advisory, advisory_reasons, pain_score, source, coalesce(taken_at, created_at) at
                     from assessments where patient_id = p.id order by coalesce(taken_at, created_at) desc limit 1) la on true
  left join lateral (select count(*)::int n, min(created_at) first_at, max(created_at) last_at from bookings
                     where patient_id = p.id or (patient_id is null and patient_phone = p.phone and physio_id = p.physio_id)) b on true
  left join lateral (select count(*)::int n, min(sent_at) first_at from plans where patient_id = p.id and sent_at is not null) pl on true
  left join lateral (
    select count(*)::int done, min(sl.date) first_date, max(sl.date) last_date,
           (array_agg(sl.pain order by sl.date) filter (where sl.pain is not null))[1] first_pain,
           (array_agg(sl.pain order by sl.date desc) filter (where sl.pain is not null))[1] last_pain,
           -- first day their pain was at least 2 points below where it started
           (select min(z.date) from session_logs z join plans y on y.id = z.plan_id
             where y.patient_id = p.id and z.status = 'done' and z.pain is not null
               and z.pain <= (select z2.pain from session_logs z2 join plans y2 on y2.id = z2.plan_id
                              where y2.patient_id = p.id and z2.status = 'done' and z2.pain is not null order by z2.date limit 1) - 2) improved_date
    from session_logs sl join plans x on x.id = sl.plan_id where x.patient_id = p.id and sl.status = 'done') s on true
  left join lateral (select max(at) last_at from messages where patient_id = p.id and sender = 'patient') m on true
  left join lateral (select coalesce(sum(total), 0)::int paid from invoices where patient_id = p.id and status = 'paid') i on true
  left join admin_tags t on t.subject_type = 'patient' and t.subject_id = p.id
  left join lateral (select count(*)::int n from admin_notes where subject_type = 'patient' and subject_id = p.id) n on true`

export async function adminDashboardRoutes(app: FastifyInstance) {
  app.get('/admin/dashboard', async (req) => {
    requireRole(req, 'admin')
    const [patients, web, assessments, sessions, payments, bookings, physios, tests, leadTags, nudgeRows, pushRows, slouchChecks, slouchCatches, slouchCoupons, slouchPoints] = await Promise.all([
      q(`${PATIENT_SQL} order by p.created_at`),
      q(
        `select id, kind, form, name, phone, email, created_at, claimed_by, disowned, result_id,
                data->>'title' as title, data->>'condition' as condition, data->>'area' as area, data->>'city' as city,
                (data->>'advisory')::text = 'true' as advisory, data->'scores'->>'overall' as overall, data->>'overall' as overall2
         from web_submissions order by created_at limit 20000`,
      ),
      q(`select id, patient_id, source, kind, area, coalesce(taken_at, created_at) as at, advisory is not null or coalesce(array_length(advisory_reasons, 1), 0) > 0 as red_flag from assessments`),
      q(`select distinct sl.date as day, x.patient_id, x.physio_id from session_logs sl join plans x on x.id = sl.plan_id where sl.status = 'done'`),
      q(`select paid_at, patient_id, physio_id, total from invoices where status = 'paid' and paid_at is not null`),
      q(`select b.created_at, b.physio_id, b.visit_type, b.status, b.date, b.time, b.physio_joined_at, b.patient_joined_at, coalesce(b.patient_id, (select p.id from patients p where p.phone = b.patient_phone limit 1)) as patient_id from bookings b`),
      q(`${PHYSIO_SQL} order by ph.created_at`),
      q<{ phone: string }>('select phone from test_contacts'),
      q(`select subject_id, tags from admin_tags where subject_type = 'lead'`),
      q(`select sent_at, subject_id, kind, channels, sent_by from nudges where subject_type = 'patient'`),
      q<{ subject_id: string }>(`select distinct subject_id from push_tokens where subject_type = 'patient'`),
      // Slouch Catcher (betterhood.in/slouch-catcher/): photos checked (no one attached), catches shared, joins, coupons.
      q(`select created_at, test from slouch_analyses where created_at > now() - interval '400 days'`),
      q(`select code, catcher_phone, catcher_name, target_name, target_phone, persona, score, created_at, joined_at from slouch_catches`),
      q(`select phone, value_inr, source, created_at from slouch_coupons`),
      q(`select phone, coalesce(sum(delta), 0)::int as points from slouch_points group by phone`),
    ])
    const testPhones = new Set(tests.map((t) => t.phone))
    const pushIds = new Set(pushRows.map((r) => r.subject_id))
    const physioPhones = new Set(physios.map((p) => p.phone))
    const byPhone = new Map(patients.map((p) => [p.phone as string, p]))

    // Website submissions, per phone. Disowned ones ("not mine") don't belong to anyone.
    const webByPhone = new Map<string, Row[]>()
    for (const w of web) {
      if (!w.phone || w.disowned) continue
      const k = w.claimed_by ? (patients.find((p) => p.id === w.claimed_by)?.phone ?? w.phone) : w.phone
      if (!webByPhone.has(k)) webByPhone.set(k, [])
      webByPhone.get(k)!.push(w)
    }
    const assessmentIds = new Set(assessments.map((a) => a.id))
    // Slouch Catcher per phone: points, catches shared, the catch they joined from, coupons.
    const slouchPointsBy = new Map(slouchPoints.map((r) => [r.phone as string, r.points as number]))
    const slouchOf = (phone: string) => {
      const shared = slouchCatches.filter((c) => c.catcher_phone === phone)
      const joinedFrom = slouchCatches.find((c) => c.target_phone === phone)
      const coupons = slouchCoupons.filter((c) => c.phone === phone)
      if (!shared.length && !joinedFrom && !coupons.length && !slouchPointsBy.has(phone)) return undefined
      return {
        points: slouchPointsBy.get(phone) ?? 0,
        catches: shared.length,
        joins: shared.filter((c) => c.joined_at).length,
        joinedFrom: joinedFrom ? { catcher: (joinedFrom.catcher_name as string | null) ?? 'A friend', at: iso(joinedFrom.joined_at)! } : undefined,
        coupons: coupons.map((c) => ({ value: c.value_inr as number, at: iso(c.created_at)!, test: c.source === 'test' })),
        recent: shared.slice(-5).reverse().map((c) => ({ target: c.target_name as string, persona: c.persona as string, score: Number(c.score), at: iso(c.created_at)!, joined: !!c.joined_at })),
      }
    }
    const leadTagsBy = new Map(leadTags.map((t) => [t.subject_id, t.tags as string[]]))

    const people = []
    const keyOfPatient = new Map<string, string>()
    for (const p of patients) {
      const subs = webByPhone.get(p.phone) ?? []
      const webAssess = subs.filter((w) => w.kind === 'assessment')
      const firstWeb = min(...subs.map((w) => iso(w.created_at)))
      const created = iso(p.created_at)!
      const firstSessionAt = dayIso(p.first_session_date)
      const lastSessionAt = dayIso(p.last_session_date)
      const steps: Record<Step, string | null> = {
        details: min(firstWeb, created, iso(p.first_assessment_at)),
        assessed: min(iso(p.first_assessment_at), ...webAssess.map((w) => iso(w.created_at))),
        account: created,
        matched: p.physio_id ? (iso(p.matched_at) ?? created) : null,
        booked: iso(p.first_booking_at),
        plan: iso(p.first_plan_at),
        exercised: firstSessionAt,
        improved: min(iso(p.discharged_at), dayIso(p.improved_date)),
      }
      const lastActiveAt = max(iso(p.last_seen_at), lastSessionAt, iso(p.last_booking_at), iso(p.last_message_at), iso(p.la_at), firstWeb, ...subs.map((w) => iso(w.created_at)), created)!
      const source = !p.self_signup ? 'physio' : (firstWeb && firstWeb < created) || p.web_consent_at || p.signup_via ? 'website' : 'app'
      const reasons: string[] = p.la_reasons ?? []
      keyOfPatient.set(p.id, p.id)
      people.push({
        key: p.id as string,
        kind: 'account' as const,
        patientId: p.id as string,
        name: p.name as string,
        phone: p.phone as string,
        email: p.email ?? subs.find((w) => w.email)?.email ?? undefined,
        city: p.city ?? subs.find((w) => w.city)?.city ?? undefined,
        test: testPhones.has(p.phone),
        alsoPhysio: physioPhones.has(p.phone),
        source,
        pushEnabled: pushIds.has(p.id),
        whatsappOptIn: p.whatsapp_opt_in ?? undefined,
        // e.g. 'assessment:assessment-lower-back-pain': the account was made by finishing that assessment
        signupVia: (p.signup_via as string | null) ?? undefined,
        slouch: slouchOf(p.phone),
        steps,
        lastActiveAt,
        lastSessionAt,
        dischargedAt: iso(p.discharged_at),
        physioId: p.physio_id ?? undefined,
        physioName: p.physio_name ?? undefined,
        matchStatus: p.match_status ?? undefined,
        consent: !!p.consent_at,
        latest: p.la_title
          ? {
              title: p.la_title as string,
              result: (p.la_condition as string | null) ?? (p.la_scores?.overall != null ? `${p.la_scores.overall}/10` : null),
              area: p.la_area as string,
              painScore: p.la_pain as number | null,
              redFlag: !!p.la_advisory || reasons.length > 0,
              reasons,
              at: iso(p.la_at),
              source: p.la_source as string,
            }
          : webAssess.length
            ? webLatest(webAssess)
            : undefined,
        counts: {
          assessments: (p.assessments as number) + webAssess.filter((w) => !w.claimed_by && !(w.result_id && assessmentIds.has(w.result_id))).length,
          websiteSubmissions: subs.length,
          unverifiedSubmissions: subs.filter((w) => w.claimed_by !== p.id).length,
          bookings: p.bookings as number,
          plans: p.plans as number,
          sessions: p.sessions_done as number,
        },
        pain: p.first_pain != null ? { first: p.first_pain as number, last: p.last_pain as number } : undefined,
        paid: p.paid_total as number,
        submissionIds: subs.map((w) => w.id as string),
        tags: p.tags as string[],
        notes: p.notes as number,
      })
    }

    // Website-only: gave a phone on the website, no account with that number.
    for (const [phone, subs] of webByPhone) {
      if (byPhone.has(phone)) continue
      subs.sort((a, b) => +a.created_at - +b.created_at)
      const last = subs[subs.length - 1]
      const webAssess = subs.filter((w) => w.kind === 'assessment')
      const first = iso(subs[0].created_at)!
      const named = [...subs].reverse().find((w) => w.name)
      people.push({
        key: `web:${phone}`,
        kind: 'website' as const,
        patientId: undefined,
        name: (named?.name as string | undefined) ?? 'No name given',
        phone,
        email: [...subs].reverse().find((w) => w.email)?.email ?? undefined,
        city: subs.find((w) => w.city)?.city ?? undefined,
        test: testPhones.has(phone),
        alsoPhysio: physioPhones.has(phone),
        source: 'website' as const,
        steps: {
          details: first,
          assessed: min(...webAssess.map((w) => iso(w.created_at))),
          account: null,
          matched: null,
          booked: null,
          plan: null,
          exercised: null,
          improved: null,
        } as Record<Step, string | null>,
        lastActiveAt: iso(last.created_at)!,
        lastSessionAt: null,
        dischargedAt: null,
        physioId: undefined,
        physioName: undefined,
        matchStatus: undefined,
        consent: false,
        latest: webAssess.length ? webLatest(webAssess) : undefined,
        counts: { assessments: webAssess.length, websiteSubmissions: subs.length, unverifiedSubmissions: subs.length, bookings: 0, plans: 0, sessions: 0 },
        pain: undefined,
        paid: 0,
        submissionIds: subs.map((w) => w.id as string),
        tags: [...new Set(subs.flatMap((w) => leadTagsBy.get(w.id) ?? []))],
        notes: 0,
      })
    }

    // Who each event belongs to (a person key).
    const keyOfPhone = (phone?: string | null) => (phone ? (byPhone.get(phone)?.id ?? (webByPhone.has(phone) ? `web:${phone}` : null)) : null)
    const assessmentEvents = [
      ...assessments.map((a) => ({ at: iso(a.at)!, who: a.patient_id as string, source: (a.source ?? 'app') as string, area: a.area as string, kind: (a.kind ?? 'pain') as string, redFlag: !!a.red_flag })),
      // Website assessments not already saved to an account (claimed or saved signed in).
      ...web
        .filter((w) => w.kind === 'assessment' && !w.disowned && !w.claimed_by && !(w.result_id && assessmentIds.has(w.result_id)))
        .map((w) => ({ at: iso(w.created_at)!, who: keyOfPhone(w.phone), source: 'web', area: (w.area as string) ?? 'unknown', kind: 'pain', redFlag: !!w.advisory })),
    ]

    const now = Date.now()
    const physioList = physios.map((r) => {
      const x = physioRow(r)
      return { ...x, test: testPhones.has(x.phone), daysSinceActive: x.lastActiveAt ? Math.floor((now - new Date(x.lastActiveAt).getTime()) / DAY) : null }
    })

    return {
      generatedAt: new Date().toISOString(),
      steps: STEPS,
      people,
      physios: physioList,
      events: {
        assessments: assessmentEvents,
        // Engagement nudges sent (jobs/nudges.ts). channels empty = nothing could go out (no app device, no WhatsApp opt-in, or providers off).
        nudges: nudgeRows.map((n) => ({ at: iso(n.sent_at)!, who: n.subject_id as string, kind: n.kind as string, channels: (n.channels as string[]) ?? [], manual: !!n.sent_by })),
        sessions: sessions.map((s) => ({ at: dayIso(s.day)!, who: s.patient_id as string, physioId: s.physio_id as string })),
        bookings: bookings.map((b) => ({
          at: iso(b.created_at)!,
          who: (b.patient_id as string | null) ?? null,
          physioId: b.physio_id as string,
          visitType: b.visit_type as string,
          status: b.status as string,
          /** Appointment start, Indian time. */
          when: `${b.date}T${String(b.time).slice(0, 5)}:00+05:30`,
          physioJoinedAt: iso(b.physio_joined_at),
          patientJoinedAt: iso(b.patient_joined_at),
        })),
        payments: payments.map((x) => ({ at: iso(x.paid_at)!, who: x.patient_id as string | null, physioId: x.physio_id as string, amount: Number(x.total) })),
        // Slouch Catcher. who: the person key (null when that phone is only a physio). Checks have no one attached.
        slouch: {
          checks: slouchChecks.map((c) => ({ at: iso(c.created_at)!, test: !!c.test })),
          catches: slouchCatches.map((c) => ({ at: iso(c.created_at)!, who: keyOfPhone(c.catcher_phone) })),
          joins: slouchCatches.filter((c) => c.joined_at).map((c) => ({ at: iso(c.joined_at)!, who: keyOfPhone(c.target_phone), catcher: keyOfPhone(c.catcher_phone) })),
          coupons: slouchCoupons.map((c) => ({ at: iso(c.created_at)!, who: keyOfPhone(c.phone), value: c.value_inr as number, test: c.source === 'test' })),
        },
        // Website submissions without a phone (nobody to attach them to), for the website total only.
        anonymous: web.filter((w) => !w.phone).map((w) => ({ at: iso(w.created_at)!, kind: w.kind as string })),
      },
      testPhones: [...testPhones],
    }
  })

  // A phone's website submissions in full (answers included), for the person's profile. "Not mine" ones are left out.
  app.get('/admin/submissions/:phone', async (req) => {
    requireRole(req, 'admin')
    const p = z.string().regex(/^\d{10}$/).parse((req.params as Row).phone)
    const rows = await q('select * from web_submissions where (phone = $1 or claimed_by = (select id from patients where phone = $1)) and not disowned order by created_at desc limit 200', [p])
    return {
      submissions: rows.map((w) => ({
        id: w.id as string,
        kind: w.kind as 'form' | 'assessment',
        form: w.form as string,
        page: w.page ?? undefined,
        name: w.name ?? undefined,
        email: w.email ?? undefined,
        claimed: !!w.claimed_by,
        resultId: w.result_id ?? undefined,
        data: w.data ?? {},
        createdAt: iso(w.created_at)!,
      })),
    }
  })

  // ---------- test numbers (hide from the numbers; never deletes anything) ----------
  const phone = z.string().regex(/^[6-9]\d{9}$/)
  app.put('/admin/test-contacts/:phone', async (req) => {
    const by = requireRole(req, 'admin')
    const p = phone.parse((req.params as Row).phone)
    const b = z.object({ note: z.string().trim().max(120).optional() }).parse(req.body ?? {})
    await q('insert into test_contacts (phone, note, marked_by) values ($1, $2, $3) on conflict (phone) do update set note = coalesce(excluded.note, test_contacts.note)', [p, b.note ?? null, by])
    return { phone: p, test: true }
  })
  app.delete('/admin/test-contacts/:phone', async (req) => {
    requireRole(req, 'admin')
    const p = phone.parse((req.params as Row).phone)
    await one('delete from test_contacts where phone = $1', [p])
    return { phone: p, test: false }
  })
}

function webLatest(subs: Row[]) {
  const w = [...subs].sort((a, b) => +b.created_at - +a.created_at)[0]
  const overall = w.overall ?? w.overall2
  return {
    title: (w.title as string | null) ?? String(w.form).replace(/^assessment-/, '').replace(/-/g, ' '),
    result: (w.condition as string | null) ?? (overall != null ? `${overall}/10` : null),
    area: (w.area as string | null) ?? 'unknown',
    painScore: null as number | null,
    redFlag: !!w.advisory,
    reasons: [] as string[],
    at: iso(w.created_at),
    source: 'web',
  }
}
