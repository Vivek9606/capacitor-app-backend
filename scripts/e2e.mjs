// End-to-end API checks against the AWS backend: every way a person enters, and whether admin sees it.
// Usage: E2E_CODE=<OTP_DEV_CODE of the target> E2E_ADMIN=<a number in its ADMIN_PHONES> node scripts/e2e.mjs <API_URL>
// Test backends only (it needs OTP_DEV_CODE set). Every number it creates is flagged as a test contact at the end.
const API = (process.argv[2] || '').replace(/\/$/, '')
const ORIGIN = 'https://betterhood-dist.pages.dev'
const CODE = process.env.E2E_CODE
if (!API || !CODE || !process.env.E2E_ADMIN) { console.error('Set E2E_CODE and E2E_ADMIN, and pass the API URL'); process.exit(1) }
const RUN = Date.now().toString(36).slice(-4)
const results = []
const ids = {}
const B = 9100000000 + Math.floor(Math.random() * 90000) * 100
const n = (k) => String(B + k)
const P = { webLead: n(1), contact: n(2), appPatient: n(3), invited: n(4), corp: n(5), atAssessment: n(6), badVia: n(7), dirPhysio: n(10), appPhysio: n(11), admin: process.env.E2E_ADMIN }

async function call(method, path, body, token, origin = ORIGIN) {
  const res = await fetch(API + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), origin },
    body: body ? JSON.stringify(body) : undefined,
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data, cors: res.headers.get('access-control-allow-origin') }
}
function check(group, name, ok, detail = '') {
  results.push({ group, name, ok: !!ok, detail: ok ? '' : String(detail).slice(0, 300) })
}
async function step(group, name, fn) {
  try { await fn() } catch (e) { check(group, name, false, e?.stack || e) }
}
async function login(phone, as) {
  const r1 = await call('POST', '/auth/otp/request', { phone })
  if (r1.status !== 200) throw new Error(`otp request ${r1.status} ${JSON.stringify(r1.data)}`)
  const r2 = await call('POST', '/auth/otp/verify', { phone, code: CODE, ...(as ? { as } : {}) })
  if (r2.status !== 200) throw new Error(`otp verify ${r2.status} ${JSON.stringify(r2.data)}`)
  return r2.data
}
const terms = [
  { purpose: 'terms', granted: true, version: 'e2e-1', wording: 'I agree to the Terms and Privacy Policy.' },
  { purpose: 'share_with_physio', granted: true, version: 'e2e-1', wording: 'I agree to share my progress with my physio.' },
  { purpose: 'whatsapp_updates', granted: true, version: 'e2e-1', wording: 'Send me updates on WhatsApp.' },
]
const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10)
const plusDays = (n) => new Date(Date.parse(today) + n * 864e5).toISOString().slice(0, 10)

// ---------------- 0. platform ----------------
await step('0 Platform', 'health + DB', async () => {
  const r = await call('GET', '/health')
  check('0 Platform', 'GET /health is ok (DB reachable)', r.status === 200 && r.data?.ok, JSON.stringify(r))
  check('0 Platform', 'CORS allows the website origin', r.cors === ORIGIN, r.cors)
  const bad = await call('GET', '/health', null, null, 'https://evil.example')
  check('0 Platform', 'CORS refuses an unknown origin', bad.cors !== 'https://evil.example', bad.cors)
})

