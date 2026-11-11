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
  // Consultation (step 1 of the plan flow)
  complaint: z.string().max(1000).optional(),
  findings: z.string().max(2000).optional(),
  diagnosis: z.string().max(300),
  advice: z.string().max(3000),
  modalities: z.array(z.string().max(40)).max(20),
  followUp: z.enum(['1w', '2w', 'custom', 'none']),
  followUpDate: isoDate.optional(),
  autoBook: z.boolean(),
  letterhead: z.boolean(),
})

export const bookingStatus = z.enum(['requested', 'awaiting', 'confirmed', 'reminder_sent', 'reschedule', 'checked_in', 'no_show', 'cancelled', 'done'])
export const visitType = z.enum(['in_clinic', 'home_visit', 'teleconsult'])

const day = z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
export const timeRange = z.object({ start: hhmm, end: hhmm }).refine((r) => r.start < r.end, 'Start must be before end')

export const practice = z.object({
  modes: z.array(z.enum(['clinic', 'home', 'individual'])).min(1).max(3),
  serviceArea: z.string().trim().max(200).optional(),
  travelBufferMin: z.number().int().min(0).max(180).optional(),
  locations: z
    .array(z.object({ id: z.string().max(40), name: z.string().trim().min(1).max(120), address: z.string().trim().max(300), days: z.array(day).max(7) }))
    .max(10)
    .optional(),
})

export const availability = z.object({
  weekly: z.record(day, z.array(timeRange).max(6)),
  slotStepMin: z.number().int().min(5).max(120),
  bufferMin: z.number().int().min(0).max(120),
  minNoticeHours: z.number().int().min(0).max(168),
  maxDaysAhead: z.number().int().min(1).max(180),
})

export const billing = z.object({
  upiId: z.string().trim().regex(/^[\w.-]{2,64}@[a-zA-Z]{2,64}$/, 'Invalid UPI id').optional().or(z.literal('')),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{15}$/, 'GSTIN has 15 characters').optional().or(z.literal('')),
  invoicePrefix: z.string().trim().regex(/^[A-Za-z0-9-]{1,10}$/),
  taxPct: z.number().min(0).max(28),
  footer: z.string().max(300).optional(),
})

export const invoiceItem = z.object({
  description: z.string().trim().min(1).max(120),
  qty: z.number().int().min(1).max(100),
  rate: z.number().int().min(0).max(1_000_000),
})
export const paymentMethod = z.enum(['cash', 'upi', 'card', 'bank', 'other'])

/** Same maths as the app (lib/invoices.ts), recomputed on the server so totals can't be tampered with. */
export function invoiceTotal(items: { qty: number; rate: number }[], discount: number, taxPct: number) {
  const sub = items.reduce((s, i) => s + i.qty * i.rate, 0)
  const afterDiscount = Math.max(0, sub - discount)
  return afterDiscount + Math.round((afterDiscount * taxPct) / 100)
}

export const signature = z.object({
  signedName: z.string().trim().min(2).max(80),
  signature: z.string().startsWith('data:image/png;base64,').max(200_000).optional(),
  guardian: z.string().trim().max(80).optional(),
})
