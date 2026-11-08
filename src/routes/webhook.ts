import { createHmac } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { q } from '../db.js'
import { env } from '../env.js'
import { safeEqual } from '../util.js'

/**
 * Meta WhatsApp Cloud API webhook.
 * GET  = subscription verification. POST = incoming events; we act on quick-reply
 * buttons from booking messages (payload "confirm:<id>" / "reschedule:<id>").
 */
export async function webhookRoutes(app: FastifyInstance) {
  // Keep the raw body for signature checks.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    ;(req as any).rawBody = body
    try {
      done(null, body ? JSON.parse(body as string) : {})
    } catch (e) {
      done(e as Error, undefined)
    }
  })

  app.get('/webhooks/whatsapp', async (req, reply) => {
    const qs = req.query as Record<string, string>
    if (env.WHATSAPP_VERIFY_TOKEN && qs['hub.mode'] === 'subscribe' && qs['hub.verify_token'] === env.WHATSAPP_VERIFY_TOKEN) {
      return reply.type('text/plain').send(qs['hub.challenge'])
    }
    return reply.code(403).send('forbidden')
  })

  app.post('/webhooks/whatsapp', async (req, reply) => {
    if (!env.WHATSAPP_APP_SECRET) return reply.code(503).send({ error: 'webhook not configured' })
    const sig = String(req.headers['x-hub-signature-256'] ?? '')
    const expected = 'sha256=' + createHmac('sha256', env.WHATSAPP_APP_SECRET).update((req as any).rawBody ?? '').digest('hex')
    if (!safeEqual(sig, expected)) return reply.code(401).send({ error: 'bad signature' })

    const body = req.body as any
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        for (const msg of change?.value?.messages ?? []) {
          const payload: string | undefined = msg?.button?.payload ?? msg?.interactive?.button_reply?.id
          const from = String(msg?.from ?? '').replace(/^91/, '')
          const m = payload?.match(/^(confirm|reschedule):([a-z]{1,3}_[a-z0-9]{6,24})$/)
          if (!m) continue
          const status = m[1] === 'confirm' ? 'confirmed' : 'reschedule'
          // Only the number the booking was made for can change it, and only while it's open.
          await q(
            "update bookings set status = $2 where id = $1 and patient_phone = $3 and status in ('awaiting','confirmed','reminder_sent','reschedule')",
            [m[2], status, from],
          )
        }
      }
    }
    return { ok: true }
  })
}
