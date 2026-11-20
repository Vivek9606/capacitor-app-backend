import { createHmac } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../auth.js'
import { one, q } from '../db.js'
import {
  CONFIRM_SUBJECT,
  confirmContent,
  emailAllowed,
  emailConfig,
  type EmailContent,
  esc,
  type OutEmail,
  personalise,
  renderEmail,
  type SendResult,
  sendEmails,
} from '../email.js'
import { CTA_JPG_BASE64, HERO_JPG_BASE64, LOGO_CREAM_PNG_BASE64, MARK_PNG_BASE64 } from '../emailArt.js'
import { LOGO_PNG_BASE64 } from '../emailLogo.js'
import { env } from '../env.js'
import { badRequest, linkToken, newId, notFound, safeEqual } from '../util.js'

/**
 * The email newsletter.
 *
 * Public (website): POST /public/newsletter/subscribe → confirmation email (double opt-in) → GET/POST
 * /public/newsletter/confirm → subscribed + welcome email. Every newsletter email has a one-click unsubscribe
 * (/public/newsletter/unsubscribe, also sent as the List-Unsubscribe header).
 *
 * Admin: subscribers, the welcome email, and issues (write, preview, send a test, send to everyone).
 * Resend reports delivery, bounces and spam complaints to POST /webhooks/resend.
 */

type Row = Record<string, any>

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(160)
const shortText = (n: number) => z.string().trim().max(n)
const url = z.string().trim().max(1000).regex(/^(https?:\/\/|mailto:)/i, 'Links must start with https://')
const block = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), heading: shortText(160).optional(), body: shortText(6000) }),
  z.object({ type: z.literal('article'), label: shortText(40).optional(), title: shortText(200), summary: shortText(800).optional(), url, image: url.optional().or(z.literal('')), cta: shortText(40).optional() }),
  z.object({ type: z.literal('tip'), heading: shortText(80).optional(), body: shortText(2000) }),
  z.object({ type: z.literal('quote'), text: shortText(600), by: shortText(80).optional() }),
  z.object({ type: z.literal('steps'), heading: shortText(160).optional(), items: shortText(3000) }),
  z.object({ type: z.literal('image'), src: url, alt: shortText(200).optional(), caption: shortText(200).optional(), url: url.optional().or(z.literal('')) }),
  z.object({ type: z.literal('cta'), heading: shortText(120), body: shortText(1000).optional(), text: shortText(60), url }),
  z.object({ type: z.literal('button'), text: shortText(60), url }),
  z.object({ type: z.literal('divider') }),
])
const content = z.object({
  eyebrow: shortText(40).optional(),
  headline: shortText(200),
  intro: shortText(6000).optional(),
  blocks: z.array(block).max(30),
  signoff: shortText(300).optional(),
})
const issueBody = z.object({ subject: shortText(200), preheader: shortText(200).default(''), content })

// ---------- defaults ----------
const site = () => env.PUBLIC_SITE_URL.replace(/\/$/, '')

function welcomeDefault(): { subject: string; preheader: string; content: EmailContent } {
  return {
    subject: 'Welcome to the betterhood letter',
    preheader: 'What to expect, and one small habit to start today.',
    content: {
      eyebrow: 'Welcome',
      headline: 'Welcome to the betterhood letter',
      intro:
        'Hi {{first_name}}, thanks for confirming.\n\nEvery couple of weeks we’ll send you one short letter from our physios: what helps with everyday aches, how to move better at work and at home, and the research worth knowing about.\n\nNo spam, and you can unsubscribe with one click at the bottom of any email.',
      blocks: [
        { type: 'steps', heading: 'What you’ll get', items: 'One short letter every couple of weeks, written by our physios\nSimple fixes for everyday aches: back, neck, knees and shoulders\nThe research worth knowing about, minus the jargon' },
        { type: 'tip', heading: 'Start here', body: 'If you sit for work, set a reminder to stand up and move for a minute **every 30 minutes**. Small, regular breaks do more for a stiff back and neck than one long stretch at the end of the day.' },
        { type: 'cta', heading: 'Not sure where your pain is coming from?', body: 'Our free pain assessment takes about 3 minutes. You’ll get a clear picture of what might be going on and what to do next.', text: 'Take the free assessment', url: `${site()}/quiz-landing-page/` },
      ],
      signoff: 'Move well,\nThe betterhood physio team',
    },
  }
}

