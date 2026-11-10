import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import Fastify from 'fastify'
import { ZodError } from 'zod'
import { pool } from './db.js'
import { env, isProd } from './env.js'
import { startReminderJob } from './jobs/reminders.js'
import { authRoutes } from './routes/auth.js'
import { meRoutes } from './routes/me.js'
import { patientRoutes } from './routes/patient.js'
import { physioRoutes } from './routes/physio.js'
import { practiceRoutes } from './routes/practice.js'
import { publicRoutes } from './routes/public.js'
import { webhookRoutes } from './routes/webhook.js'
import { adminRoutes } from './routes/admin.js'
import { HttpError } from './util.js'

const app = Fastify({
  logger: { level: isProd ? 'info' : 'warn', redact: ['req.headers.authorization'] },
  bodyLimit: 1_000_000, // profile photos are sent as small data URLs
  trustProxy: true, // DigitalOcean's load balancer sets X-Forwarded-For (rate limits use the real IP)
})

// Web origins from env + Capacitor's native WebView origins.
const origins = new Set([
  ...env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  'capacitor://localhost',
  'http://localhost',
  'https://localhost',
])
await app.register(cors, {
  origin: (origin, cb) => cb(null, !origin || origins.has(origin)),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  maxAge: 86400,
})
await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' })

app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message })
  if (err instanceof ZodError) {
    const first = err.issues[0]
    return reply.code(400).send({ error: 'invalid', message: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request' })
  }
  const status = err.statusCode
  if (status && status < 500) return reply.code(status).send({ error: 'request_error', message: err.message })
  req.log.error(err)
  return reply.code(500).send({ error: 'server_error', message: 'Something went wrong. Please try again.' })
})

app.get('/', async () => ({ name: 'Betterhood API', status: 'running', health: '/health' }))

app.get('/health', async () => {
  await pool.query('select 1')
  return { ok: true }
})

await app.register(authRoutes)
await app.register(meRoutes)
await app.register(physioRoutes)
await app.register(practiceRoutes)
await app.register(patientRoutes)
await app.register(publicRoutes)
await app.register(webhookRoutes)
await app.register(adminRoutes)

startReminderJob()

await app.listen({ port: env.PORT, host: '0.0.0.0' })
console.log(`Betterhood API on :${env.PORT}`)

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    await app.close()
    await pool.end()
    process.exit(0)
  })
}
