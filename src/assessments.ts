import { z } from 'zod'
import { one, q } from './db.js'
import { physioByRef, suggestPhysio } from './match.js'
import { id } from './schemas.js'
import { HttpError, newId, todayIST } from './util.js'

// One way to save an assessment result, whoever saves it: the app (a result taken in its frame or brought over from
// the website), the website (signed in), or a website result claimed after the person verified their number.
// The result keeps one id from the moment it's taken, so the same result is never saved twice and its website
// submission is linked to the account.

const score = z.number().min(0).max(100).nullable().optional()
const text = (n: number) => z.string().trim().max(n)

/** One question and what the person answered, in readable words (not form field ids). */
export const answer = z.object({ q: text(300).min(1), a: z.union([text(300), z.array(text(300)).max(20)]) })

export const assessmentInput = z.object({
  id: id.optional(),
  slug: z.string().regex(/^assessment-[a-z0-9-]+$/).max(80),
  kind: z.enum(['pain', 'health', 'longevity']).default('pain'),
  area: z.enum(['back', 'neck', 'shoulder', 'knee', 'overall']),
  title: z.string().max(120),
  cat: z.enum(['muscle', 'nerve', 'bone', 'joint']).optional(),
  condition: z.string().max(200).optional(),
  result: z.string().max(120).optional(),
  advisory: z.string().max(2000).optional(),
  totals: z.record(z.string(), z.number()).optional(),
  scores: z.object({ overall: score, strength: score, balance: score, mobility: score }).optional(),
  answers: z.array(answer).max(80).optional(),
  painScore: z.number().int().min(0).max(10).optional(),
  advisoryReasons: z.array(text(300)).max(12).optional(),
  takenAt: z.string().datetime({ offset: true }).optional(),
  formVersion: text(40).optional(),
  // 'web' = taken on betterhood.in (signed in, synced on sign-in, or claimed); the app's own runs are 'app'
  source: z.enum(['app', 'web']).default('app'),
  // Taken from a physio's invite link (betterhood.in/...?physio=<ref>): link the patient to that physio.
  invitedBy: z.string().max(80).optional(),
})
export type AssessmentInput = z.infer<typeof assessmentInput>

type Row = Record<string, any>

/** A taken-at time from the client, kept only if it's believable (not in the future, not years old). */
function takenAt(v?: string) {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) && t <= Date.now() + 5 * 60_000 && t > Date.now() - 400 * 864e5 ? new Date(t).toISOString() : null
}

/**
 * Save a result for patient `p`. Returns the saved row and the patient (their match may have changed), or
 * `existing: true` when a result with this id was already saved (then only missing answers are filled in).
 */
export async function saveAssessment(p: Row, b: AssessmentInput): Promise<{ row: Row; patient: Row; existing: boolean }> {
  const row = await one(
    `insert into assessments (id, patient_id, slug, kind, area, title, cat, condition, result, advisory, totals, scores, source,
                              answers, pain_score, advisory_reasons, taken_at, form_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) on conflict (id) do nothing returning *`,
    [
      b.id ?? newId('as'), p.id, b.slug, b.kind, b.area, b.title, b.cat ?? null, b.condition ?? null, b.result ?? null, b.advisory ?? null,
      JSON.stringify(b.totals ?? {}), b.scores ? JSON.stringify(b.scores) : null, b.source,
      b.answers?.length ? JSON.stringify(b.answers) : null, b.painScore ?? null, b.advisoryReasons ?? [], takenAt(b.takenAt), b.formVersion ?? null,
    ],
  )
  if (!row) {
    // Same result saved before (from the other side). Only its owner may add what was missing, e.g. the answers the
    // app didn't have when it saved a result brought over from the website.
    const filled = await one(
      `update assessments set answers = coalesce(answers, $3), pain_score = coalesce(pain_score, $4),
              advisory_reasons = case when cardinality(advisory_reasons) = 0 then $5 else advisory_reasons end,
              taken_at = coalesce(taken_at, $6), form_version = coalesce(form_version, $7)
        where id = $1 and patient_id = $2 returning *`,
      [b.id, p.id, b.answers?.length ? JSON.stringify(b.answers) : null, b.painScore ?? null, b.advisoryReasons ?? [], takenAt(b.takenAt), b.formVersion ?? null],
    )
    if (!filled) throw new HttpError(409, 'This result was already saved', 'exists')
    await linkSubmission(filled)
    return { row: filled, patient: p, existing: true }
  }
  await linkSubmission(row)

  let patient = p
  const inviter = !p.physio_id && b.invitedBy ? await physioByRef(b.invitedBy) : undefined
  if (inviter && inviter.phone !== p.phone) {
    // The patient chose this physio by following their link, so no admin matching. If the physio already added this
    // number by hand (a separate patient record), suggest instead of creating a second record for them.
    const clash = await one('select 1 from patients where physio_id = $1 and phone = $2 and id <> $3', [inviter.id, p.phone, p.id])
    patient = clash
      ? (await one("update patients set suggested_physio_id = $2, match_status = 'suggested', invited_by = $2, condition = coalesce(condition, $3) where id = $1 returning *", [p.id, inviter.id, b.condition ?? null]))!
      : (await one("update patients set physio_id = $2, suggested_physio_id = $2, match_status = 'confirmed', invited_by = $2, since = coalesce(since, $3), condition = coalesce(condition, $4) where id = $1 returning *", [p.id, inviter.id, todayIST(), b.condition ?? null]))!
  } else if (b.kind === 'pain' && !p.physio_id && p.match_status !== 'confirmed') {
    const sug = await suggestPhysio(b.cat, p.city ?? undefined)
    patient = (await one("update patients set suggested_physio_id = $2, match_status = $3, condition = coalesce(condition, $4) where id = $1 returning *", [p.id, sug ?? null, sug ? 'suggested' : 'pending', b.condition ?? null]))!
  }
  return { row, patient, existing: false }
}

