import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../auth.js'
import { assertSlotFree } from '../calendar.js'
import { one, q, tx } from '../db.js'
import * as M from '../mappers.js'
import { suggestPhysio } from '../match.js'
import { type Assessment, type ChatTurn, EMPTY_ASSESSMENT, type Engine, engineName, GREETING, runTurn } from '../painChat.js'
import { hhmm, id, isoDate } from '../schemas.js'
import { badRequest, HttpError, newId, notFound, todayIST } from '../util.js'

/** After this many user messages the chat offers the consult even if the assistant hasn't. */
const HANDOFF_AFTER = 8
/** A chat is closed to new messages after this many (start a new one). */
const MAX_USER_MESSAGES = 30

const AREA_LABEL: Record<string, string> = {
  back: 'Back pain',
  neck: 'Neck pain',
  shoulder: 'Shoulder pain',
  knee: 'Knee pain',
  hip: 'Hip pain',
  ankle_foot: 'Ankle / foot pain',
  elbow_wrist_hand: 'Elbow / wrist / hand pain',
}

type Row = Record<string, any>

/** The free consult is one per phone number, until it's cancelled. */
async function freeConsultUsed(phone: string) {
  return !!(await one("select 1 from bookings where patient_phone = $1 and sponsored and status <> 'cancelled' limit 1", [phone]))
}

/** Who the consult is with: the patient's own physio if they have one, else the best match for this problem. */
async function physioFor(p: Row, a: Assessment): Promise<string | undefined> {
  if (p.physio_id) return p.physio_id
  const cat = a.category === 'unknown' ? undefined : a.category
  const best = await suggestPhysio(cat, p.city ?? undefined)
  if (best) return best
  // No focus/city match: any physio, verified ones and lighter caseloads first (video consults work from anywhere).
  const any = await one<{ id: string }>(
    "select ph.id from physios ph order by (ph.verification = 'verified') desc, (select count(*) from patients p where p.physio_id = ph.id), ph.created_at limit 1",
  )
  return any?.id
}

async function view(chat: Row, p: Row) {
  const physio = chat.physio_id ? await one('select * from physios where id = $1', [chat.physio_id]) : undefined
  const booking = chat.booking_id ? await one('select * from bookings where id = $1', [chat.booking_id]) : undefined
  const a: Assessment = { ...EMPTY_ASSESSMENT, ...chat.assessment }
  return {
    id: chat.id,
    status: chat.status as 'open' | 'ready' | 'red_flag' | 'booked' | 'closed',
    engine: chat.engine as Engine,
    messages: chat.messages as ChatTurn[],
    // Shown to the user as "what we understood"; the physio summary stays for the physio.
    assessment: { area: a.area, stage: a.stage, severity: a.severity, redFlags: a.red_flags },
    physio: physio ? { ...M.physioPublic(physio), phone: '', billing: undefined } : undefined,
    booking: booking ? M.booking(booking) : undefined,
    freeConsultUsed: await freeConsultUsed(p.phone),
  }
}

async function me(pid: string): Promise<Row> {
  const p = await one('select * from patients where id = $1', [pid])
  if (!p) throw new HttpError(401, 'Account not found', 'unauthenticated')
  return p
}

async function newChat(pid: string) {
  await q("update pain_chats set status = 'closed', updated_at = now() where patient_id = $1 and status in ('open', 'ready', 'red_flag')", [pid])
  const greeting: ChatTurn = { role: 'assistant', text: GREETING, at: new Date().toISOString() }
  return (await one('insert into pain_chats (id, patient_id, messages, assessment, engine) values ($1,$2,$3,$4,$5) returning *', [
    newId('pc'),
    pid,
    JSON.stringify([greeting]),
    JSON.stringify(EMPTY_ASSESSMENT),
    engineName(),
  ]))!
}

