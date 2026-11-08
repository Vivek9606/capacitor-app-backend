import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  PORT: z.coerce.number().default(8080),
  NODE_ENV: z.string().default('development'),
  CORS_ORIGINS: z.string().default(''),
  PUBLIC_WEB_URL: z.string().url().default('https://betterhood.in'),
  WHATSAPP_PROVIDER: z.enum(['log', 'meta']).default('log'),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_APP_SECRET: z.string().optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
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
export const isProd = env.NODE_ENV === 'production'

if (isProd && env.OTP_DEV_CODE) {
  console.warn('WARNING: OTP_DEV_CODE is set in production — anyone can log in as any number. Remove it.')
}
if (env.WHATSAPP_PROVIDER === 'meta' && (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID)) {
  console.error('WHATSAPP_PROVIDER=meta needs WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID')
  process.exit(1)
}
