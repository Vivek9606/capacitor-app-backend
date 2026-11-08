import { one } from './db.js'
import { env } from './env.js'
import { fmtDay, fmtTime } from './util.js'
import { sendLater } from './whatsapp.js'

export function webUrl(path: string) {
  return `${env.PUBLIC_WEB_URL.replace(/\/$/, '')}${path}`
}

/** WhatsApp booking confirmation (with Confirm / Reschedule quick replies). */
export async function sendBookingMessage(bookingId: string, kind: 'booking_confirmation' | 'booking_reminder') {
  const b = await one(
    `select b.*, ph.name as physio_name, ph.clinic from bookings b join physios ph on ph.id = b.physio_id where b.id = $1`,
    [bookingId],
  )
  if (!b) return
  const where = b.visit_type === 'home_visit' ? 'Home visit' : b.clinic?.address ? `${b.clinic.name}, ${b.clinic.address}` : b.physio_name
  sendLater({
    name: kind,
    to: b.patient_phone,
    patientName: String(b.patient_name).split(' ')[0],
    physioName: b.physio_name,
    when: `${fmtDay(b.date)}, ${fmtTime(b.time)}`,
    where,
    bookingId: b.id,
  })
}
