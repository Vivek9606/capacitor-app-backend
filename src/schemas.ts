import { z } from 'zod'
import { ID_RE } from './util.js'

export const id = z.string().regex(ID_RE, 'Invalid id')
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const hhmm = z.string().regex(/^[0-2]\d:[0-5]\d$/)

export const planItem = z.object({
  exerciseId: z.string().max(60),
  sets: z.number().int().min(1).max(20),
  reps: z.number().int().min(1).max(200),
  holdSec: z.number().int().min(0).max(600).optional(),
  perSide: z.boolean().optional(),
  note: z.string().max(300).optional(),
})

export const rx = z.object({
  diagnosis: z.string().max(300),
  advice: z.string().max(3000),
  modalities: z.array(z.string().max(40)).max(20),
  followUp: z.enum(['1w', '2w', 'custom', 'none']),
  followUpDate: isoDate.optional(),
  autoBook: z.boolean(),
  letterhead: z.boolean(),
})

export const bookingStatus = z.enum(['requested', 'awaiting', 'confirmed', 'reminder_sent', 'reschedule', 'cancelled', 'done'])
export const visitType = z.enum(['in_clinic', 'home_visit', 'teleconsult'])