export function starterIssue(): { subject: string; preheader: string; content: EmailContent } {
  return {
    subject: 'Your back, your desk and one 2-minute fix',
    preheader: 'This fortnight: easy wins for desk-bound backs.',
    content: {
      eyebrow: 'The betterhood letter',
      headline: 'Easy wins for desk-bound backs',
      intro: 'Hi {{first_name}},\n\nA short note on what we’ve been talking about with patients, and the reads worth your time.',
      blocks: [
        { type: 'article', label: 'Read', title: 'Article title goes here', summary: 'One or two lines on why it’s worth reading.', url: `${site()}/learn/`, image: '', cta: 'Read the article' },
        { type: 'article', label: 'Guide', title: 'A second article', summary: 'With two or more articles, an “In this letter” list appears at the top.', url: `${site()}/learn/`, image: '', cta: 'Read the guide' },
        { type: 'tip', heading: 'Physio tip', body: 'One practical thing readers can do today.' },
        { type: 'steps', heading: 'A 2-minute desk reset', items: 'Stand up and roll your shoulders back five times\nTuck your chin gently and hold for five seconds\nReach both arms overhead and take three slow breaths' },
        { type: 'quote', text: 'Motion is lotion. The best posture is your next one.', by: 'The betterhood physio team' },
        { type: 'cta', heading: 'Still sore after a week?', body: 'Take our free 3-minute pain assessment and see what might be going on.', text: 'Take the free pain assessment', url: `${site()}/quiz-landing-page/` },
      ],
      signoff: 'Move well,\nThe betterhood physio team',
    },
  }
}

async function welcomeRow(): Promise<Row> {
  const w = await one(`select * from newsletter_issues where kind = 'welcome'`)
  if (w && +new Date(w.updated_at) === +new Date(w.created_at)) {
    // Never edited in admin: keep it in step with the current default.
    const d = welcomeDefault()
    if (JSON.stringify(w.content) !== JSON.stringify(d.content) || w.subject !== d.subject || w.preheader !== d.preheader) {
      return (await one(`update newsletter_issues set subject = $2, preheader = $3, content = $4 where id = $1 returning *`, [w.id, d.subject, d.preheader, d.content]))!
    }
  }
  if (w) return w
  const d = welcomeDefault()
  await q(`insert into newsletter_issues (id, kind, subject, preheader, content) values ($1, 'welcome', $2, $3, $4) on conflict do nothing`, [newId('nl'), d.subject, d.preheader, d.content])
  return (await one(`select * from newsletter_issues where kind = 'welcome'`))!
}

// ---------- links ----------
function apiBase(req: FastifyRequest) {
  return (env.PUBLIC_API_URL ?? `${req.protocol}://${req.host}`).replace(/\/$/, '')
}
const links = (base: string, s: Row) => ({
  confirmUrl: `${base}/public/newsletter/confirm?t=${s.confirm_token}`,
  unsubUrl: `${base}/public/newsletter/unsubscribe?t=${s.unsub_token}`,
})

function render(row: { subject: string; preheader: string; content: EmailContent }, base: string, footer: 'newsletter' | 'confirm', meta?: string) {
  return { subject: row.subject, ...renderEmail(row.content, { subject: row.subject, preheader: row.preheader, assetBase: base, siteUrl: site(), footer, meta }) }
}

/** Masthead label for an issue: "No. 3 · November 2026" (numbered by send order; a draft gets the next number). */
async function issueMeta(row?: Row | null): Promise<string | undefined> {
  if (row?.kind === 'welcome') return undefined
  const at = row?.sent_at ? new Date(row.sent_at) : new Date()
  const r = await one<{ n: number }>(
    `select count(*)::int as n from newsletter_issues where kind = 'issue' and status = 'sent' and sent_at is not null and sent_at < $1 and id <> $2`,
    [at, row?.id ?? ''],
  )
  return `No. ${(r?.n ?? 0) + 1} · ${at.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}`
}