// ---------------- 1. website, anonymous ----------------
const resultId = 'as_we2e' + RUN + 'x1'
await step('1 Website (no account)', 'submissions', async () => {
  const a = await call('POST', '/public/web/submissions', {
    kind: 'assessment', form: 'assessment-lower-back-pain', page: '/assessment-lower-back-pain/', name: 'E2E Web Lead', phone: P.webLead, email: 'e2e.web@example.com', resultId,
    data: { area: 'back', cat: 'muscle', painScore: 6, answers: [{ q: 'Where is the pain?', a: 'Lower back' }], formVersion: 'e2e' },
  })
  check('1 Website (no account)', 'Pain assessment (lower back) is saved', a.status === 200, JSON.stringify(a))
  const h = await call('POST', '/public/web/submissions', { kind: 'assessment', form: 'assessment-knee-health-level-2', page: '/assessment-knee-health-level-2/', name: 'E2E Web Lead', phone: P.webLead, resultId: 'as_we2e' + RUN + 'x2', data: { area: 'knee', overall: 6.5 } })
  check('1 Website (no account)', 'Health assessment (knee L2) is saved', h.status === 200, JSON.stringify(h))
  for (const [form, phone, extra] of [['contact', P.contact, { message: 'E2E contact message' }], ['corporate-wellness', P.corp, { company: 'E2E Co', size: '50-200' }], ['resource-request', P.contact, { resource: 'back-protocol' }], ['slouch-catcher-waitlist', P.contact, {}]]) {
    const r = await call('POST', '/public/web/submissions', { kind: 'form', form, page: `/${form}/`, name: `E2E ${form}`, phone, email: `e2e.${form}@example.com`, data: { ...extra } })
    check('1 Website (no account)', `Form "${form}" is saved`, r.status === 200, JSON.stringify(r))
  }
  const hp = await call('POST', '/public/web/submissions', { kind: 'form', form: 'contact', phone: P.contact, website: 'bot', data: {} })
  check('1 Website (no account)', 'Honeypot (bot) submission is rejected', hp.status >= 400, hp.status)
  const n = await call('POST', '/public/newsletter/subscribe', { email: `e2e.news.${RUN}@example.com`, name: 'E2E News', source: 'website', page: '/' })
  check('1 Website (no account)', 'Newsletter sign-up accepted (double opt-in pending)', n.status === 200 && n.data?.ok, JSON.stringify(n))
  const d = await call('GET', '/public/directory')
  check('1 Website (no account)', 'Public directory feed responds', d.status === 200 && Array.isArray(d.data?.physios), JSON.stringify(d).slice(0, 200))
})

// ---------------- 2. website visitor creates an account and claims results ----------------
await step('2 Website → account', 'signup + claim', async () => {
  const v = await login(P.webLead)
  check('2 Website → account', 'OTP for a new number returns a sign-up token', !!v.signupToken, JSON.stringify(v))
  const s = await call('POST', '/auth/signup-patient', { signupToken: v.signupToken, name: 'E2E Web Lead', city: 'Pune', email: 'e2e.web@example.com', consents: terms, channel: 'web' })
  check('2 Website → account', 'Patient account created from the website', s.status === 200 && s.data?.role === 'patient', JSON.stringify(s))
  ids.webPatient = s.data?.userId; ids.webTok = s.data?.token
  const wr = await call('GET', '/patient/web-results', null, ids.webTok)
  const found = (wr.data?.results ?? []).map((r) => r.id ?? r.resultId)
  check('2 Website → account', 'Account sees the 2 earlier website results to claim', wr.status === 200 && (wr.data?.results?.length ?? 0) >= 2, JSON.stringify(wr.data).slice(0, 300))
  const c = await call('POST', '/patient/web-results', { claim: found.filter(Boolean), disown: [] }, ids.webTok)
  check('2 Website → account', 'Claiming them saves them to the account', c.status === 200 && (c.data?.assessments?.length ?? 0) >= 1, JSON.stringify(c.data).slice(0, 300))
  const b = await call('GET', '/me/bootstrap', null, ids.webTok)
  check('2 Website → account', 'App bootstrap loads for this patient', b.status === 200, b.status)
})