export async function painChatRoutes(app: FastifyInstance) {
  // The latest chat (open, or booked so they can see what happened). Null when they've never chatted.
  app.get('/patient/pain-chat', async (req) => {
    const pid = requireRole(req, 'patient')
    const p = await me(pid)
    const chat = await one("select * from pain_chats where patient_id = $1 and status <> 'closed' order by created_at desc limit 1", [pid])
    return { chat: chat ? await view(chat, p) : null, freeConsultUsed: await freeConsultUsed(p.phone) }
  })

  app.post('/patient/pain-chat', async (req) => {
    const pid = requireRole(req, 'patient')
    const p = await me(pid)
    return { chat: await view(await newChat(pid), p) }
  })

  // One user message → one assistant reply. Rate-limited: each turn is a model call.
  app.post('/patient/pain-chat/:id/messages', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const pid = requireRole(req, 'patient')
    const { id: cid } = z.object({ id }).parse(req.params)
    const { text } = z.object({ text: z.string().trim().min(1).max(1000) }).parse(req.body)
    const p = await me(pid)
    const chat = await one('select * from pain_chats where id = $1 and patient_id = $2', [cid, pid])
    if (!chat) throw notFound('Chat not found')
    if (chat.status === 'closed') throw new HttpError(409, 'This chat has ended. Start a new one.', 'chat_closed')
    const history: ChatTurn[] = chat.messages
    const userCount = history.filter((t) => t.role === 'user').length + 1
    if (userCount > MAX_USER_MESSAGES) throw new HttpError(409, 'This chat is full. Start a new one.', 'chat_full')

    const turns: ChatTurn[] = [...history, { role: 'user', text, at: new Date().toISOString() }]
    const prev: Assessment = { ...EMPTY_ASSESSMENT, ...chat.assessment }
    let result
    try {
      result = await runTurn(turns, prev, { name: p.name, age: p.age, sex: p.sex, city: p.city })
    } catch (e) {
      req.log.error(e, 'pain chat turn failed')
      throw new HttpError(502, 'The assistant couldn’t reply just now. Please send that again.', 'chat_unavailable')
    }
    const a = result.assessment
    if (!a.red_flag && !a.ready_for_physio && userCount >= HANDOFF_AFTER && a.area !== 'unknown') a.ready_for_physio = true

    // Once booked, the chat stays booked; a red flag closes the door to the consult (it isn't the right care).
    let status: string = chat.status
    if (status !== 'booked') status = a.red_flag ? 'red_flag' : a.ready_for_physio ? 'ready' : 'open'
    let physioId: string | undefined = chat.physio_id ?? undefined
    if (status === 'ready' && !physioId) physioId = await physioFor(p, a)

    const reply: ChatTurn = { role: 'assistant', text: result.reply || '…', at: new Date().toISOString() }
    const row = await one(
      'update pain_chats set messages = $2, assessment = $3, status = $4, physio_id = $5, updated_at = now() where id = $1 returning *',
      [cid, JSON.stringify([...turns, reply]), JSON.stringify(a), status, physioId ?? null],
    )
    return { chat: await view(row!, p) }
  })

  // Book the free (Betterhood-sponsored) video consult with the matched physio.
  app.post('/patient/pain-chat/:id/book', async (req) => {
    const pid = requireRole(req, 'patient')
    const { id: cid } = z.object({ id }).parse(req.params)
    const b = z.object({ date: isoDate, time: hhmm }).parse(req.body)
    const p = await me(pid)
    const chat = await one('select * from pain_chats where id = $1 and patient_id = $2', [cid, pid])
    if (!chat) throw notFound('Chat not found')
    if (chat.status === 'booked') throw new HttpError(409, 'You’ve already booked your consult from this chat.', 'already_booked')
    if (chat.status === 'red_flag') throw badRequest('Please see a doctor first. What you described needs a medical check before physiotherapy.')
    if (chat.status !== 'ready' || !chat.physio_id) throw badRequest('Finish the chat first so we can match you with a physio.')
    if (await freeConsultUsed(p.phone)) throw new HttpError(409, 'You’ve already used your free consult. You can book a paid visit with your physio.', 'free_consult_used')
    if (b.date < todayIST()) throw badRequest('Pick a future date')
    const physio = await one('select * from physios where id = $1', [chat.physio_id])
    if (!physio) throw notFound('That physio is no longer available. Start a new chat.')
    if (physio.phone === p.phone) throw badRequest('You can’t book a consult with yourself.')
    if (p.physio_id && p.physio_id !== physio.id) throw badRequest('You already have a physio. Book with them from Appointments.')
    await assertSlotFree(physio, b.date, b.time, 'teleconsult', { forPatient: true })

    const a: Assessment = { ...EMPTY_ASSESSMENT, ...chat.assessment }
    const condition = AREA_LABEL[a.area] ?? null
    const out = await tx(async (c) => {
      // Re-check inside the transaction so two quick taps can't book two free consults.
      await c.query('select pg_advisory_xact_lock(hashtext($1))', [`free-consult:${p.phone}`])
      const used = await c.query("select 1 from bookings where patient_phone = $1 and sponsored and status <> 'cancelled'", [p.phone])
      if (used.rowCount) throw new HttpError(409, 'You’ve already used your free consult.', 'free_consult_used')
      let patient = p
      if (!p.physio_id) {
        // Choosing to consult this physio links them, the same way a physio's invite link does.
        const clash = await c.query('select 1 from patients where physio_id = $1 and phone = $2 and id <> $3', [physio.id, p.phone, pid])
        if (clash.rowCount) throw new HttpError(409, `${physio.name} already has you as a patient. Ask them to share your plan link.`, 'already_patient')
        patient = (
          await c.query(
            "update patients set physio_id = $2, suggested_physio_id = $2, match_status = 'confirmed', since = coalesce(since, $3), condition = coalesce(condition, $4) where id = $1 returning *",
            [pid, physio.id, todayIST(), condition],
          )
        ).rows[0]
      }
      const booking = (
        await c.query(
          `insert into bookings (id, physio_id, patient_id, patient_name, patient_phone, date, time, visit_type, reason, is_new_patient, status, send_confirmation, reminder, source, sponsored, brief)
           values ($1,$2,$3,$4,$5,$6,$7,'teleconsult',$8,true,'requested',true,true,'physio',true,$9) returning *`,
          [newId('bk'), physio.id, pid, p.name, p.phone, b.date, b.time, `Free video consult${condition ? `: ${condition.toLowerCase()}` : ''}`, a.summary_for_physio || null],
        )
      ).rows[0]
      const updated = (await c.query("update pain_chats set status = 'booked', booking_id = $2, updated_at = now() where id = $1 returning *", [cid, booking.id])).rows[0]
      return { booking, patient, chat: updated }
    })
    return { booking: M.booking(out.booking), patient: M.patient(out.patient), chat: await view(out.chat, out.patient) }
  })
}
