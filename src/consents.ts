import { z } from 'zod'
import { one, q } from './db.js'
import { HttpError, newId } from './util.js'

// Consents as the person gave them: purpose, the exact words they agreed to, which version, where and when.
// Every change is a new row in consents_log (nothing is overwritten); the person's row keeps the current state
// (patients.consent_at, whatsapp_opt_in) for quick checks.
//
//   terms              Terms of service and privacy policy
//   share_with_physio  their answers and progress are shared with the physio they're matched with
//   whatsapp_updates   appointment and care updates on WhatsApp (OTPs and booking confirmations don't need it)

export const consentItems = z
  .array(
    z.object({
      purpose: z.enum(['terms', 'share_with_physio', 'whatsapp_updates']),
      granted: z.boolean(),
      version: z.string().trim().min(1).max(40),
      wording: z.string().trim().min(1).max(600),
    }),
  )
  .max(6)
export type ConsentItem = z.infer<typeof consentItems>[number]

export async function recordConsents(type: 'patient' | 'physio', id: string, items: ConsentItem[], channel: 'web' | 'app') {
  const table = type === 'patient' ? 'patients' : 'physios'
  const who = await one<{ phone: string }>(`select phone from ${table} where id = $1`, [id])
  if (!who) throw new HttpError(401, 'Account not found', 'unauthenticated')
  for (const c of items) {
    await q('insert into consents_log (id, subject_type, subject_id, phone, purpose, granted, version, wording, channel) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      newId('cl'), type, id, who.phone, c.purpose, c.granted, c.version, c.wording, channel,
    ])
  }
  const wa = items.find((c) => c.purpose === 'whatsapp_updates')
  if (wa) await q(`update ${table} set whatsapp_opt_in = $2, whatsapp_opt_in_at = now() where id = $1`, [id, wa.granted])
  if (type === 'patient') {
    // The app's consent gate needs both: the terms, and sharing with the physio.
    const share = items.find((c) => c.purpose === 'share_with_physio')
    const terms = items.find((c) => c.purpose === 'terms')
    if (share?.granted && terms?.granted !== false) await q('update patients set consent_at = coalesce(consent_at, now()) where id = $1', [id])
    else if (share && !share.granted) await q('update patients set consent_at = null where id = $1', [id])
  }
  return (await one(`select * from ${table} where id = $1`, [id]))!
}

/** Consent history for one person, newest first (admin timeline). */
export const consentHistory = (type: 'patient' | 'physio', id: string) =>
  q('select purpose, granted, version, wording, channel, at from consents_log where subject_type = $1 and subject_id = $2 order by at desc', [type, id])