// ---------------- 2b. account made by finishing an assessment, then the health score ----------------
await step('2b Account at assessment', 'signup via assessment', async () => {
  const G = '2b Account at assessment'
  const v = await login(P.atAssessment)
  const s = await call('POST', '/auth/signup-patient', { signupToken: v.signupToken, name: 'E2E Assessment Signup', email: 'e2e.asmt@example.com', via: 'assessment:assessment-lower-back-pain', consents: terms.slice(0, 2), channel: 'web' })
  check(G, 'Finishing a pain assessment creates the account (sign-up "via" the assessment)', s.status === 200 && s.data?.role === 'patient', JSON.stringify(s))
  ids.asmtTok = s.data?.token
  const bad = await call('POST', '/auth/signup-patient', { signupToken: (await login(P.badVia)).signupToken, name: 'E2E Bad Via', via: 'javascript:alert(1)', consents: terms.slice(0, 2), channel: 'web' })
  check(G, 'A malformed "via" is rejected', bad.status === 400, bad.status)
  const pain = await call('POST', '/patient/assessments', {
    id: 'as_wasm' + RUN + 'p1', slug: 'assessment-lower-back-pain', kind: 'pain', area: 'back', title: 'Lower Back Pain', cat: 'muscle', condition: 'Muscular Imbalance', result: 'result-lower-back-pain-muscle', totals: { muscle: 9 }, source: 'web', takenAt: new Date().toISOString(), formVersion: 'e2e',
  }, ids.asmtTok)
  check(G, 'The pain result is saved to the new account', pain.status === 200, JSON.stringify(pain))
  const health = await call('POST', '/patient/assessments', {
    id: 'as_wasm' + RUN + 'h1', slug: 'assessment-back-health', kind: 'health', area: 'back', title: 'Back Health', totals: {}, scores: { overall: 6.2, strength: 5, balance: 7, mobility: 6.5 }, source: 'web', takenAt: new Date(Date.now() + 60e3).toISOString(), formVersion: 'e2e',
  }, ids.asmtTok)
  check(G, 'The health score taken next is saved too', health.status === 200, JSON.stringify(health))
})

// ---------------- 3. app-only patient ----------------
await step('3 App patient', 'signup + assessment + pain chat', async () => {
  const v = await login(P.appPatient)
  const s = await call('POST', '/auth/signup-patient', { signupToken: v.signupToken, name: 'E2E App Patient', age: 34, sex: 'F', city: 'Mumbai', consents: terms, channel: 'app' })
  check('3 App patient', 'Patient signs up in the app', s.status === 200 && s.data?.role === 'patient', JSON.stringify(s))
  ids.appPatient = s.data?.userId; ids.appTok = s.data?.token
  const a = await call('POST', '/patient/assessments', {
    id: 'as_ae2e' + RUN, slug: 'assessment-neck-pain-level-1', kind: 'pain', area: 'neck', title: 'Neck pain', cat: 'muscle', condition: 'Muscle strain', result: 'result-neck-pain-muscle', totals: { muscle: 8, nerve: 2 },
    answers: [{ q: 'How long?', a: '2 weeks' }], painScore: 5, takenAt: new Date().toISOString(), formVersion: 'e2e',
  }, ids.appTok)
  check('3 App patient', 'Assessment taken inside the app is saved', a.status === 200 && !!a.data?.assessment, JSON.stringify(a).slice(0, 300))
  const pc = await call('POST', '/patient/pain-chat', {}, ids.appTok)
  check('3 App patient', 'Pain chat starts (no AI key → fixed questions)', pc.status === 200 && !!pc.data?.chat, JSON.stringify(pc).slice(0, 200))
  const again = await login(P.appPatient)
  check('3 App patient', 'Logging in again returns the same account (no duplicate)', again.userId === ids.appPatient, JSON.stringify(again))
})

