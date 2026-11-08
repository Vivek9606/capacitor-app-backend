// DB rows (snake_case) → API objects (camelCase), matching the web app's types.ts exactly.

type Row = Record<string, any>
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v as string | undefined) ?? undefined)
const opt = <T>(v: T | null | undefined) => (v === null ? undefined : v)

export const physio = (r: Row) => ({
  id: r.id,
  phone: r.phone,
  name: r.name,
  email: opt(r.email),
  qualification: opt(r.qualification),
  experienceYrs: opt(r.experience_yrs),
  councilRegNo: opt(r.council_reg_no),
  verification: r.verification,
  photo: opt(r.photo),
  focusAreas: r.focus_areas,
  practiceSettings: r.practice_settings,
  slug: r.slug,
  clinic: opt(r.clinic),
  consult: r.consult,
  workingDays: r.working_days,
  hours: opt(r.hours),
  inviteCode: r.invite_code,
  partnerOptIns: r.partner_opt_ins,
  communityWaitlist: r.community_waitlist,
  communityTopics: r.community_topics,
  createdAt: iso(r.created_at),
})

/** What a patient may see about their physio, and what the public profile shows. */
export const physioPublic = (r: Row) => {
  const p = physio(r)
  return {
    ...p,
    email: undefined,
    councilRegNo: undefined,
    partnerOptIns: [],
    communityWaitlist: false,
    communityTopics: [],
    inviteCode: '',
  }
}

export const patient = (r: Row) => ({
  id: r.id,
  physioId: r.physio_id,
  phone: r.phone,
  name: r.name,
  age: opt(r.age),
  sex: opt(r.sex),
  condition: opt(r.condition),
  since: opt(r.since),
  tags: r.tags,
  visits: r.visits,
  linkToken: r.link_token,
  consentAt: iso(r.consent_at),
  createdAt: iso(r.created_at),
})

export const exercise = (r: Row) => ({
  id: r.id,
  name: r.name,
  region: r.region,
  category: r.category,
  dose: r.dose,
  cues: r.cues,
  videoUrl: opt(r.video_url),
})

export const plan = (r: Row) => ({
  id: r.id,
  patientId: r.patient_id,
  physioId: r.physio_id,
  title: r.title,
  items: r.items,
  daysPerWeek: r.days_per_week,
  weeks: r.weeks,
  startDate: r.start_date,
  status: r.status,
  sentAt: iso(r.sent_at),
  openedAt: iso(r.opened_at),
  rx: opt(r.rx),
})

export const session = (r: Row) => ({
  id: r.id,
  planId: r.plan_id,
  date: r.date,
  status: r.status,
  pain: opt(r.pain),
  note: opt(r.note),
})

export const booking = (r: Row) => ({
  id: r.id,
  physioId: r.physio_id,
  patientId: opt(r.patient_id),
  patientName: r.patient_name,
  patientPhone: r.patient_phone,
  date: r.date,
  time: r.time,
  visitType: r.visit_type,
  reason: opt(r.reason),
  isNewPatient: r.is_new_patient,
  status: r.status,
  sendConfirmation: r.send_confirmation,
  reminder: r.reminder,
  source: r.source,
  createdAt: iso(r.created_at),
})

export const message = (r: Row) => ({
  id: r.id,
  physioId: r.physio_id,
  patientId: r.patient_id,
  from: r.sender,
  text: r.text,
  at: iso(r.at),
  read: r.read,
})

export const referral = (r: Row) => ({
  id: r.id,
  referrerId: r.referrer_id,
  name: r.name,
  status: r.status,
  at: iso(r.at),
})

export const template = (r: Row) => ({
  id: r.id,
  physioId: r.physio_id,
  title: r.title,
  items: r.items,
  daysPerWeek: r.days_per_week,
  weeks: r.weeks,
})
