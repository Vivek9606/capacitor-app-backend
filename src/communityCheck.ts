import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI, ThinkingLevel } from '@google/genai'
import { env } from './env.js'

/**
 * Safety check for Community posts, run before anything is published.
 *
 * Physios discuss real cases, which is the point, but a post must never identify a patient. Two layers:
 *  1. Patterns (always on, instant): phone numbers, email addresses, Aadhaar-like numbers.
 *  2. A model (Claude when ANTHROPIC_API_KEY is set, else Gemini): patient names, exact addresses, employers,
 *     anything that would let someone recognise the patient, plus abuse and spam.
 * If the model is unavailable the post goes through on the pattern check alone (it never blocks posting), and
 * the route files it for admin review (`unchecked`).
 */

export type CheckResult = { ok: true; engine: string; unchecked?: boolean } | { ok: false; engine: string; category: string; message: string }

const PHONE = /(?:\+?91[\s-]?)?(?<!\d)[6-9]\d{4}[\s-]?\d{5}(?!\d)/
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/
const AADHAAR = /(?<!\d)\d{4}[\s-]\d{4}[\s-]\d{4}(?!\d)/

function patternCheck(text: string): CheckResult | undefined {
  if (PHONE.test(text) || EMAIL.test(text))
    return { ok: false, engine: 'pattern', category: 'contact_details', message: 'Please remove phone numbers and email addresses. Community posts are visible to every physio on Betterhood.' }
  if (AADHAAR.test(text))
    return { ok: false, engine: 'pattern', category: 'patient_identity', message: 'This looks like an ID number. Please remove it before posting.' }
  return undefined
}

const SYSTEM = `You review posts for a private online forum where licensed physiotherapists in India discuss clinical cases and running a practice.

Decide whether the post can be published. Block it only for these reasons:
- patient_identity: it names a patient or gives details that could identify one: full or first name, exact address or locality plus other details, employer, school, team, a recognisable public figure, a photo description of their face, phone or ID numbers. Age, sex, profession in general terms ("a 34-year-old software engineer"), city, diagnosis, imaging findings and treatment history are fine and expected.
- abusive: insults, harassment or hate aimed at a person or group.
- promotion: mainly an advert or spam (selling products or courses, unrelated links). Mentioning one's own clinic in passing is fine.

Clinical disagreement, frank language about injuries, and questions about money are all fine. When unsure, allow.
If you block, write "message" as one short, friendly sentence telling the author exactly what to change (address them as "you").`

const SCHEMA = {
  type: 'object',
  properties: {
    allow: { type: 'boolean' },
    category: { type: 'string', enum: ['ok', 'patient_identity', 'abusive', 'promotion'] },
    message: { type: 'string' },
  },
  required: ['allow', 'category', 'message'],
  additionalProperties: false,
} as const

function parse(text: string, engine: string): CheckResult {
  const o = JSON.parse(text) as { allow?: unknown; category?: unknown; message?: unknown }
  if (o.allow !== false) return { ok: true, engine }
  const category = typeof o.category === 'string' && o.category !== 'ok' ? o.category : 'other'
  const message = typeof o.message === 'string' && o.message.trim() ? o.message.trim().slice(0, 300) : 'This post can’t be published as written. Please edit it and try again.'
  return { ok: false, engine, category, message }
}

let claude: Anthropic | undefined
async function claudeCheck(text: string): Promise<CheckResult> {
  claude ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 20_000, maxRetries: 1 })
  const res = await claude.beta.messages.create({
    model: env.COMMUNITY_CHECK_MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: `<post>\n${text}\n</post>` }],
  })
  // A safety refusal on a forum post: hold it back rather than publish blind.
  if (res.stop_reason === 'refusal') return { ok: false, engine: 'claude', category: 'other', message: 'This post can’t be published as written. Please edit it and try again.' }
  return parse(res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''), 'claude')
}

let gemini: GoogleGenAI | undefined
async function geminiCheck(text: string): Promise<CheckResult> {
  // A yes/no verdict doesn't need the bigger model: the lite model usually answers in 1-2 seconds.
  // Capped at 12s so nobody waits long; if it fails, the post goes out flagged for admin review.
  gemini ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { timeout: 12_000 } })
  const model = env.GEMINI_FALLBACK_MODEL
  const res = await gemini.models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: `<post>
${text}
</post>` }] }],
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: 'application/json',
      responseJsonSchema: SCHEMA,
      maxOutputTokens: 1000,
      thinkingConfig: model.startsWith('gemini-2') ? { thinkingBudget: 0 } : { thinkingLevel: ThinkingLevel.LOW },
    },
  })
  if (res.promptFeedback?.blockReason) return { ok: false, engine: 'gemini', category: 'other', message: 'This post can’t be published as written. Please edit it and try again.' }
  if (!res.text) throw new Error('community check: empty Gemini response')
  return parse(res.text, 'gemini')
}

export async function checkPost(text: string): Promise<CheckResult> {
  const p = patternCheck(text)
  if (p) return p
  try {
    if (env.ANTHROPIC_API_KEY) return await claudeCheck(text)
    if (env.GEMINI_API_KEY) return await geminiCheck(text)
  } catch (e) {
    console.warn('community check failed, publishing on the pattern check alone:', e instanceof Error ? e.message : e)
    return { ok: true, engine: 'pattern', unchecked: true }
  }
  return { ok: true, engine: 'pattern' }
}
