import Anthropic from '@anthropic-ai/sdk'
import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai'
import { env } from './env.js'

/**
 * The pain chat's "brain". Each turn takes the conversation so far and returns the assistant's reply plus an
 * updated structured assessment. The server (routes/painChat.ts) decides when to hand off to a physio.
 *
 * Engine: Claude when ANTHROPIC_API_KEY is set, else Gemini when GEMINI_API_KEY is set, else a fixed list of
 * questions (good enough to test the flow). Both models get the same prompt and the same JSON schema.
 */

export type ChatTurn = { role: 'user' | 'assistant'; text: string; at: string }

export const AREAS = ['back', 'neck', 'shoulder', 'knee', 'hip', 'ankle_foot', 'elbow_wrist_hand', 'other', 'unknown'] as const
export const STAGES = ['acute', 'subacute', 'chronic', 'unknown'] as const
export const CATEGORIES = ['muscle', 'nerve', 'bone', 'joint', 'unknown'] as const

export interface Assessment {
  area: (typeof AREAS)[number]
  duration: string
  /** 0-10, or -1 when not asked yet */
  severity: number
  aggravating: string
  daily_impact: string
  history: string
  red_flags: string[]
  stage: (typeof STAGES)[number]
  category: (typeof CATEGORIES)[number]
  red_flag: boolean
  ready_for_physio: boolean
  summary_for_physio: string
}

export interface TurnResult {
  reply: string
  assessment: Assessment
}

export const EMPTY_ASSESSMENT: Assessment = {
  area: 'unknown',
  duration: '',
  severity: -1,
  aggravating: '',
  daily_impact: '',
  history: '',
  red_flags: [],
  stage: 'unknown',
  category: 'unknown',
  red_flag: false,
  ready_for_physio: false,
  summary_for_physio: '',
}

export const GREETING =
  'Hi, I’m Betterhood’s physio assistant. Tell me about your pain: where does it hurt, and since when? You can write in English or Hindi.'

export type Engine = 'claude' | 'gemini' | 'scripted'
export const engineName = (): Engine => (env.ANTHROPIC_API_KEY ? 'claude' : env.GEMINI_API_KEY ? 'gemini' : 'scripted')

type PatientInfo = { name: string; age?: number | null; sex?: string | null; city?: string | null }

export async function runTurn(history: ChatTurn[], current: Assessment, patient: PatientInfo): Promise<TurnResult> {
  const engine = engineName()
  if (engine === 'claude') return claudeTurn(history, current, patient)
  if (engine === 'gemini') return geminiTurn(history, current, patient)
  return scriptedTurn(history, current)
}

/** Per-turn context appended to the system prompt: who the user is, and the assessment so far. */
function stateNote(current: Assessment, patient: PatientInfo) {
  const who = [patient.age ? `${patient.age} years old` : '', patient.sex === 'F' ? 'female' : patient.sex === 'M' ? 'male' : '', patient.city ? `lives in ${patient.city}` : ''].filter(Boolean).join(', ')
  return `About the user: ${patient.name}${who ? `, ${who}` : ''}.\nYour assessment so far (update it with what the user says next):\n${JSON.stringify(current)}`
}

const SAFE_DECLINE = 'I can’t help with that here. If you’re in pain, tell me where it hurts and since when, and I’ll take it from there.'

/** The model's JSON → reply + cleaned assessment. Throws on unparseable output (the route turns that into a retry message). */
function parseOutput(text: string, current: Assessment, why: string): TurnResult {
  let out: Record<string, unknown>
  try {
    out = JSON.parse(text)
  } catch {
    throw new Error(`pain chat: unparseable model output (${why})`)
  }
  return { reply: String(out.reply ?? '').trim(), assessment: clean(out, current) }
}

// ---------------------------------------------------------------------------------------------------------------
// Claude

