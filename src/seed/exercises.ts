import { pool } from '../db.js'
import { EXERCISES } from './exercise-data.js'

// Upserts the starter library. Safe to re-run; never deletes (plans reference exercise ids).
for (const e of EXERCISES) {
  await pool.query(
    `insert into exercises (id, name, region, category, dose, cues) values ($1,$2,$3,$4,$5,$6)
     on conflict (id) do update set name = excluded.name, region = excluded.region, category = excluded.category, dose = excluded.dose, cues = excluded.cues`,
    [e.id, e.name, e.region, e.category, JSON.stringify(e.dose), e.cues],
  )
}
console.log(`Seeded ${EXERCISES.length} exercises`)
await pool.end()
