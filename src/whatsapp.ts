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
  | { name: 'consent_request'; to: string; patientName: string; physioName: string; formTitle: string; url: string }
  | { name: 'invoice_shared'; to: string; patientName: string; physioName: string; number: string; amount: string; url: string }

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
    case 'consent_request':
      return [t.patientName, t.physioName, t.formTitle, t.url]
    case 'invoice_shared':
      return [t.patientName, t.physioName, t.number, t.amount, t.url]
  }
}

/** Quick-reply buttons carry the booking id so replies can be matched in the webhook. */
function buttonPayloads(t: Template): string[] {
  if (t.name === 'booking_confirmation' || t.name === 'booking_reminder') return [`confirm:${t.bookingId}`, `reschedule:${t.bookingId}`]
  return []
}

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)
const last10 = (phone: string) => phone.replace(/\D/g, '').slice(-10)
const allowlist = new Set(list(env.WHATSAPP_ALLOWLIST).map(last10))
const enabledTemplates = new Set(list(env.WHATSAPP_TEMPLATES))

function logOnly(t: Template, reason: string) {
  // Never log OTP codes in production logs.
  const shown = t.name === 'auth_otp' && process.env.NODE_ENV === 'production' ? '[code hidden]' : bodyParams(t).join(' | ')
  console.log(`[whatsapp:${t.name}] ${reason} to ${t.to.slice(0, 2)}******${t.to.slice(-2)} :: ${shown}`)
}

export async function sendWhatsApp(t: Template): Promise<void> {
  if (env.WHATSAPP_PROVIDER === 'log') return logOnly(t, 'logged')
  if (allowlist.size > 0 && !allowlist.has(last10(t.to))) return logOnly(t, 'skipped (not in WHATSAPP_ALLOWLIST)')
  if (enabledTemplates.size > 0 && !enabledTemplates.has(t.name)) return logOnly(t, 'skipped (not in WHATSAPP_TEMPLATES)')

  if (env.WHATSAPP_PROVIDER === 'kwikengage') return sendKwikEngage(t)

  const res = await fetch(`https://graph.facebook.com/v21.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: `91${t.to}`,
      type: 'template',
      template: { name: t.name, language: { code: 'en' }, components: components(t) },
    }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`WhatsApp send failed (${res.status}): ${body.slice(0, 300)}`)
  }
}

/** Meta-format template components: body variables {{1}}, {{2}}… plus any buttons. Used by both providers. */
function components(t: Template): unknown[] {
  const c: unknown[] = [{ type: 'body', parameters: bodyParams(t).map((text) => ({ type: 'text', text })) }]
  if (t.name === 'auth_otp') c.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: t.code }] })
  buttonPayloads(t).forEach((payload, i) => c.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload }] }))
  return c
}

/**
 * KwikEngage (GoKwik) send API. The raw API key goes in the Authorization header (no "Bearer").
 * Verified with care_plan_shared (body variables). Button components use Meta's format and are
 * untested on KwikEngage: test each button template before adding it to WHATSAPP_TEMPLATES.
 * KwikEngage returns 201 even for payloads it can't use, so a "success" here is not proof of delivery.
 */
async function sendKwikEngage(t: Template): Promise<void> {
  const res = await fetch(env.KWIKENGAGE_URL, {
    method: 'POST',
    headers: { Authorization: env.KWIKENGAGE_API_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: `91${last10(t.to)}`,
      channel: 'whatsapp',
      type: 'template',
      content: { type: 'template', template: { template_id: t.name, language: 'en', components: components(t) } },
    }),
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`KwikEngage send failed (${res.status}): ${body.slice(0, 300)}`)
  console.log(`[whatsapp:${t.name}] sent via KwikEngage to ${t.to.slice(0, 2)}******${t.to.slice(-2)} :: ${body.slice(0, 200)}`)
}

/** Fire-and-forget for non-critical messages: failures are logged, never break the request. */
export function sendLater(t: Template) {
  sendWhatsApp(t).catch((e) => console.error(`[whatsapp:${t.name}]`, e.message))
}
