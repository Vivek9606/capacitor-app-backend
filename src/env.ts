import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.string().default('development'),
  CORS_ORIGINS: z.string().default(''),
  PUBLIC_WEB_URL: z.string().url().default('https://betterhood.in'),
  /** The betterhood.in website (Astro). Directory listings go live at {PUBLIC_SITE_URL}/physio/{slug}/. */
  PUBLIC_SITE_URL: z.string().url().default('https://betterhood.in'),
  /** Where the app's web build runs. Directory profiles on the website link to its booking page. Defaults to PUBLIC_WEB_URL. */
  PUBLIC_APP_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  /** GitHub repo (owner/name) of the website, and a token that may send repository_dispatch to it.
   *  When set, saving a directory listing triggers a website rebuild so it goes live within minutes. */
  SITE_REBUILD_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional().or(z.literal('').transform(() => undefined)),
  SITE_REBUILD_TOKEN: z.string().optional(),
  WHATSAPP_PROVIDER: z.enum(['log', 'meta', 'kwikengage']).default('log'),
  KWIKENGAGE_API_KEY: z.string().optional(),
  KWIKENGAGE_URL: z.string().url().default('https://api.kwikengage.ai/send-message/v2'),
  /** Comma-separated phone numbers. When set, WhatsApp goes only to these; everyone else is logged and skipped. */
  WHATSAPP_ALLOWLIST: z.string().default(''),
  /** Comma-separated template names approved on the provider. When set, other templates are only logged. */
  WHATSAPP_TEMPLATES: z.string().default(''),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  /** LiveKit (video consults). wss://<project>.livekit.cloud plus an API key/secret. Leave empty to turn video off. */
  LIVEKIT_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().optional(),
  LIVEKIT_API_SECRET: z.string().optional(),
  /** Comma-separated phone numbers that can sign in to the admin dashboard (/admin). */
  ADMIN_PHONES: z.string().default(''),
  OTP_DEV_CODE: z
    .string()
    .regex(/^\d{6}$/)
    .optional()
    .or(z.literal('').transform(() => undefined)),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
export const adminPhones = new Set(env.ADMIN_PHONES.split(',').map((s) => s.replace(/\D/g, '').slice(-10)).filter(Boolean))
export const isProd = env.NODE_ENV === 'production'

if (isProd && env.OTP_DEV_CODE) {
  console.warn('WARNING: OTP_DEV_CODE is set in production — anyone can log in as any number. Remove it.')
}
if (env.WHATSAPP_PROVIDER === 'meta' && (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID)) {
  console.error('WHATSAPP_PROVIDER=meta needs WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID')
  process.exit(1)
}
if (env.WHATSAPP_PROVIDER === 'kwikengage' && !env.KWIKENGAGE_API_KEY) {
  console.error('WHATSAPP_PROVIDER=kwikengage needs KWIKENGAGE_API_KEY')
  process.exit(1)
}
