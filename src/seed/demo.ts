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
})
console.log('Demo data ready: physio 9876543210, patient 9845011223, link /plan/riya-3wk')
await pool.end()
