// Slouch Catcher's photo check: Gemini rates four zones and writes a short note. The server, not the AI, then
// picks the posture animal (personas.ts) and the products (products.ts). Photos are only held in memory.
import { GoogleGenAI, ThinkingLevel } from '@google/genai'
import { env } from '../env.js'
import { HttpError } from '../util.js'
import { PERSONAS } from './personas.js'

export interface RawResult {
  verdict: 'rated' | 'unclear'
  neck: number
  shoulder: number
  back: number
  knee: number
  summary: string
  issues: string[]
  setting: string
  demo?: boolean
}

const PROMPT = `You are a friendly physiotherapist-style posture assessor for "Slouch Catcher", a fun posture-awareness app by betterhood (an Indian back & joint care brand).

Look at the photo and assess the posture of the main person in it.

Rate four zones from 1 to 9 (never 10). 8-9 strong, 6-7 decent, 4-5 weak, 1-3 poor:
- neck: ears roughly over shoulders. Low if the head juts forward, droops down at a phone/laptop ("tech neck") or is pulled into the shoulders.
- shoulder: relaxed and back. Low if rounded forward, collapsed inward or hunched up to the ears.
- back: upper back not excessively rounded, lower back with a natural curve. Low if slumped/C-shaped when sitting, over-arched or leaning when standing, or the spine tilts to one side.
- knee: knees in line with hips and feet, feet grounded. Low if knees cave inward, splay out, are locked/hyperextended, or legs are tucked or twisted under the chair. If the knees are not visible, judge from the hips and thighs; use 6 only if there is truly nothing to go on.
Use the full range honestly; most people have at least one weak zone.

Rules:
- verdict "unclear" if there is no person, the body is not visible enough to judge (e.g. only a close-up face), or the image is not a real photo of a person. Do not guess. Otherwise "rated".
- summary: exactly 2-3 short sentences, second person ("you"/"your"), warm and lightly playful, never insulting about body shape, weight, age, clothing or appearance. Mention what you actually see and include one quick fix they can do right now for their weakest zone. Write like a person texting a friend: plain words, no em dashes or en dashes, no semicolons.
- issues: up to 3 very short labels of what is wrong (e.g. "Forward head", "Rounded shoulders"). Empty if nothing is wrong or the verdict is unclear.
- setting: where the person is: "desk_chair", "sofa_or_bed", "car", "standing", "floor", or "other".

Respond with JSON only.`

const ZONE_KEYS = ['neck', 'shoulder', 'back', 'knee'] as const
const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['rated', 'unclear'] },
    ...Object.fromEntries(ZONE_KEYS.map((k) => [k, { type: 'integer', minimum: 1, maximum: 9 }])),
    summary: { type: 'string' },
    issues: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    setting: { type: 'string', enum: ['desk_chair', 'sofa_or_bed', 'car', 'standing', 'floor', 'other'] },
  },
  required: ['verdict', ...ZONE_KEYS, 'summary', 'issues', 'setting'],
}

/** Test mode (SLOUCH_TEST_MODE) or no Gemini key: an instant sample animal, no AI call. */
export const slouchDemo = () => env.SLOUCH_TEST_MODE || !env.GEMINI_API_KEY

const DEMO_ISSUES: Record<string, string> = { N: 'Forward head', S: 'Rounded shoulders', B: 'Slumped back', K: 'Knees out of line' }
function demo(): RawResult {
  const { zones } = PERSONAS[Math.floor(Math.random() * PERSONAS.length)]
  const weakest = Object.entries(zones).sort((a, b) => a[1] - b[1])
  return {
    verdict: 'rated', neck: zones.N, shoulder: zones.S, back: zones.B, knee: zones.K,
    summary: 'This is a test result, so no AI looked at the photo. In real use you would get two or three sentences about your posture here, plus one quick fix to try right now.',
    issues: weakest.filter(([, v]) => v <= 5).slice(0, 3).map(([k]) => DEMO_ISSUES[k]),
    setting: 'desk_chair',
    demo: true,
  }
}

let gemini: GoogleGenAI | undefined
export async function analysePhoto(mime: string, base64: string): Promise<RawResult> {
  if (slouchDemo()) return demo()
  gemini ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { timeout: 45_000 } })
  // SLOUCH_GEMINI_MODEL first (default: the lite model, ~2s a photo; the full Flash model took ~23s in testing),
  // then the other model if it's overloaded or fails.
  const first = env.SLOUCH_GEMINI_MODEL || env.GEMINI_FALLBACK_MODEL
  const models = [...new Set([first, first === env.GEMINI_MODEL ? env.GEMINI_FALLBACK_MODEL : env.GEMINI_MODEL].filter(Boolean))]
  let last: unknown
  for (const model of models) {
    try {
      const res = await gemini.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data: base64 } }, { text: PROMPT }] }],
        config: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseJsonSchema: SCHEMA,
          // Scoring a photo is quick visual judgement: minimal thinking keeps the wait short.
          thinkingConfig: model.startsWith('gemini-2') ? { thinkingBudget: 0 } : { thinkingLevel: ThinkingLevel.MINIMAL },
        },
      })
      if (res.promptFeedback?.blockReason) throw new HttpError(422, "The AI couldn't process this photo. Please try a different one.", 'photo_blocked')
      if (!res.text) throw new Error('empty response')
      const m = res.text.match(/\{[\s\S]*\}/)
      return JSON.parse(m ? m[0] : res.text) as RawResult
    } catch (e) {
      if (e instanceof HttpError) throw e
      last = e
      console.warn(`[slouch] ${model} failed:`, e instanceof Error ? e.message : e)
    }
  }
  const msg = String((last as Error)?.message ?? '')
  if (/429|quota|rate/i.test(msg)) throw new HttpError(429, 'Our posture AI is a bit busy right now. Please try again in a minute.', 'ai_busy')
  throw new HttpError(502, 'The posture AI could not analyse this photo. Please try again.', 'ai_failed')
}
