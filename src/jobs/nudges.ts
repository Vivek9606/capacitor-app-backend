import { one, q } from '../db.js'
import { env } from '../env.js'
import { webUrl } from '../notify.js'
import { sendPush } from '../push.js'
import { HttpError } from '../util.js'
import { sendWhatsApp } from '../whatsapp.js'

/**
 * Engagement nudges for patients, by push (any device they're signed in on) and WhatsApp (only if they opted in to
 * WhatsApp updates). Rules:
 *   - health_score: took a pain assessment 1–7 days ago and no health score for that area since → "check your health score".
 *   - exercise: has an active care plan and logged no session for 2 days → "your exercises are waiting". At most every 3 days.
 * Automatic: never more than one nudge per person in 20 hours, only 10:00–20:00 India time, and each nudge once.
 * Admins can also see who is due and send one now (dashboard): sendNudgeNow, which skips the timing rules.
 */
export type NudgeKind = 'health_score' | 'exercise'
const HEALTH_SLUG: Record<string, string> = {
  back: 'assessment-back-health',
  neck: 'assessment-neck-health-level-2',
  shoulder: 'assessment-shoulder-health-level-2',
  knee: 'assessment-knee-health-level-2',
}
const first = (name: string) => String(name).trim().split(/\s+/)[0] || 'there'
const RECENT = `not exists (select 1 from nudges n where n.subject_type = 'patient' and n.subject_id = p.id and n.sent_at > now() - interval '20 hours')`
const TODAY = `(now() at time zone 'Asia/Kolkata')::date`

function istHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(d))
}

/** One nudge that could be sent: who, what, and the message for each channel. */
interface Candidate {
  kind: NudgeKind
  patientId: string
  name: string
  /** What it's about (an assessment id; a plan id + 3-day period), so the automatic job sends it once. */
  ref: string
  /** One line for the admin: why they're due. */
  reason: string
  since: string
  push: Parameters<typeof sendPush>[1]
  whatsapp: Parameters<typeof sendWhatsApp>[0] | null
}
type Filter = { patientId?: string; manual?: boolean }

async function healthScoreDue(f: Filter): Promise<Candidate[]> {
  // automatic: pain assessment 1–7 days ago. manual (one person): any in the last 60 days.
  const window = f.manual ? `now() - interval '60 days' and now()` : `now() - interval '7 days' and now() - interval '24 hours'`
  const rows = await q<{ ref: string; area: string; at: Date; id: string; name: string; phone: string; whatsapp_opt_in: boolean | null }>(
    `select distinct on (p.id) a.id as ref, a.area, coalesce(a.taken_at, a.created_at) as at, p.id, p.name, p.phone, p.whatsapp_opt_in
       from assessments a join patients p on p.id = a.patient_id
      where a.kind = 'pain' and a.area in ('back', 'neck', 'shoulder', 'knee')
        and coalesce(a.taken_at, a.created_at) between ${window}
        and p.discharged_at is null
        and not exists (select 1 from assessments x where x.patient_id = p.id and x.kind = 'health' and x.area = a.area
                         and coalesce(x.taken_at, x.created_at) >= coalesce(a.taken_at, a.created_at))
        ${f.patientId ? 'and p.id = $1' : ''} ${f.manual ? '' : `and ${RECENT}`}
      order by p.id, coalesce(a.taken_at, a.created_at) desc`,
    f.patientId ? [f.patientId] : [],
  )
  return rows.map((r) => ({
    kind: 'health_score',
    patientId: r.id,
    name: r.name,
    ref: r.ref,
    reason: `Took the ${r.area} pain assessment, no ${r.area} health score yet`,
    since: new Date(r.at).toISOString(),
    push: { title: `Check your ${r.area} health score`, body: `${first(r.name)}, you took the ${r.area} pain assessment. Your health score takes 3 minutes and shows where to start.`, path: `/consumer-dashboard/assess/${HEALTH_SLUG[r.area]}` },
    whatsapp: r.whatsapp_opt_in ? { name: 'health_score_nudge', to: r.phone, patientName: first(r.name), area: r.area, url: `${env.PUBLIC_SITE_URL.replace(/\/$/, '')}/${HEALTH_SLUG[r.area]}/` } : null,
  }))
}

