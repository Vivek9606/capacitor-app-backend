import { pool, tx } from '../db.js'
import { addDays, todayIST } from '../util.js'

/**
 * Optional demo account for testing a fresh deployment:
 *   physio 9876543210 (Dr. Ananya Rao) · patient 9845011223 (Riya Sharma)
 *   patient plan link: /plan/riya-3wk
 * Re-running resets the demo rows. Never run against real patient data you care about
 * for these numbers.
 */
const t = todayIST()
const start = addDays(t, -9)

await tx(async (c) => {
  await c.query("delete from physios where id = 'ph_ananya'")
  await c.query(
    `insert into physios (id, phone, name, email, qualification, experience_yrs, verification, focus_areas, practice_settings, slug, clinic, consult, working_days, hours, invite_code)
     values ('ph_ananya','9876543210','Dr. Ananya Rao','ananya@example.com','MPT (Ortho)',8,'verified','{Back pain,Sports injury,Post-surgery rehab}','{Clinic,Home visits}','ananya-rao',
             '{"name":"Rao Physio Studio","address":"2nd floor, 14 100 Feet Rd","area":"Indiranagar, Bengaluru"}',
             '{"inClinic":{"enabled":true,"fee":700,"minutes":45},"homeVisit":{"enabled":true,"fee":1200,"radiusKm":6}}',
             '{Mon,Tue,Wed,Thu,Fri,Sat}','{"start":"09:00","end":"19:00"}','ANANYA-BH')`,
  )
  await c.query(
    `insert into patients (id, physio_id, phone, name, age, sex, condition, since, tags, visits, link_token)
     values ('pt_riyasharma','ph_ananya','9845011223','Riya Sharma',34,'F','Mechanical LBP, L4–L5',$1,'{Desk job}',3,'riya-3wk')`,
    [addDays(t, -21)],
  )
  await c.query(
    `insert into plans (id, patient_id, physio_id, title, items, days_per_week, weeks, start_date, status, sent_at, opened_at, rx)
     values ('pl_riyacore','pt_riyasharma','ph_ananya','Core stability',$1,5,3,$2,'active', now() - interval '9 days', now() - interval '9 days', $3)`,
    [
      JSON.stringify([
        { exerciseId: 'pelvic-tilt', sets: 3, reps: 10, holdSec: 5 },
        { exerciseId: 'bird-dog', sets: 3, reps: 8, perSide: true },
        { exerciseId: 'glute-bridge', sets: 3, reps: 12 },
        { exerciseId: 'dead-bug', sets: 2, reps: 10 },
      ]),
      start,
      JSON.stringify({ diagnosis: 'Mechanical LBP, L4–L5', advice: 'Avoid sitting > 40 min. Heat for 15 min before exercises. Walk 20 min daily.', modalities: ['Heat', 'IFT'], followUp: '1w', autoBook: true, letterhead: true }),
    ],
  )
  const pains = [6, 6, 5, 5, 4, 4]
  for (let i = 0; i < pains.length; i++) {
    await c.query("insert into session_logs (id, plan_id, date, status, pain) values ($1,'pl_riyacore',$2,'done',$3)", [`s_demo${i}0`, addDays(start, i + (i > 3 ? 2 : 0)), pains[i]])
  }
  await c.query(
    `insert into bookings (id, physio_id, patient_id, patient_name, patient_phone, date, time, visit_type, reason, status, source)
     values ('bk_riyanext','ph_ananya','pt_riyasharma','Riya Sharma','9845011223',$1,'17:30','in_clinic','Follow-up','confirmed','physio'),
            ('bk_newreq01','ph_ananya',null,'Arjun Mehta','9900112233',$2,'11:00','in_clinic','Knee pain after running','requested','public_profile')`,
    [addDays(t, 2), addDays(t, 1)],
  )
  await c.query("insert into messages (id, physio_id, patient_id, sender, text, at) values ('m_demo001','ph_ananya','pt_riyasharma','patient','Bird dog feels a bit tricky on the left side — is that normal?', now() - interval '3 hours')")

  // Practice modes, weekly hours, billing, course progress.
  const weekday = [
    { start: '09:00', end: '13:00' },
    { start: '15:00', end: '19:00' },
  ]
  await c.query('update physios set practice = $2, availability = $3, billing = $4, course_progress = $5, consult = $6 where id = $1', [
    'ph_ananya',
    JSON.stringify({ modes: ['clinic', 'home'], serviceArea: 'Indiranagar, Domlur, HAL 2nd Stage', travelBufferMin: 20 }),
    JSON.stringify({
      weekly: { Mon: weekday, Tue: weekday, Wed: weekday, Thu: weekday, Fri: weekday, Sat: [{ start: '08:00', end: '13:00' }], Sun: [] },
      slotStepMin: 30,
      bufferMin: 15,
      minNoticeHours: 2,
      maxDaysAhead: 30,
    }),
    JSON.stringify({ invoicePrefix: 'INV', taxPct: 0, upiId: 'ananyarao@okhdfc' }),
    ['l1'],
    JSON.stringify({ inClinic: { enabled: true, fee: 700, minutes: 45 }, homeVisit: { enabled: true, fee: 1200, radiusKm: 6, minutes: 60 } }),
  ])

  // Walk-in waiting now, a no-show last week, a lunch block tomorrow.
  await c.query(
    `insert into bookings (id, physio_id, patient_id, patient_name, patient_phone, date, time, visit_type, reason, status, source, send_confirmation, reminder, checked_in_at)
     values ('bk_walkin01','ph_ananya',null,'Meera Pillai','9811122233',$1,to_char(now() at time zone 'Asia/Kolkata','HH24:MI'),'in_clinic','Neck stiffness','checked_in','walk_in',false,false, now()),
            ('bk_noshow01','ph_ananya','pt_riyasharma','Riya Sharma','9845011223',$2,'17:30','in_clinic','Follow-up','no_show','physio',true,true,null)`,
    [t, addDays(t, -5)],
  )
  await c.query("insert into blocks (id, physio_id, date, start_time, end_time, reason) values ('bl_demo001','ph_ananya',$1,'13:00','15:00','Hospital rounds')", [addDays(t, 1)])

  // Weekly Saturday back-care class, with Riya booked into the first one.
  const sat = Array.from({ length: 7 }, (_, i) => addDays(t, i + 1)).find((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 6)!
  for (let i = 0; i < 3; i++)
    await c.query(
      `insert into group_sessions (id, physio_id, series_id, title, description, date, time, minutes, capacity, fee, location, public_booking, participants)
       values ($1,'ph_ananya','gs_backcare','Back care group','Core and mobility for desk workers. Bring a mat.',$2,'08:00',60,8,300,'Rao Physio Studio, Indiranagar',true,$3)`,
      [`gr_backcar${i}`, addDays(sat, i * 7), JSON.stringify(i === 0 ? [{ id: 'gp_riya0001', patientId: 'pt_riyasharma', name: 'Riya Sharma', phone: '9845011223', status: 'booked', joinedAt: new Date().toISOString() }] : [])],
    )

  // A paid and an unpaid bill, and a consent waiting for Riya's signature.
  await c.query(
    `insert into invoices (id, physio_id, patient_id, patient_name, patient_phone, number, date, items, discount, tax_pct, total, status, method, paid_at, sent_at)
     values ('iv_demo0001','ph_ananya','pt_riyasharma','Riya Sharma','9845011223',$1,$2,$3,0,0,700,'paid','upi', now() - interval '9 days', now() - interval '9 days'),
            ('iv_demo0002','ph_ananya','pt_riyasharma','Riya Sharma','9845011223',$4,$5,$6,200,0,2600,'unpaid',null,null, now() - interval '2 days')`,
    [
      `INV-${start.slice(0, 4)}-0001`,
      start,
      JSON.stringify([{ description: 'Initial assessment', qty: 1, rate: 700 }]),
      `INV-${t.slice(0, 4)}-0002`,
      addDays(t, -2),
      JSON.stringify([{ description: 'Physiotherapy session', qty: 4, rate: 700 }]),
    ],
  )
  await c.query(
    `insert into consents (id, physio_id, patient_id, form_id, title, body, status, method, requested_at)
     values ('cs_demo0001','ph_ananya','pt_riyasharma','electrotherapy','Electrotherapy (IFT / TENS / ultrasound)',$1,'pending','remote', now() - interval '1 day')`,
    [
      'I agree to electrotherapy (IFT, TENS or therapeutic ultrasound) as part of my treatment with Dr. Ananya Rao. I understand it may cause a tingling sensation, and that I should tell my physiotherapist straight away about any burning, discomfort, a pacemaker or other implant, pregnancy, or loss of skin sensation. I can stop the treatment at any time.',
    ],
  )
})
console.log('Demo data ready: physio 9876543210, patient 9845011223, link /plan/riya-3wk')
await pool.end()
