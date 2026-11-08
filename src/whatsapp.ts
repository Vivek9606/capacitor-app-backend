import { env } from './env.js'

/**
 * Outbound WhatsApp messages from Betterhood's verified business number.
 * Each one maps to a template that must be approved in Meta Business Manager with these names
 * and body variables ({{1}}, {{2}}…) in the order given below.
 */
export type Template =
  | { name: 'auth_otp'; to: string; code: string }
  | { name: 'care_plan_shared'; to: string; patientName: string; physioName: string; summary: string; url: string }
  | { name: 'rx_shared'; to: string; patientName: string; physioName: string; url: string }
  | { name: 'booking_confirmation'; to: string; patientName: string; physioName: string; when: string; where: string; bookingId: string }
  | { name: 'booking_reminder'; to: string; patientName: string; physioName: string; when: string; where: string; bookingId: string }
  | { name: 'physio_reply'; to: string; patientName: string; physioName: string; text: string; url: string }

function bodyParams(t: Template): string[] {
  switch (t.name) {
    case 'auth_otp':
      return [t.code]
    case 'care_plan_shared':
      return [t.patientName, t.physioName, t.summary, t.url]
    case 'rx_shared':
      return [t.patientName, t.physioName, t.url]
    case 'booking_confirmation':
    case 'booking_reminder':
      return [t.patientName, t.physioName, t.when, t.where]
    case 'physio_reply':
      return [t.patientName, t.physioName, t.text, t.url]
  }
}

/** Quick-reply buttons carry the booking id so replies can be matched in the webhook. */
function buttonPayloads(t: Template): string[] {
  if (t.name === 'booking_confirmation' || t.name === 'booking_reminder') return [`confirm:${t.bookingId}`, `reschedule:${t.bookingId}`]
  return []
}

export async function sendWhatsApp(t: Template): Promise<void> {
  if (env.WHATSAPP_PROVIDER === 'log') {
    // Never log OTP codes in production logs.
    const shown = t.name === 'auth_otp' && process.env.NODE_ENV === 'production' ? '[code hidden]' : bodyParams(t).join(' | ')
    console.log(`[whatsapp:${t.name}] to ${t.to.slice(0, 2)}******${t.to.slice(-2)} :: ${shown}`)
    return
  }

  const components: unknown[] = [{ type: 'body', parameters: bodyParams(t).map((text) => ({ type: 'text', text })) }]
  if (t.name === 'auth_otp') components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: t.code }] })
  buttonPayloads(t).forEach((payload, i) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload }] }))

  const res = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: `91${t.to}`,
      type: 'template',
      template: { name: t.name, language: { code: 'en' }, components },
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`WhatsApp send failed (${res.status}): ${body.slice(0, 300)}`)
  }
}

/** Fire-and-forget for non-critical messages: failures are logged, never break the request. */
export function sendLater(t: Template) {
  sendWhatsApp(t).catch((e) => console.error(`[whatsapp:${t.name}]`, e.message))
}