// ---------------- 4. physio joins via the website directory ----------------
await step('4 Physio via directory', 'join', async () => {
  const v = await login(P.dirPhysio)
  const profile = {
    name: 'Dr. E2E Directory ' + RUN, email: 'e2e.physio@example.com', degree: 'BPT', years: 6, regNo: 'E2E-123', cityName: 'Pune', city: 'pune', stateName: 'Maharashtra', state: 'maharashtra',
    modes: ['Clinic Visit'], fee: '800', specializations: ['Back pain'], about: 'E2E test physio. Treats back and neck pain with exercise-first care plans for desk workers.',
    education: [{ degree: 'BPT', institute: 'E2E College', year: '2018' }], experience: [], certifications: [], awards: [],
  }
  const s = await call('POST', '/directory/signup', { signupToken: v.signupToken, profile }, null)
  check('4 Physio via directory', 'Physio lists themselves (account + listing created)', s.status === 200 && s.data?.role === 'physio', JSON.stringify(s).slice(0, 300))
  ids.dirPhysio = s.data?.userId; ids.dirTok = s.data?.token
  const d = await call('GET', '/public/directory')
  check('4 Physio via directory', 'Listing appears in the public directory feed', JSON.stringify(d.data).includes(ids.dirPhysio ?? '§') || JSON.stringify(d.data).includes('E2E Directory'), JSON.stringify(d.data).slice(0, 200))
})

// ---------------- 5. physio signs up in the app ----------------
await step('5 Physio via app', 'signup', async () => {
  const v = await login(P.appPhysio)
  const s = await call('POST', '/auth/signup', { signupToken: v.signupToken, name: 'Dr. E2E App Physio', focusAreas: ['back'], practiceSettings: ['clinic'], practice: { modes: ['clinic'] }, consents: [terms[0]], channel: 'app' })
  check('5 Physio via app', 'Physio signs up in the app', s.status === 200 && s.data?.role === 'physio', JSON.stringify(s))
  ids.appPhysio = s.data?.userId; ids.appPhysioTok = s.data?.token
  const ch = await call('GET', '/community/channels', null, ids.appPhysioTok)
  check('5 Physio via app', 'Physio can open Community', ch.status === 200, `${ch.status} ${JSON.stringify(ch.data).slice(0, 150)}`)
})

// ---------------- 6. admin ----------------
await step('6 Admin', 'login + actions', async () => {
  const noTok = await call('GET', '/admin/dashboard')
  check('6 Admin', 'Dashboard refuses a request with no login', noTok.status === 401 || noTok.status === 403, noTok.status)
  const asPatient = await call('GET', '/admin/dashboard', null, ids.appTok)
  check('6 Admin', 'Dashboard refuses a patient login', asPatient.status === 403 || asPatient.status === 401, asPatient.status)
  const a = await login(P.admin, 'admin')
  ids.adminTok = a.token
  check('6 Admin', 'Admin number logs in as admin', a.role === 'admin', JSON.stringify(a))
  const ver = await call('POST', `/admin/physios/${ids.dirPhysio}/verification`, { status: 'verified' }, ids.adminTok)
  check('6 Admin', 'Admin verifies the directory physio', ver.status === 200, JSON.stringify(ver).slice(0, 200))
  const asg = await call('POST', `/admin/patients/${ids.appPatient}/assign`, { physioId: ids.dirPhysio }, ids.adminTok)
  check('6 Admin', 'Admin assigns the app patient to that physio', asg.status === 200, JSON.stringify(asg).slice(0, 200))
})

