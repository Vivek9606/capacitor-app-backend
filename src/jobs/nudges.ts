import { one, q } from '../db.js'
import { env } from '../env.js'
import { webUrl } from '../notify.js'
import { sendPush } from '../push.js'
import { sendWhatsApp } from '../whatsapp.js'

/**
 * Engagement nudges for patients, by push (any device they're signed in on) and WhatsApp (only if they opted in to
 * WhatsApp updates). Rules:
 *   - health_score: took a pain assessment 1–7 days ago and no health score for that area since → "check your health score".
 *   - exercise: has an active care plan and logged no session for 2 days → "your exercises are waiting". At most every 3 days.
 * Never more than one nudge per person in 20 hours, only 10:00–20:00 India time, and each nudge once (the nudges table).
 */
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

/** Claim a nudge (insert once), send it, record which channels it went out on. false = already sent before. */
async function deliver(patientId: string, kind: string, ref: string, push: Parameters<typeof sendPush>[1], wa: Parameters<typeof sendWhatsApp>[0] | null) {
  const claimed = await one(
    `insert into nudges (subject_type, subject_id, kind, ref) values ('patient', $1, $2, $3) on conflict do nothing returning id`,
    [patientId, kind, ref],
  )
  if (!claimed) return false
  const channels: string[] = []
  if ((await sendPush({ type: 'patient', id: patientId }, push)) > 0) channels.push('push')
  if (wa) {
    try {
      await sendWhatsApp(wa)
      if (env.WHATSAPP_PROVIDER !== 'log') channels.push('whatsapp')
    } catch (e) {
      console.error(`[nudges] whatsapp ${kind}`, (e as Error).message)
    }
  }
  await q('update nudges set channels = $2 where id = $1', [claimed.id, channels])
  return true
}

export async function runNudges(now = new Date(), opts: { anyHour?: boolean } = {}) {
  if (!env.NUDGES_ENABLED) return { sent: 0 }
  const h = istHour(now)
  if (!opts.anyHour && (h < 10 || h >= 20)) return { sent: 0 }
  let sent = 0

  const health = await q<{ ref: string; area: string; id: string; name: string; phone: string; whatsapp_opt_in: boolean | null }>(
    `select distinct on (p.id) a.id as ref, a.area, p.id, p.name, p.phone, p.whatsapp_opt_in
       from assessments a join patients p on p.id = a.patient_id
      where a.kind = 'pain' and a.area in ('back', 'neck', 'shoulder', 'knee')
        and coalesce(a.taken_at, a.created_at) between now() - interval '7 days' and now() - interval '24 hours'
        and p.discharged_at is null
        and not exists (select 1 from assessments x where x.patient_id = p.id and x.kind = 'health' and x.area = a.area
                         and coalesce(x.taken_at, x.created_at) >= coalesce(a.taken_at, a.created_at))
        and ${RECENT}
      order by p.id, coalesce(a.taken_at, a.created_at) desc`,
  )
  for (const r of health) {
    const area = r.area
    const url = `${env.PUBLIC_SITE_URL.replace(/\/$/, '')}/${HEALTH_SLUG[area]}/`
    const ok = await deliver(
      r.id, 'health_score', r.ref,
      { title: `Check your ${area} health score`, body: `${first(r.name)}, you took the ${area} pain assessment. Your health score takes 3 minutes and shows where to start.`, path: `/consumer-dashboard/assess/${HEALTH_SLUG[area]}` },
      r.whatsapp_opt_in ? { name: 'health_score_nudge', to: r.phone, patientName: first(r.name), area, url } : null,
    ).catch((e) => (console.error('[nudges] health_score', e.message), false))
    if (ok) sent++
  }

  const period = Math.floor((now.getTime() + 5.5 * 3600e3) / (3 * 864e5)) // a new period every 3 days
  const exercise = await q<{ plan_id: string; id: string; name: string; phone: string; whatsapp_opt_in: boolean | null; link_token: string; physio_name: string }>(
    `select distinct on (p.id) pl.id as plan_id, p.id, p.name, p.phone, p.whatsapp_opt_in, p.link_token, ph.name as physio_name
       from plans pl join patients p on p.id = pl.patient_id join physios ph on ph.id = pl.physio_id
      where pl.status = 'active' and pl.sent_at < now() - interval '1 day'
        and pl.start_date <= ${TODAY} and pl.start_date + pl.weeks * 7 > ${TODAY}
        and p.discharged_at is null
        and not exists (select 1 from session_logs s where s.plan_id = pl.id and s.date >= ${TODAY} - 2)
        and ${RECENT}
      order by p.id, pl.sent_at desc`,
  )
  for (const r of exercise) {
    const ok = await deliver(
      r.id, 'exercise', `${r.plan_id}:${period}`,
      { title: 'Your exercises are waiting', body: `${first(r.name)}, a few minutes today keeps your recovery on track. ${r.physio_name} can see how you're doing.`, path: '/consumer-dashboard/session' },
      r.whatsapp_opt_in ? { name: 'exercise_nudge', to: r.phone, patientName: first(r.name), physioName: r.physio_name, url: webUrl(`/plan/${r.link_token}`) } : null,
    ).catch((e) => (console.error('[nudges] exercise', e.message), false))
    if (ok) sent++
  }

  if (sent) console.log(`[nudges] sent ${sent}`)
  return { sent }
}

export function startNudgeJob(everyMs = 15 * 60_000) {
  const tick = () => runNudges().catch((e) => console.error('[nudges] failed', e.message))
  setTimeout(tick, 60_000)
  return setInterval(tick, everyMs)
}
