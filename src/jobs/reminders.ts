import { q } from '../db.js'
import { sendBookingMessage } from '../notify.js'

/**
 * Sends one WhatsApp reminder ~2 hours before each confirmed booking that asked for one.
 * The UPDATE … RETURNING claims rows atomically, so running several server instances is safe.
 */
export async function runReminders() {
  const due = await q<{ id: string }>(
    `update bookings set reminder_sent_at = now(), status = case when status = 'confirmed' then 'reminder_sent' else status end
      where reminder and reminder_sent_at is null
        and status in ('awaiting', 'confirmed')
        and (date + time::time) at time zone 'Asia/Kolkata' between now() and now() + interval '2 hours'
      returning id`,
  )
  for (const b of due) await sendBookingMessage(b.id, 'booking_reminder').catch((e) => console.error('reminder', b.id, e.message))
  if (due.length) console.log(`[reminders] sent ${due.length}`)
}

export function startReminderJob(everyMs = 5 * 60_000) {
  const tick = () => runReminders().catch((e) => console.error('[reminders] failed', e.message))
  setTimeout(tick, 10_000)
  return setInterval(tick, everyMs)
}