/** The website submission of this same result (same id) now belongs to the patient who saved it. */
async function linkSubmission(a: Row) {
  await q('update web_submissions set claimed_by = $2, claimed_at = now() where result_id = $1 and claimed_by is null', [a.id, a.patient_id])
}

// ---------- website results taken with this number on another device ----------
// A website visitor types their phone into the assessment, unverified. Once someone verifies that number, we show
// them what was taken with it (title and date only) and they confirm it's theirs, or say it isn't. Results from the
// same browser don't need this: the website saves them to the account itself.

const CLAIM_WINDOW = "interval '180 days'"

/** Unclaimed website results taken with this phone: just enough for the person to recognise them. */
export async function claimableResults(phone: string) {
  const rows = await q(
    `select id, form, data, created_at from web_submissions
      where kind = 'assessment' and phone = $1 and claimed_by is null and not disowned and created_at > now() - ${CLAIM_WINDOW}
        and (result_id is null or not exists (select 1 from assessments a where a.id = web_submissions.result_id))
      order by created_at desc limit 20`,
    [phone],
  )
  return rows.map((r) => ({ id: r.id as string, slug: r.form as string, title: String(r.data?.title ?? r.form), takenAt: new Date(r.data?.date ?? r.created_at).toISOString() }))
}

/** A website submission's stored result → the input saveAssessment takes. */
export function submissionToInput(w: Row): AssessmentInput | undefined {
  const d = (w.data ?? {}) as Row
  const kind = d.kind === 'health' || d.kind === 'longevity' ? d.kind : 'pain'
  const r1 = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null)
  const parsed = assessmentInput.safeParse({
    id: w.result_id ?? `as_${String(w.id).replace(/^ws_/, '')}`,
    slug: w.form,
    kind,
    area: d.area,
    title: String(d.title ?? w.form).slice(0, 120),
    ...(kind === 'pain'
      ? {
          cat: d.cat,
          condition: d.condition,
          result: d.result,
          advisory: d.advisory ? 'Critical advisory' : undefined,
          totals: Array.isArray(d.totals) ? Object.fromEntries(d.totals.map((t: Row) => [t.cat, r1(t.score) ?? 0])) : {},
        }
      : { totals: {}, scores: { overall: r1(d.overall), strength: r1(d.strength), balance: r1(d.balance), mobility: r1(d.mobility) } }),
    answers: Array.isArray(d.answers) ? d.answers : undefined,
    painScore: typeof d.painScore === 'number' ? d.painScore : undefined,
    advisoryReasons: Array.isArray(d.advisoryReasons) ? d.advisoryReasons : undefined,
    takenAt: typeof d.date === 'string' ? d.date : undefined,
    formVersion: typeof d.formVersion === 'string' ? d.formVersion : undefined,
    invitedBy: typeof d.invitedBy === 'string' ? d.invitedBy : undefined,
    source: 'web',
  })
  return parsed.success ? parsed.data : undefined
}

/**
 * The verified owner of the number answers for each result: `claim` ids become assessments on their account,
 * `disown` ids are marked "not mine" and never offered again. Only submissions made with their own number count.
 */
export async function resolveClaims(p: Row, claim: string[], disown: string[]) {
  const saved: Row[] = []
  let patient = p
  for (const wid of claim) {
    const w = await one(
      `select * from web_submissions where id = $1 and kind = 'assessment' and phone = $2 and claimed_by is null and not disowned and created_at > now() - ${CLAIM_WINDOW}`,
      [wid, p.phone],
    )
    const input = w && submissionToInput(w)
    if (!w || !input) continue
    try {
      const r = await saveAssessment(patient, input)
      patient = r.patient
      saved.push(r.row)
    } catch (e) {
      if (!(e instanceof HttpError && e.code === 'exists')) throw e
    }
    await q('update web_submissions set claimed_by = $2, claimed_at = now() where id = $1 and claimed_by is null', [wid, p.id])
  }
  if (disown.length) await q('update web_submissions set disowned = true where id = any($1) and phone = $2 and claimed_by is null', [disown, p.phone])
  return { saved, patient }
}