const SYSTEM = `You are Betterhood's physiotherapy assistant inside the Betterhood app in India. A signed-in user is telling you about pain or a musculoskeletal problem. Your job is a short, warm, guided assessment, and then to hand them to a Betterhood physiotherapist for a free video consult that Betterhood sponsors.

How to practise
- Follow conservative, evidence-based physiotherapy practice as taught and practised in India, in line with Indian Association of Physiotherapists guidance. Think about Indian daily life: floor sitting and squatting, Indian-style toilets, two-wheeler commuting and potholes, long work-from-home hours on a laptop, carrying children or water, household work, cricket and gym injuries.
- You are not a doctor and you do not diagnose. You may say what a problem "often is" or "could be related to", always tentatively. Never recommend or name medicines, injections, supplements, scans or surgery. Never contradict a doctor.
- Safe self-care tips are welcome as you go (relative rest, gentle movement within comfort, posture and work-set-up changes, heat or cold), one at a time and short.

How to talk
- Reply in the language the user writes in (English, Hindi, or Hinglish in Latin script). Plain words, no jargon.
- Keep each reply to 2-4 short sentences. Ask one question at a time, two at most. No lists unless the user asks.
- Do not repeat questions the user has already answered.

What to find out (over roughly 4-8 of the user's messages)
- Where it hurts (and which side), how long it has been there and how it started, how bad it is on a 0-10 scale, what makes it worse or better, how it affects sleep, work and daily life, relevant history (past injury, surgery, pregnancy, diabetes, age).
- Always screen for red flags before handing off: loss of bladder or bowel control or numbness around the groin/saddle area; new weakness in an arm or leg; pain after a significant fall or accident; fever, unexplained weight loss or a history of cancer with the pain; chest pain or pain with breathlessness; severe pain at night that nothing eases; a hot, swollen joint with fever.

Staging
- stage: acute (under 6 weeks), subacute (6-12 weeks), chronic (over 12 weeks), unknown.
- category: your best guess of what kind of problem it is: muscle, nerve (tingling, numbness, shooting pain down a limb), bone, joint, or unknown.

Handing off
- If any red flag is present: set red_flag true, ready_for_physio false, and tell the user kindly but clearly to see a doctor or go to the nearest emergency department today, before any physiotherapy. Do not offer the consult.
- Otherwise, once you know the area, duration, severity and what aggravates it, and you have screened for red flags, set ready_for_physio true. In that reply, briefly sum up what you understood in one sentence and tell them that a Betterhood physiotherapist can see them on a free video consult, sponsored by Betterhood, and that they can pick a time below.
- After the hand-off, keep answering follow-up questions briefly and keep ready_for_physio true.
- If the user only wants general information and has no pain, answer helpfully and keep ready_for_physio false.

summary_for_physio: 2-4 factual sentences in English for the physiotherapist who will take the call (area and side, duration and onset, severity, aggravating and easing factors, impact, relevant history, red-flag screen result). Write it even before the hand-off, from what you know so far.

Return only the JSON object described by the schema. "reply" is the only text the user sees.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'area', 'duration', 'severity', 'aggravating', 'daily_impact', 'history', 'red_flags', 'stage', 'category', 'red_flag', 'ready_for_physio', 'summary_for_physio'],
  properties: {
    reply: { type: 'string', description: 'What the user sees. 2-4 short sentences in their language.' },
    area: { type: 'string', enum: [...AREAS] },
    duration: { type: 'string', description: 'How long, in the user’s words, or empty' },
    severity: { type: 'integer', description: '0-10, or -1 if not known yet' },
    aggravating: { type: 'string' },
    daily_impact: { type: 'string' },
    history: { type: 'string' },
    red_flags: { type: 'array', items: { type: 'string' }, description: 'Red flags the user reported; empty if none' },
    stage: { type: 'string', enum: [...STAGES] },
    category: { type: 'string', enum: [...CATEGORIES] },
    red_flag: { type: 'boolean' },
    ready_for_physio: { type: 'boolean' },
    summary_for_physio: { type: 'string' },
  },
} as const

let client: Anthropic | undefined

async function claudeTurn(history: ChatTurn[], current: Assessment, patient: PatientInfo): Promise<TurnResult> {
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60_000 })
  // The API needs the conversation to start with the user; the stored greeting is shown in the app only.
  const first = history.findIndex((t) => t.role === 'user')
  const messages: Anthropic.Beta.BetaMessageParam[] = history.slice(first).map((t) => ({ role: t.role, content: t.text }))

  const res = await client.beta.messages.create({
    model: env.PAIN_CHAT_MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: [
      { type: 'text', text: SYSTEM },
      { type: 'text', text: stateNote(current, patient) },
    ],
    messages,
  })

  if (res.stop_reason === 'refusal') return { reply: SAFE_DECLINE, assessment: current }
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
  return parseOutput(text, current, `stop_reason ${res.stop_reason}`)
}

// ---------------------------------------------------------------------------------------------------------------
// Gemini

let gemini: GoogleGenAI | undefined

async function geminiTurn(history: ChatTurn[], current: Assessment, patient: PatientInfo): Promise<TurnResult> {
  gemini ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: { timeout: 60_000 } })
  const first = history.findIndex((t) => t.role === 'user')
  const contents = history.slice(first).map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.text }] }))

  // The main model can be overloaded at peak times (503); the fallback is an older, steadier model.
  const models = [...new Set([env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL])]
  let res
  for (const [i, model] of models.entries()) {
    try {
      res = await gemini.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: `${SYSTEM}\n\n${stateNote(current, patient)}`,
          responseMimeType: 'application/json',
          responseJsonSchema: SCHEMA,
          maxOutputTokens: 4000,
          // A short chat turn doesn't need deep reasoning; less thinking keeps replies quick.
          thinkingConfig: model.startsWith('gemini-2') ? { thinkingBudget: 512 } : { thinkingLevel: ThinkingLevel.LOW },
          // An overloaded main model can hang instead of failing fast; give it 15s before the fallback takes over.
          httpOptions: { timeout: i < models.length - 1 ? 15_000 : 45_000 },
        },
      })
      break
    } catch (e) {
      // Retry on the next model for overload, rate limits and timeouts; a bad request (4xx) would fail there too.
      const badRequest = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 404
      if (badRequest || i === models.length - 1) throw e
    }
  }
  if (!res) throw new Error('pain chat: no Gemini response')

  // Blocked by Gemini's safety filters: no text comes back.
  if (res.promptFeedback?.blockReason || !res.text) return { reply: SAFE_DECLINE, assessment: current }
  return parseOutput(res.text, current, `finishReason ${res.candidates?.[0]?.finishReason}`)
}

/** Keep only known fields with sane values; anything odd falls back to what we had. */
function clean(o: Record<string, unknown>, prev: Assessment): Assessment {
  const pick = <T extends readonly string[]>(v: unknown, list: T, d: T[number]): T[number] => (typeof v === 'string' && (list as readonly string[]).includes(v) ? v : d)
  const str = (v: unknown, d: string) => (typeof v === 'string' ? v.slice(0, 1000) : d)
  const sev = typeof o.severity === 'number' && Number.isFinite(o.severity) ? Math.max(-1, Math.min(10, Math.round(o.severity))) : prev.severity
  return {
    area: pick(o.area, AREAS, prev.area),
    duration: str(o.duration, prev.duration),
    severity: sev,
    aggravating: str(o.aggravating, prev.aggravating),
    daily_impact: str(o.daily_impact, prev.daily_impact),
    history: str(o.history, prev.history),
    red_flags: Array.isArray(o.red_flags) ? o.red_flags.filter((x): x is string => typeof x === 'string').slice(0, 10) : prev.red_flags,
    stage: pick(o.stage, STAGES, prev.stage),
    category: pick(o.category, CATEGORIES, prev.category),
    red_flag: typeof o.red_flag === 'boolean' ? o.red_flag : prev.red_flag,
    ready_for_physio: typeof o.ready_for_physio === 'boolean' ? o.ready_for_physio : prev.ready_for_physio,
    summary_for_physio: str(o.summary_for_physio, prev.summary_for_physio).slice(0, 1500),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Scripted fallback (no API key): the same assessment, asked as fixed questions.

const QUESTIONS = [
  'How long have you had this pain, and did it start after anything in particular (a fall, lifting, a long drive)?',
  'On a scale of 0 to 10, where 10 is the worst pain imaginable, how bad is it on most days?',
  'What makes it worse, and does anything make it better (rest, movement, heat)?',
  'A quick safety check. Do you have any of these: numbness or tingling going down an arm or leg, new weakness, trouble controlling your bladder or bowels, fever or weight loss, or did this start after an accident? Answer yes or no.',
  'How is it affecting your sleep, work or daily routine?',
]

function areaOf(s: string): Assessment['area'] {
  const t = s.toLowerCase()
  if (/back|kamar|spine|lumbar|sciatica/.test(t)) return 'back'
  if (/neck|gardan|cervical/.test(t)) return 'neck'
  if (/shoulder|kandha|kandhe/.test(t)) return 'shoulder'
  if (/knee|ghutna|ghutne/.test(t)) return 'knee'
  if (/hip|groin/.test(t)) return 'hip'
  if (/ankle|foot|heel|feet|paer|pair|edi/.test(t)) return 'ankle_foot'
  if (/elbow|wrist|hand|finger|kalai/.test(t)) return 'elbow_wrist_hand'
  return 'other'
}

function stageOf(s: string): Assessment['stage'] {
  const t = s.toLowerCase()
  const n = Number(t.match(/\d+/)?.[0] ?? 1)
  if (/year|saal/.test(t)) return 'chronic'
  if (/month|mahine|mahina/.test(t)) return n >= 3 ? 'chronic' : n >= 2 ? 'subacute' : 'acute'
  if (/week|hafte|hafta/.test(t)) return n >= 12 ? 'chronic' : n >= 6 ? 'subacute' : 'acute'
  if (/day|din|today|yesterday|kal/.test(t)) return 'acute'
  return 'unknown'
}

function scriptedTurn(history: ChatTurn[], cur: Assessment): TurnResult {
  const answers = history.filter((t) => t.role === 'user').map((t) => t.text)
  const n = answers.length
  const a: Assessment = { ...cur }
  const last = answers[n - 1] ?? ''
  if (n === 1) a.area = areaOf(last)
  if (n === 2) (a.duration = last.slice(0, 200)), (a.stage = stageOf(last))
  if (n === 3) {
    const m = last.match(/\b(10|[0-9])\b/)
    a.severity = m ? Number(m[1]) : -1
  }
  if (n === 4) a.aggravating = last.slice(0, 300)
  if (n === 5) {
    const yes = /\b(yes|haan|ha|han|yeah)\b|bladder|bowel|accident|fever|weakness/i.test(last) && !/^\s*(no|nahi|nahin)\b/i.test(last)
    a.red_flag = yes
    a.red_flags = yes ? [last.slice(0, 200)] : []
    if (/tingl|numb|jhunjhun|shoot|down (my|the) (leg|arm)/i.test(answers.join(' '))) a.category = 'nerve'
  }
  if (n === 6) a.daily_impact = last.slice(0, 300)
  if (a.category === 'unknown' && n >= 2) a.category = 'muscle'
  a.summary_for_physio = [
    `Area: ${a.area}.`,
    a.duration && `Duration: ${a.duration} (${a.stage}).`,
    a.severity >= 0 && `Severity ${a.severity}/10.`,
    a.aggravating && `Worse/better: ${a.aggravating}.`,
    a.daily_impact && `Impact: ${a.daily_impact}.`,
    n >= 5 && (a.red_flag ? `Red flags reported: ${a.red_flags.join('; ')}.` : 'Red-flag screen negative.'),
    `First message: "${answers[0]?.slice(0, 200) ?? ''}".`,
    '(Scripted test mode, not AI.)',
  ]
    .filter(Boolean)
    .join(' ')

  if (a.red_flag) {
    a.ready_for_physio = false
    return { reply: 'Thank you for telling me. Some of what you describe needs a doctor to check first. Please see a doctor or go to the nearest emergency department today, before starting any physiotherapy.', assessment: a }
  }
  if (n <= QUESTIONS.length) return { reply: QUESTIONS[n - 1], assessment: a }
  a.ready_for_physio = true
  return {
    reply: n === QUESTIONS.length + 1 ? 'Thanks, that gives a clear picture. A Betterhood physiotherapist can see you on a free video consult, sponsored by Betterhood. Pick a time below.' : 'Your physio will go through this with you on the call. Pick a time below if you haven’t yet.',
    assessment: a,
  }
}