async function exerciseDue(f: Filter, now: Date): Promise<Candidate[]> {
  const period = Math.floor((now.getTime() + 5.5 * 3600e3) / (3 * 864e5)) // a new period every 3 days
  const rows = await q<{ plan_id: string; last: string | null; sent_at: Date; id: string; name: string; phone: string; whatsapp_opt_in: boolean | null; link_token: string; physio_name: string }>(
    `select distinct on (p.id) pl.id as plan_id, pl.sent_at, (select max(s.date)::text from session_logs s where s.plan_id = pl.id) as last,
            p.id, p.name, p.phone, p.whatsapp_opt_in, p.link_token, ph.name as physio_name
       from plans pl join patients p on p.id = pl.patient_id join physios ph on ph.id = pl.physio_id
      where pl.status = 'active' and pl.start_date <= ${TODAY} and pl.start_date + pl.weeks * 7 > ${TODAY}
        and p.discharged_at is null
        ${f.manual ? '' : `and pl.sent_at < now() - interval '1 day'
        and not exists (select 1 from session_logs s where s.plan_id = pl.id and s.date >= ${TODAY} - 2)
        and ${RECENT}`}
        ${f.patientId ? 'and p.id = $1' : ''}
      order by p.id, pl.sent_at desc`,
    f.patientId ? [f.patientId] : [],
  )
  return rows.map((r) => ({
    kind: 'exercise',
    patientId: r.id,
    name: r.name,
    ref: `${r.plan_id}:${period}`,
    reason: r.last ? `Active care plan, last session ${r.last}` : 'Active care plan, no session yet',
    since: r.last ? new Date(`${r.last}T00:00:00+05:30`).toISOString() : new Date(r.sent_at).toISOString(),
    push: { title: 'Your exercises are waiting', body: `${first(r.name)}, a few minutes today keeps your recovery on track. ${r.physio_name} can see how you're doing.`, path: '/consumer-dashboard/session' },
    whatsapp: r.whatsapp_opt_in ? { name: 'exercise_nudge', to: r.phone, patientName: first(r.name), physioName: r.physio_name, url: webUrl(`/plan/${r.link_token}`) } : null,
  }))
}

/** Who the automatic job would nudge next (whatever the hour), and whether anything could reach them. */
export async function dueNudges(now = new Date()) {
  const list = [...(await healthScoreDue({})), ...(await exerciseDue({}, now))]
  const ids = [...new Set(list.map((c) => c.patientId))]
  const push = new Set(
    ids.length ? (await q<{ subject_id: string }>(`select distinct subject_id from push_tokens where subject_type = 'patient' and subject_id = any($1)`, [ids])).map((r) => r.subject_id) : [],
  )
  return list.map((c) => ({ kind: c.kind, patientId: c.patientId, name: c.name, reason: c.reason, since: c.since, push: push.has(c.patientId), whatsapp: !!c.whatsapp }))
}

/** Claim a nudge (insert once), send it, record which channels it went out on. null = already sent before. */
async function deliver(c: Candidate, ref = c.ref, sentBy: string | null = null): Promise<string[] | null> {
  const claimed = await one(
    `insert into nudges (subject_type, subject_id, kind, ref, sent_by) values ('patient', $1, $2, $3, $4) on conflict do nothing returning id`,
    [c.patientId, c.kind, ref, sentBy],
  )
  if (!claimed) return null
  const channels: string[] = []
  if ((await sendPush({ type: 'patient', id: c.patientId }, c.push)) > 0) channels.push('push')
  if (c.whatsapp) {
    try {
      await sendWhatsApp(c.whatsapp)
      if (env.WHATSAPP_PROVIDER !== 'log') channels.push('whatsapp')
    } catch (e) {
      console.error(`[nudges] whatsapp ${c.kind}`, (e as Error).message)
    }
  }
  await q('update nudges set channels = $2 where id = $1', [claimed.id, channels])
  return channels
}

export async function runNudges(now = new Date(), opts: { anyHour?: boolean } = {}) {
  if (!env.NUDGES_ENABLED) return { sent: 0 }
  const h = istHour(now)
  if (!opts.anyHour && (h < 10 || h >= 20)) return { sent: 0 }
  let sent = 0
  const done = new Set<string>() // one per person per run
  for (const c of [...(await healthScoreDue({})), ...(await exerciseDue({}, now))]) {
    if (done.has(c.patientId)) continue
    const r = await deliver(c).catch((e) => (console.error(`[nudges] ${c.kind}`, e.message), null))
    if (r) { sent++; done.add(c.patientId) }
  }
  if (sent) console.log(`[nudges] sent ${sent}`)
  return { sent }
}

/** An admin sends one nudge to one patient now (no timing rules). Returns the channels it actually went out on. */
export async function sendNudgeNow(patientId: string, kind: NudgeKind, adminPhone: string) {
  const list = kind === 'health_score' ? await healthScoreDue({ patientId, manual: true }) : await exerciseDue({ patientId, manual: true }, new Date())
  const c = list[0]
  if (!c)
    throw new HttpError(
      409,
      kind === 'health_score' ? 'Nothing to nudge: no pain assessment in the last 60 days without a health score after it.' : 'Nothing to nudge: no active care plan.',
      'not_applicable',
    )
  const channels = (await deliver(c, `manual:${Date.now()}`, adminPhone)) ?? []
  return { kind, channels, pushDevices: channels.includes('push'), whatsappOptIn: !!c.whatsapp }
}

export function startNudgeJob(everyMs = 15 * 60_000) {
  const tick = () => runNudges().catch((e) => console.error('[nudges] failed', e.message))
  setTimeout(tick, 60_000)
  return setInterval(tick, everyMs)
}