// ---------------- 7. physio works with patients ----------------
await step('7 Physio ↔ patient', 'care flow', async () => {
  const inv = await call('POST', '/physio/patients', { name: 'E2E Invited Patient', phone: P.invited, condition: 'Knee pain' }, ids.dirTok)
  check('7 Physio ↔ patient', 'Physio adds a new patient by phone (invite)', inv.status === 200 && !!inv.data?.id, JSON.stringify(inv).slice(0, 200))
  ids.invited = inv.data?.id
  const boot = await call('GET', '/me/bootstrap', null, ids.dirTok)
  const ex = boot.data?.db?.exercises?.[0]?.id
  check('7 Physio ↔ patient', 'Exercise library is loaded (34 seeded)', (boot.data?.db?.exercises?.length ?? 0) >= 30, boot.data?.db?.exercises?.length)
  const pl = await call('POST', '/physio/plans', { patientId: ids.appPatient, title: 'E2E plan', items: [{ exerciseId: ex, sets: 2, reps: 10 }], daysPerWeek: 3, weeks: 2, sendWhatsApp: false }, ids.dirTok)
  check('7 Physio ↔ patient', 'Physio sends a care plan to the assigned patient', pl.status === 200, JSON.stringify(pl).slice(0, 250))
  ids.plan = pl.data?.id ?? pl.data?.plan?.id
  const ses = await call('PUT', '/patient/sessions', { planId: ids.plan, date: today, status: 'done', pain: 3 }, ids.appTok)
  check('7 Physio ↔ patient', 'Patient logs an exercise session', ses.status === 200, JSON.stringify(ses).slice(0, 200))
  const bk = await call('POST', '/physio/bookings', { patientId: ids.appPatient, patientName: 'E2E App Patient', patientPhone: P.appPatient, date: plusDays(2), time: '10:00', visitType: 'in_clinic', reason: 'E2E follow-up', status: 'awaiting' }, ids.dirTok)
  check('7 Physio ↔ patient', 'Physio books an appointment for the patient', bk.status === 200, JSON.stringify(bk).slice(0, 250))
  const msg = await call('POST', '/patient/messages', { text: 'E2E hello physio' }, ids.appTok)
  check('7 Physio ↔ patient', 'Patient messages their physio', msg.status === 200, JSON.stringify(msg).slice(0, 200))
  const sw = await call('POST', '/auth/switch', { to: 'patient' }, ids.dirTok)
  check('7 Physio ↔ patient', 'Physio can switch to a consumer profile (same number)', sw.status === 200 && sw.data?.role === 'patient', JSON.stringify(sw).slice(0, 200))
})

// ---------------- 7b. notifications ----------------
await step('7b Notifications', 'push tokens + nudges', async () => {
  const G = '7b Notifications'
  const tok = 'e2e-fcm-token-' + RUN + '-'.padEnd(40, 'x')
  const r = await call('POST', '/me/push-token', { token: tok, platform: 'android' }, ids.appTok)
  check(G, 'App registers a device for push', r.status === 200, `${r.status} ${JSON.stringify(r.data)}`)
  const again = await call('POST', '/me/push-token', { token: tok, platform: 'android' }, ids.appTok)
  check(G, 'Registering the same device again is fine', again.status === 200, again.status)
  const anon = await call('POST', '/me/push-token', { token: tok, platform: 'android' })
  check(G, 'Registering without signing in is refused', anon.status === 401, anon.status)
  const run = await call('POST', '/admin/nudges/run', {}, ids.adminTok)
  check(G, 'Admin can run the nudge job', run.status === 200 && typeof run.data?.sent === 'number', `${run.status} ${JSON.stringify(run.data)}`)
  const d = await call('GET', '/admin/dashboard', null, ids.adminTok)
  const ap = (d.data?.people ?? []).find((x) => x.phone === P.appPatient)
  check(G, 'Dashboard shows the patient has push on', ap?.pushEnabled === true, JSON.stringify(ap && { pushEnabled: ap.pushEnabled }))
  check(G, 'Dashboard lists nudges sent', Array.isArray(d.data?.events?.nudges), typeof d.data?.events?.nudges)
  const due = await call('GET', '/admin/nudges/due', null, ids.adminTok)
  check(G, 'Admin sees who is due a nudge', due.status === 200 && Array.isArray(due.data?.due), `${due.status} ${JSON.stringify(due.data).slice(0, 200)}`)
  const ex = await call('POST', '/admin/nudges/send', { patientId: ids.appPatient, kind: 'exercise' }, ids.adminTok)
  check(G, 'Admin sends an exercise nudge to a patient with a care plan', ex.status === 200 && Array.isArray(ex.data?.channels), `${ex.status} ${JSON.stringify(ex.data)}`)
  const hs = await call('POST', '/admin/nudges/send', { patientId: ids.appPatient, kind: 'health_score' }, ids.adminTok)
  check(G, 'Admin sends a health score nudge after a pain assessment', hs.status === 200, `${hs.status} ${JSON.stringify(hs.data)}`)
  const none = await call('POST', '/admin/nudges/send', { patientId: ids.webPatient, kind: 'exercise' }, ids.adminTok)
  check(G, 'Nudging someone with no care plan is refused with a reason', none.status === 409 && /care plan/.test(none.data?.message ?? ''), `${none.status} ${JSON.stringify(none.data)}`)
  const asPatient = await call('POST', '/admin/nudges/send', { patientId: ids.appPatient, kind: 'exercise' }, ids.appTok)
  check(G, 'A patient cannot send nudges', asPatient.status === 403, asPatient.status)
  const d2 = await call('GET', '/admin/dashboard', null, ids.adminTok)
  const mine = (d2.data?.events?.nudges ?? []).filter((n) => n.who === ids.appPatient && n.manual)
  check(G, 'Dashboard lists the nudges the admin sent', mine.length >= 2, JSON.stringify(mine))
  const del = await call('DELETE', '/me/push-token', { token: tok }, ids.appTok)
  check(G, 'Signing out removes the device', del.status === 200, del.status)
})