async function record(kind: 'confirm' | 'welcome' | 'issue' | 'test', issueId: string | null, subscriberId: string | null, to: string, r: SendResult) {
  await q(
    `insert into newsletter_sends (id, kind, issue_id, subscriber_id, email, provider_id, status, error) values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict do nothing`,
    [newId('ns'), kind, issueId, subscriberId, to, r.status === 'sent' ? r.id : null, r.status, r.status === 'sent' ? null : r.error],
  )
}

// ---------- the three automatic emails ----------
async function sendConfirm(s: Row, base: string) {
  const c = render({ subject: CONFIRM_SUBJECT, preheader: 'Confirm your email to start getting the betterhood letter.', content: confirmContent() }, base, 'confirm')
  const l = links(base, s)
  const [r] = await sendEmails([{ to: s.email, subject: c.subject, html: personalise(c.html, { firstName: s.name, ...l }, true), text: personalise(c.text, { firstName: s.name, ...l }, false), tags: { kind: 'confirm' } }])
  await record('confirm', null, s.id, s.email, r)
  await q('update newsletter_subscribers set confirm_sent_at = now() where id = $1', [s.id])
  return r
}

async function sendWelcome(s: Row, base: string) {
  const w = await welcomeRow()
  const c = render(w as any, base, 'newsletter', await issueMeta(w))
  const l = links(base, s)
  const [r] = await sendEmails([{ to: s.email, subject: c.subject, html: personalise(c.html, { firstName: s.name, ...l }, true), text: personalise(c.text, { firstName: s.name, ...l }, false), unsubUrl: l.unsubUrl, tags: { kind: 'welcome' } }])
  await record('welcome', w.id, s.id, s.email, r)
  // Only a real send counts, so a welcome skipped in test mode still goes out once sending is switched on.
  if (r.status === 'sent') await q('update newsletter_subscribers set welcome_sent_at = now(), last_sent_at = now() where id = $1', [s.id])
  return r
}

/** Sends an issue to every subscribed address that hasn't had it yet. Resumable: each address is recorded once. */
async function sendIssue(issueId: string, base: string) {
  const issue = await one('select * from newsletter_issues where id = $1', [issueId])
  if (!issue) return
  const c = render(issue as any, base, 'newsletter', await issueMeta(issue))
  for (;;) {
    const subs = await q(
      `select * from newsletter_subscribers s where status = 'subscribed'
         and not exists (select 1 from newsletter_sends x where x.issue_id = $1 and x.subscriber_id = s.id and x.kind = 'issue')
       order by created_at limit 100`,
      [issueId],
    )
    if (!subs.length) break
    const msgs: OutEmail[] = subs.map((s) => {
      const l = links(base, s)
      return { to: s.email, subject: c.subject, html: personalise(c.html, { firstName: s.name, ...l }, true), text: personalise(c.text, { firstName: s.name, ...l }, false), unsubUrl: l.unsubUrl, tags: { kind: 'issue', issue: issueId } }
    })
    const results = await sendEmails(msgs, `nl-${issueId}-${subs[0].id}`)
    for (let i = 0; i < subs.length; i++) {
      await record('issue', issueId, subs[i].id, subs[i].email, results[i])
      if (results[i].status === 'sent') await q('update newsletter_subscribers set last_sent_at = now() where id = $1', [subs[i].id])
    }
  }
  await q(`update newsletter_issues set status = 'sent', sent_at = now() where id = $1`, [issueId])
}

// ---------- subscribing ----------
async function subscribe(b: { email: string; name?: string; source?: string; page?: string }, base: string) {
  const ex = await one('select * from newsletter_subscribers where email = $1', [b.email])
  if (ex?.status === 'subscribed') {
    if (b.name && !ex.name) await q('update newsletter_subscribers set name = $2 where id = $1', [ex.id, b.name])
    return { sub: ex, sent: false }
  }
  // Don't send the confirmation again if one went out in the last 2 minutes (double clicks, bots).
  if (ex?.status === 'pending' && ex.confirm_sent_at && Date.now() - new Date(ex.confirm_sent_at).getTime() < 120_000) return { sub: ex, sent: false }
  const s = ex
    ? await one(`update newsletter_subscribers set status = 'pending', name = coalesce($2, name) where id = $1 returning *`, [ex.id, b.name || null])
    : await one(
        `insert into newsletter_subscribers (id, email, name, source, page, confirm_token, unsub_token) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (email) do update set name = coalesce(excluded.name, newsletter_subscribers.name) returning *`,
        [newId('sb'), b.email, b.name || null, b.source || null, b.page || null, linkToken(), linkToken()],
      )
  const r = await sendConfirm(s!, base)
  return { sub: s!, sent: r.status === 'sent', result: r }
}

