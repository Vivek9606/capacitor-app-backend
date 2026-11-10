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
  practice: opt(r.practice),
  availability: opt(r.availability),
  billing: opt(r.billing),
  courseProgress: r.course_progress ?? [],
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
    courseProgress: [],
  }
}

export const patient = (r: Row) => ({
  id: r.id,
  physioId: opt(r.physio_id),
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
  city: opt(r.city),
  email: opt(r.email),
  selfSignup: r.self_signup || undefined,
  match: r.match_status ? { status: r.match_status, suggestedPhysioId: opt(r.suggested_physio_id) } : undefined,
})

export const assessment = (r: Row) => ({
  id: r.id,
  patientId: r.patient_id,
  slug: r.slug,
  area: r.area,
  title: r.title,
  cat: opt(r.cat),
  condition: opt(r.condition),
  result: opt(r.result),
  advisory: opt(r.advisory),
  totals: r.totals ?? {},
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
  changes: r.changes?.length ? r.changes : undefined,
  updatedAt: iso(r.updated_at),
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
  minutes: opt(r.minutes),
  address: opt(r.address),
  checkedInAt: iso(r.checked_in_at),
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

export const block = (r: Row) => ({
  id: r.id,
  physioId: r.physio_id,
  date: r.date,
  start: opt(r.start_time),
  end: opt(r.end_time),
  reason: opt(r.reason),
})

export const group = (r: Row) => ({
  id: r.id,
  physioId: r.physio_id,
  seriesId: opt(r.series_id),
  title: r.title,
  description: opt(r.description),
  date: r.date,
  time: r.time,
  minutes: r.minutes,
  capacity: r.capacity,
  fee: r.fee,
  location: r.location,
  publicBooking: r.public_booking,
  status: r.status,
  participants: r.participants ?? [],
  createdAt: iso(r.created_at),
})

const seatsTaken = (r: Row) => ((r.participants ?? []) as { status: string }[]).filter((p) => p.status !== 'cancelled').length

/** A group session as a patient sees it: only their own seat, other seats as anonymous placeholders. */
export const groupForPatient = (r: Row, patientId: string, phone: string) => {
  const g = group(r)
  const mine = (g.participants as { patientId?: string; phone: string; status: string }[]).filter((p) => p.patientId === patientId || p.phone === phone)
  const others = Math.max(0, seatsTaken(r) - mine.filter((p) => p.status !== 'cancelled').length)
  const anon = Array.from({ length: others }, (_, i) => ({ id: `seat_${i}`, name: '', phone: '', status: 'booked', joinedAt: '' }))
  return { ...g, participants: [...mine, ...anon] }
}

/** Public booking page: no participant details at all. */
export const groupPublic = (r: Row) => {
  const { participants: _p, ...g } = group(r)
  return { ...g, seatsTaken: seatsTaken(r) }
}

export const invoice = (r: Row) => ({
  id: r.id,
  physioId: r.physio_id,
  patientId: opt(r.patient_id),
  patientName: r.patient_name,
  patientPhone: r.patient_phone,
  number: r.number,
  date: r.date,
  items: r.items,
  discount: r.discount,
  taxPct: Number(r.tax_pct),
  total: r.total,
  status: r.status,
  method: opt(r.method),
  paidAt: iso(r.paid_at),
  notes: opt(r.notes),
  bookingId: opt(r.booking_id),
  groupSessionId: opt(r.group_session_id),
  sentAt: iso(r.sent_at),
  createdAt: iso(r.created_at),
})

export const consent = (r: Row) => ({
  id: r.id,
  physioId: r.physio_id,
  patientId: r.patient_id,
  formId: r.form_id,
  title: r.title,
  body: r.body,
  status: r.status,
  method: r.method,
  signedName: opt(r.signed_name),
  signature: opt(r.signature),
  guardian: opt(r.guardian),
  requestedAt: iso(r.requested_at),
  signedAt: iso(r.signed_at),
})