// ---------------- 8. does admin see every entry, once? ----------------
await step('8 Admin dashboard', 'visibility', async () => {
  const d = await call('GET', '/admin/dashboard', null, ids.adminTok)
  check('8 Admin dashboard', 'Dashboard loads', d.status === 200, `${d.status} ${JSON.stringify(d.data).slice(0, 200)}`)
  const people = d.data?.people ?? []
  const byPhone = (p) => people.filter((x) => x.phone === p)
  const web = byPhone(P.webLead)
  check('8 Admin dashboard', 'Website visitor who signed up = ONE person (not website + account)', web.length === 1, JSON.stringify(web.map((x) => x.kind)))
  check('8 Admin dashboard', '…shown as an account whose source is "website"', web[0]?.kind === 'account' && web[0]?.source === 'website', JSON.stringify(web[0] && { kind: web[0].kind, source: web[0].source }))
  check('8 Admin dashboard', '…with "details", "assessed" and "account" steps reached', web[0]?.steps?.details && web[0]?.steps?.assessed && web[0]?.steps?.account, JSON.stringify(web[0]?.steps))
  check('8 Admin dashboard', '…first contact is not later than first assessment', !web[0] || web[0].steps.details <= web[0].steps.assessed, JSON.stringify(web[0]?.steps))
  const asm = byPhone(P.atAssessment)
  check('8 Admin dashboard', 'Account made at an assessment = ONE person, source "website"', asm.length === 1 && asm[0].source === 'website', JSON.stringify(asm.map((x) => ({ kind: x.kind, source: x.source }))))
  check('8 Admin dashboard', '…shows which assessment created the account', asm[0]?.signupVia === 'assessment:assessment-lower-back-pain', asm[0]?.signupVia)
  const asmEv = (d.data?.events?.assessments ?? []).filter((e) => e.who === asm[0]?.key)
  check('8 Admin dashboard', '…with the pain assessment and the health score that followed', asmEv.some((e) => e.kind === 'pain') && asmEv.some((e) => e.kind === 'health'), JSON.stringify(asmEv.map((e) => e.kind)))
  const lead = byPhone(P.contact)
  check('8 Admin dashboard', 'Contact-form lead appears as a "Website only" person', lead.length === 1 && lead[0].kind === 'website', JSON.stringify(lead.map((x) => x.kind)))
  check('8 Admin dashboard', '…all 3 of their forms counted on one row', lead[0]?.counts?.websiteSubmissions === 3, JSON.stringify(lead[0]?.counts))
  check('8 Admin dashboard', 'Corporate-wellness lead appears', byPhone(P.corp).length === 1, byPhone(P.corp).length)
  const ap = byPhone(P.appPatient)[0]
  check('8 Admin dashboard', 'App patient appears with source "app"', ap?.source === 'app', JSON.stringify(ap && { source: ap.source }))
  check('8 Admin dashboard', '…matched, plan, exercised and booked steps reached', ap?.steps?.matched && ap?.steps?.plan && ap?.steps?.exercised && ap?.steps?.booked, JSON.stringify(ap?.steps))
  check('8 Admin dashboard', '…assigned to the directory physio', !!ids.dirPhysio && ap?.physioId === ids.dirPhysio, ap?.physioId)
  const iv = byPhone(P.invited)[0]
  check('8 Admin dashboard', 'Physio-invited patient appears with source "physio"', iv?.source === 'physio', JSON.stringify(iv && { source: iv.source }))
  const phys = d.data?.physios ?? []
  const dp = phys.find((x) => x.id === ids.dirPhysio)
  check('8 Admin dashboard', 'Directory physio appears in Physios, verified', !!dp && /verified/.test(JSON.stringify(dp)), String(JSON.stringify(dp)).slice(0, 250))
  check('8 Admin dashboard', 'App physio appears in Physios', phys.some((x) => x.id === ids.appPhysio), phys.length)
  const dpPerson = byPhone(P.dirPhysio)[0]
  check('8 Admin dashboard', 'Physio who switched to consumer is flagged "also a physio"', dpPerson?.alsoPhysio === true, JSON.stringify(dpPerson && { alsoPhysio: dpPerson.alsoPhysio }))
  const ev = d.data?.events ?? {}
  check('8 Admin dashboard', 'Events include assessments, sessions and bookings', (ev.assessments?.length ?? 0) >= 2 && (ev.sessions?.length ?? 0) >= 1 && (ev.bookings?.length ?? 0) >= 1, JSON.stringify({ a: ev.assessments?.length, s: ev.sessions?.length, b: ev.bookings?.length }))
  const sub = await call('GET', `/admin/submissions/${P.contact}`, null, ids.adminTok)
  check('8 Admin dashboard', 'Admin opens a lead’s submissions', sub.status === 200, `${sub.status} ${JSON.stringify(sub.data).slice(0, 150)}`)
  const j = await call('GET', `/admin/journey/patient/${ids.appPatient}`, null, ids.adminTok)
  check('8 Admin dashboard', 'Admin opens a patient’s journey', j.status === 200, j.status)
  const t = await call('GET', `/admin/timeline/patient/${ids.appPatient}`, null, ids.adminTok)
  check('8 Admin dashboard', 'Patient timeline lists events', t.status === 200 && (t.data?.events?.length ?? 0) > 0, `${t.status} ${JSON.stringify(t.data).slice(0, 150)}`)
  const note = await call('POST', '/admin/notes', { subjectType: 'patient', subjectId: ids.appPatient, text: 'E2E note' }, ids.adminTok)
  check('8 Admin dashboard', 'Admin adds a note', note.status === 200, `${note.status} ${JSON.stringify(note.data).slice(0, 150)}`)
  const nl = await call('GET', '/admin/newsletter', null, ids.adminTok)
  check('8 Admin dashboard', 'Newsletter sign-up visible to admin', nl.status === 200 && JSON.stringify(nl.data).includes(`e2e.news.${RUN}`), `${nl.status} ${JSON.stringify(nl.data).slice(0, 150)}`)
})

// ---------------- 9. tidy: flag every test number ----------------
await step('9 Test flags', 'mark', async () => {
  let ok = 0
  for (const p of Object.values(P)) { const r = await call('PUT', `/admin/test-contacts/${p}`, {}, ids.adminTok); if (r.status === 200) ok++ }
  check('9 Test flags', 'All test numbers marked as test (hidden by default)', ok === Object.values(P).length, `${ok}/${Object.values(P).length}`)
  const d = await call('GET', '/admin/dashboard', null, ids.adminTok)
  const ours = (d.data?.people ?? []).filter((x) => Object.values(P).includes(x.phone))
  check('9 Test flags', 'Dashboard reports them as test', ours.length > 0 && ours.every((x) => x.test), JSON.stringify(ours.map((x) => [x.phone, x.test])))
})

const pass = results.filter((r) => r.ok).length
console.log(JSON.stringify({ run: RUN, pass, fail: results.length - pass, results }, null, 1))