// ---------- small branded pages for confirm / unsubscribe ----------
function page(reply: FastifyReply, title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · betterhood</title><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Figtree:wght@400;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbf7f1;font-family:Figtree,system-ui,sans-serif;color:#240c2c;padding:24px 16px}
.c{width:100%;max-width:480px;background:#fff;border:1px solid #ead6e5;border-radius:24px;padding:36px 32px;text-align:center}
img{display:block;margin:0 auto 28px}h1{font-family:'Bricolage Grotesque',Figtree,sans-serif;font-size:28px;line-height:1.2;margin:0 0 12px;letter-spacing:-.4px}
p{color:#5b4a5e;font-size:16px;line-height:1.6;margin:0 0 20px}
.b{display:inline-block;border:0;cursor:pointer;background:#5e1951;color:#fff;font:700 16px Figtree,system-ui,sans-serif;padding:15px 28px;border-radius:999px;text-decoration:none}
.l{display:inline-block;margin-top:6px;color:#7a2a6c;font-weight:700;text-decoration:none}form{margin:0}
</style></head><body><main class="c"><a href="${esc(site())}"><img src="/email/logo.png" width="160" alt="betterhood"></a>${body}</main></body></html>`
  return reply.code(status).type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(html)
}
const expired = (reply: FastifyReply) =>
  page(reply, 'Link expired', `<h1>This link has expired</h1><p>It may already have been used. If you'd like the betterhood letter, sign up again on our website.</p><a class="b" href="${esc(site())}/learn/">Go to betterhood</a>`, 404)

// ---------- Resend webhook signature (Svix) ----------
function verifySvix(req: FastifyRequest): boolean {
  const secret = env.RESEND_WEBHOOK_SECRET
  if (!secret) return false
  const id = String(req.headers['svix-id'] ?? '')
  const ts = String(req.headers['svix-timestamp'] ?? '')
  const sigs = String(req.headers['svix-signature'] ?? '')
  if (!id || !ts || !sigs || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${(req as any).rawBody ?? ''}`).digest('base64')
  return sigs.split(' ').some((s) => safeEqual(s.split(',')[1] ?? '', expected))
}

// ---------- mapping for admin ----------
const subOut = (s: Row) => ({
  id: s.id,
  email: s.email,
  name: s.name ?? undefined,
  status: s.status,
  source: s.source ?? undefined,
  page: s.page ?? undefined,
  createdAt: s.created_at,
  confirmedAt: s.confirmed_at ?? undefined,
  unsubscribedAt: s.unsubscribed_at ?? undefined,
  lastSentAt: s.last_sent_at ?? undefined,
  welcomeSentAt: s.welcome_sent_at ?? undefined,
  allowed: emailAllowed(s.email),
})
const issueOut = (r: Row) => ({
  id: r.id,
  kind: r.kind,
  subject: r.subject,
  preheader: r.preheader,
  content: r.content,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  testSentAt: r.test_sent_at ?? undefined,
  sendStartedAt: r.send_started_at ?? undefined,
  sentAt: r.sent_at ?? undefined,
})
const STATS_SQL = `select issue_id,
    count(*)::int total,
    count(*) filter (where status in ('sent','delivered','delayed','bounced','complained'))::int sent,
    count(*) filter (where status = 'delivered')::int delivered,
    count(*) filter (where status = 'skipped')::int skipped,
    count(*) filter (where status = 'failed')::int failed,
    count(*) filter (where status = 'bounced')::int bounced,
    count(*) filter (where status = 'complained')::int complained
  from newsletter_sends where kind = 'issue' group by issue_id`

export async function newsletterRoutes(app: FastifyInstance) {
  // Raw body for the webhook signature; forms (one-click unsubscribe, the confirm button) as plain key/values.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    ;(req as any).rawBody = body
    try {
      done(null, body ? JSON.parse(body as string) : {})
    } catch (e) {
      done(e as Error, undefined)
    }
  })
  app.addContentTypeParser(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'], { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(String(body))))
    } catch {
      done(null, {})
    }
  })

  // The logo the emails and pages show (inline PNG; email clients don't show SVG).
  const logo = Buffer.from(LOGO_PNG_BASE64, 'base64')
  app.get('/email/logo.png', async (_req, reply) => reply.type('image/png').header('Cache-Control', 'public, max-age=604800').send(logo))
  // Template artwork (cached for a long time; regenerate under a new name if it changes).
  const art = { 'hero.jpg': ['image/jpeg', HERO_JPG_BASE64], 'cta.jpg': ['image/jpeg', CTA_JPG_BASE64], 'logo-cream.png': ['image/png', LOGO_CREAM_PNG_BASE64], 'mark.png': ['image/png', MARK_PNG_BASE64] } as const
  for (const [file, [type, b64]] of Object.entries(art)) {
    const buf = Buffer.from(b64, 'base64')
    app.get(`/email/${file}`, async (_req, reply) => reply.type(type).header('Cache-Control', 'public, max-age=2592000').send(buf))
  }

  // ----- public -----
  app.post('/public/newsletter/subscribe', { config: { rateLimit: { max: 8, timeWindow: '1 hour' } } }, async (req) => {
    const b = z
      .object({ email, name: shortText(80).optional(), source: shortText(60).optional(), page: shortText(300).optional(), website: z.string().optional() })
      .parse(req.body ?? {})
    if (b.website) return { ok: true } // honeypot
    await subscribe({ email: b.email, name: b.name || undefined, source: b.source || 'website', page: b.page }, apiBase(req))
    // Same answer whether or not they were already subscribed (doesn't reveal who's on the list).
    return { ok: true, message: 'Almost there: check your inbox and tap the link to confirm.' }
  })

  // GET shows a page that confirms with a POST, so email scanners that open links can't subscribe anyone.
  app.get('/public/newsletter/confirm', async (req, reply) => {
    const t = String((req.query as Row).t ?? '')
    const s = t && (await one('select * from newsletter_subscribers where confirm_token = $1', [t]))
    if (!s) return expired(reply)
    if (s.status === 'subscribed') return page(reply, 'You’re subscribed', `<h1>You’re already in</h1><p>${esc(s.email)} is subscribed to the betterhood letter.</p><a class="b" href="${esc(site())}/learn/">Read the latest</a>`)
    return page(
      reply,
      'Confirm your subscription',
      `<h1>Confirm your subscription</h1><p>Tap below to start getting the betterhood letter at <b>${esc(s.email)}</b>.</p>
<form method="post" id="f"><button class="b" type="submit">Yes, subscribe me</button></form>
<script>document.getElementById('f').submit()</script>`,
    )
  })
  app.post('/public/newsletter/confirm', async (req, reply) => {
    const t = String((req.query as Row).t ?? '')
    const s = t && (await one('select * from newsletter_subscribers where confirm_token = $1', [t]))
    if (!s) return expired(reply)
    const done = await one(
      `update newsletter_subscribers set status = 'subscribed', confirmed_at = coalesce(confirmed_at, now()), unsubscribed_at = null
        where id = $1 and status <> 'subscribed' returning *`,
      [s.id],
    )
    if (done && !done.welcome_sent_at) await sendWelcome(done, apiBase(req)).catch((e) => req.log.error(e))
    return page(
      reply,
      'You’re subscribed',
      `<h1>You’re in${s.name ? `, ${esc(String(s.name).split(' ')[0])}` : ''}!</h1><p>Your welcome email is on its way to <b>${esc(s.email)}</b>. Look out for the betterhood letter every couple of weeks.</p><a class="b" href="${esc(site())}/learn/">Read the latest articles</a>`,
    )
  })

  app.get('/public/newsletter/unsubscribe', async (req, reply) => {
    const t = String((req.query as Row).t ?? '')
    if (t === 'test') return page(reply, 'Test email', `<h1>This was a test email</h1><p>Unsubscribe links in test emails don't do anything.</p>`)
    const s = t && (await one('select * from newsletter_subscribers where unsub_token = $1', [t]))
    if (!s) return expired(reply)
    if (s.status === 'unsubscribed') return page(reply, 'Unsubscribed', `<h1>You’re unsubscribed</h1><p>${esc(s.email)} won't get the betterhood letter any more.</p>`)
    return page(reply, 'Unsubscribe', `<h1>Unsubscribe?</h1><p>You'll stop getting the betterhood letter at <b>${esc(s.email)}</b>.</p><form method="post"><button class="b" type="submit">Unsubscribe me</button></form>`)
  })
  // Also the one-click unsubscribe target (RFC 8058): mail apps POST "List-Unsubscribe=One-Click" here.
  app.post('/public/newsletter/unsubscribe', async (req, reply) => {
    const t = String((req.query as Row).t ?? '')
    if (t === 'test') return page(reply, 'Test email', `<h1>This was a test email</h1><p>Nothing to unsubscribe from.</p>`)
    const s = t && (await one('select * from newsletter_subscribers where unsub_token = $1', [t]))
    if (!s) return expired(reply)
    await q(`update newsletter_subscribers set status = 'unsubscribed', unsubscribed_at = now() where id = $1 and status in ('subscribed', 'pending')`, [s.id])
    return page(
      reply,
      'Unsubscribed',
      `<h1>You’re unsubscribed</h1><p>${esc(s.email)} won't get the betterhood letter any more. Sorry to see you go.</p>${
        s.confirmed_at ? `<form method="post" action="/public/newsletter/resubscribe?t=${esc(t)}"><button class="l" style="background:none;border:0;cursor:pointer;font:inherit;font-weight:700" type="submit">Clicked by mistake? Resubscribe</button></form>` : ''
      }`,
    )
  })
  app.post('/public/newsletter/resubscribe', async (req, reply) => {
    const t = String((req.query as Row).t ?? '')
    const s = t && (await one(`update newsletter_subscribers set status = 'subscribed', unsubscribed_at = null where unsub_token = $1 and confirmed_at is not null returning *`, [t]))
    if (!s) return expired(reply)
    return page(reply, 'Resubscribed', `<h1>Welcome back</h1><p>${esc(s.email)} is subscribed to the betterhood letter again.</p>`)
  })

  // ----- Resend webhook -----
  app.post('/webhooks/resend', async (req, reply) => {
    if (!env.RESEND_WEBHOOK_SECRET) return reply.code(503).send({ error: 'webhook not configured' })
    if (!verifySvix(req)) return reply.code(401).send({ error: 'bad signature' })
    const ev = req.body as { type?: string; data?: { email_id?: string; bounce?: { type?: string } } }
    const pid = ev?.data?.email_id
    if (!pid) return { ok: true }
    const map: Record<string, string> = { 'email.delivered': 'delivered', 'email.delivery_delayed': 'delayed', 'email.bounced': 'bounced', 'email.complained': 'complained' }
    const status = map[ev.type ?? '']
    if (!status) return { ok: true }
    // Delivered/delayed never overwrite a bounce or complaint that arrived first.
    const sends = await q(
      `update newsletter_sends set status = $2, updated_at = now()
        where provider_id = $1 and ($2 in ('bounced','complained') or status in ('sent','delayed')) returning subscriber_id`,
      [pid, status],
    )
    const hard = status === 'complained' || (status === 'bounced' && (ev.data?.bounce?.type ?? 'Permanent') === 'Permanent')
    if (hard)
      for (const x of sends)
        if (x.subscriber_id) await q(`update newsletter_subscribers set status = $2 where id = $1 and status in ('subscribed','pending')`, [x.subscriber_id, status])
    return { ok: true }
  })

  // ----- admin -----
  app.get('/admin/newsletter', async (req) => {
    requireRole(req, 'admin')
    await welcomeRow()
    const [subs, issues, stats] = await Promise.all([
      q('select * from newsletter_subscribers order by created_at desc limit 5000'),
      q('select * from newsletter_issues order by (kind = \'welcome\') desc, created_at desc'),
      q(STATS_SQL),
    ])
    const byIssue = new Map(stats.map((s) => [s.issue_id, s]))
    const counts = { pending: 0, subscribed: 0, unsubscribed: 0, bounced: 0, complained: 0 } as Record<string, number>
    for (const s of subs) counts[s.status] = (counts[s.status] ?? 0) + 1
    return {
      config: emailConfig(),
      counts,
      subscribers: subs.map(subOut),
      issues: issues.map((r) => ({ ...issueOut(r), stats: byIssue.get(r.id) ?? null })),
      generatedAt: new Date().toISOString(),
    }
  })

  app.get('/admin/newsletter/issues/:id', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params)
    const r = await one('select * from newsletter_issues where id = $1', [id])
    if (!r) throw notFound('Issue not found')
    const sends = await q(`select id, kind, email, status, error, created_at, updated_at from newsletter_sends where issue_id = $1 order by created_at desc limit 500`, [id])
    return { issue: issueOut(r), sends: sends.map((s) => ({ id: s.id, kind: s.kind, email: s.email, status: s.status, error: s.error ?? undefined, at: s.updated_at })) }
  })

  app.post('/admin/newsletter/issues', async (req) => {
    const by = requireRole(req, 'admin')
    const b = z.object({ copyFrom: z.string().max(40).optional() }).parse(req.body ?? {})
    const src = b.copyFrom ? await one('select subject, preheader, content from newsletter_issues where id = $1', [b.copyFrom]) : undefined
    const d = src ? { subject: src.subject, preheader: src.preheader, content: src.content } : starterIssue()
    const r = await one(`insert into newsletter_issues (id, kind, subject, preheader, content, created_by) values ($1, 'issue', $2, $3, $4, $5) returning *`, [newId('nl'), d.subject, d.preheader, d.content, by])
    return { issue: issueOut(r!) }
  })

  app.put('/admin/newsletter/issues/:id', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params)
    const b = issueBody.parse(req.body)
    const r = await one(
      `update newsletter_issues set subject = $2, preheader = $3, content = $4, updated_at = now() where id = $1 and (status = 'draft' or kind = 'welcome') returning *`,
      [id, b.subject, b.preheader, b.content],
    )
    if (!r) throw badRequest('This issue has been sent, so it can’t be changed. Duplicate it to send a new version.')
    return { issue: issueOut(r) }
  })

  app.delete('/admin/newsletter/issues/:id', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params)
    const r = await one(`delete from newsletter_issues where id = $1 and kind = 'issue' and status = 'draft' returning id`, [id])
    if (!r) throw badRequest('Only drafts can be deleted.')
    return { ok: true }
  })

  /** Renders unsaved editor content (or the confirmation email) for the live preview. */
  app.post('/admin/newsletter/preview', async (req) => {
    requireRole(req, 'admin')
    const b = z.object({ kind: z.enum(['issue', 'welcome', 'confirm']).default('issue'), id: z.string().max(40).optional(), subject: shortText(200).default(''), preheader: shortText(200).default(''), content: content.optional() }).parse(req.body ?? {})
    const base = apiBase(req)
    const meta = b.kind === 'confirm' ? undefined : await issueMeta(b.kind === 'welcome' ? { kind: 'welcome' } : b.id ? await one('select id, kind, sent_at from newsletter_issues where id = $1', [b.id]) : null)
    const c =
      b.kind === 'confirm'
        ? render({ subject: CONFIRM_SUBJECT, preheader: '', content: confirmContent() }, base, 'confirm')
        : render({ subject: b.subject, preheader: b.preheader, content: b.content ?? { headline: '', blocks: [] } }, base, 'newsletter', meta)
    const v = { unsubUrl: `${base}/public/newsletter/unsubscribe?t=test`, confirmUrl: '#' }
    return { subject: c.subject, html: personalise(c.html, v, true), text: personalise(c.text, v, false) }
  })

  /** Sends one email (an issue, the welcome or the confirmation) to test addresses, marked [Test]. */
  app.post('/admin/newsletter/test', async (req) => {
    requireRole(req, 'admin')
    const b = z.object({ kind: z.enum(['issue', 'welcome', 'confirm']), id: z.string().max(40).optional(), to: z.array(email).max(5).optional() }).parse(req.body ?? {})
    const to = b.to?.length ? b.to : emailConfig().testTo
    if (!to.length) throw badRequest('Enter an email address to send the test to.')
    const base = apiBase(req)
    let issueId: string | null = null
    let c
    if (b.kind === 'confirm') c = render({ subject: CONFIRM_SUBJECT, preheader: 'Confirm your email to start getting the betterhood letter.', content: confirmContent() }, base, 'confirm')
    else {
      const r = b.kind === 'welcome' ? await welcomeRow() : await one('select * from newsletter_issues where id = $1', [b.id])
      if (!r) throw notFound('Issue not found')
      issueId = r.id
      c = render(r as any, base, 'newsletter', await issueMeta(r))
    }
    const v = { firstName: undefined, unsubUrl: `${base}/public/newsletter/unsubscribe?t=test`, confirmUrl: `${base}/public/newsletter/confirm?t=test` }
    const results = await sendEmails(to.map((t) => ({ to: t, subject: `[Test] ${c.subject}`, html: personalise(c.html, v, true), text: personalise(c.text, v, false), tags: { kind: 'test' } })))
    for (let i = 0; i < to.length; i++) await record('test', issueId, null, to[i], results[i])
    if (issueId) await q('update newsletter_issues set test_sent_at = now() where id = $1', [issueId])
    return { results: to.map((t, i) => ({ to: t, ...results[i] })) }
  })

  /** Sends an issue to every subscriber. Runs in the background; the admin screen refreshes to show progress. */
  app.post('/admin/newsletter/issues/:id/send', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params)
    // Claim it (a send stuck for 10+ minutes, e.g. after a restart, can be resumed).
    const r = await one(
      `update newsletter_issues set status = 'sending', send_started_at = now()
        where id = $1 and kind = 'issue' and (status = 'draft' or (status = 'sending' and send_started_at < now() - interval '10 minutes')) returning *`,
      [id],
    )
    if (!r) throw badRequest('This issue is already sending or has been sent.')
    if (!r.subject.trim() || !r.content?.headline?.trim()) {
      await q(`update newsletter_issues set status = 'draft', send_started_at = null where id = $1`, [id])
      throw badRequest('Add a subject and a headline first.')
    }
    const audience = await one<{ n: number }>(`select count(*)::int n from newsletter_subscribers where status = 'subscribed'`)
    const base = apiBase(req)
    sendIssue(id, base).catch((e) => req.log.error(e, 'newsletter send failed'))
    return { ok: true, audience: audience?.n ?? 0 }
  })

  app.post('/admin/newsletter/subscribers', async (req) => {
    requireRole(req, 'admin')
    const b = z.object({ email, name: shortText(80).optional() }).parse(req.body ?? {})
    const r = await subscribe({ email: b.email, name: b.name || undefined, source: 'admin' }, apiBase(req))
    const s = await one('select * from newsletter_subscribers where id = $1', [r.sub.id])
    return { subscriber: subOut(s!), confirmSent: r.sent, note: r.result && r.result.status !== 'sent' ? r.result.error : undefined }
  })

  app.post('/admin/newsletter/subscribers/:id/resend-confirm', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params)
    const s = await one(`select * from newsletter_subscribers where id = $1`, [id])
    if (!s) throw notFound('Subscriber not found')
    if (s.status !== 'pending') throw badRequest('Only people waiting to confirm can be sent the confirmation again.')
    const r = await sendConfirm(s, apiBase(req))
    return { result: r }
  })

  /** Admin can unsubscribe someone (e.g. they asked by email). Nobody is deleted. */
  app.post('/admin/newsletter/subscribers/:id/unsubscribe', async (req) => {
    requireRole(req, 'admin')
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params)
    const s = await one(`update newsletter_subscribers set status = 'unsubscribed', unsubscribed_at = now() where id = $1 and status in ('subscribed','pending') returning *`, [id])
    if (!s) throw badRequest('Already not subscribed.')
    return { subscriber: subOut(s) }
  })
}
