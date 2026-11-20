import { env } from './env.js'
import { LOGO_SIZE } from './emailLogo.js'

/**
 * Email for the newsletter: one branded template (renderEmail) and sending through Resend (sendEmails).
 *
 * The template is table-based with inline styles so it holds up in Gmail, Outlook and Apple Mail. Colours and
 * type follow the website (plum, cream, sun). Content is a small set of blocks the admin editor can produce;
 * body text supports blank-line paragraphs, **bold** and [links](https://...).
 *
 * Personal bits are placeholders filled per recipient: %%FIRST_NAME%%, %%UNSUB_URL%%, %%CONFIRM_URL%%.
 */

// ---------- content model (shared with the admin editor) ----------
export type Block =
  | { type: 'text'; heading?: string; body: string }
  | { type: 'article'; label?: string; title: string; summary?: string; url: string; image?: string; cta?: string }
  | { type: 'tip'; heading?: string; body: string }
  | { type: 'button'; text: string; url: string }
  | { type: 'divider' }

export interface EmailContent {
  eyebrow?: string
  headline: string
  intro?: string
  blocks: Block[]
  signoff?: string
}

export const PH = { firstName: '%%FIRST_NAME%%', unsub: '%%UNSUB_URL%%', confirm: '%%CONFIRM_URL%%' } as const

// ---------- brand ----------
const C = {
  page: '#fbf7f1',
  card: '#ffffff',
  line: '#ead6e5',
  ink: '#240c2c',
  soft: '#5b4a5e',
  mute: '#85758a',
  plum: '#5e1951',
  plumMid: '#7a2a6c',
  plumSoft: '#f5eaf2',
  sun: '#fff4e2',
  sunLine: '#ffe5bd',
  sunInk: '#8a5a00',
}
const DISPLAY = `'Bricolage Grotesque','Figtree',Helvetica,Arial,sans-serif`
const BODY = `'Figtree',Helvetica,Arial,sans-serif`

// ---------- text helpers ----------
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const safeUrl = (u: string) => (/^(https?:|mailto:|%%)/i.test(u.trim()) ? u.trim() : '#')
const name = (s: string) => s.replace(/\{\{\s*first_name\s*\}\}/gi, PH.firstName)

/** Paragraphs, **bold**, [text](url) and line breaks → HTML. Everything else is escaped. */
function rich(src: string, style: string): string {
  return name(src)
    .trim()
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .map((p) => {
      let h = esc(p.trim())
      h = h.replace(/\*\*(.+?)\*\*/g, `<strong style="color:${C.ink};font-weight:700">$1</strong>`)
      h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${esc(safeUrl(u.replace(/&amp;/g, '&')))}" style="color:${C.plumMid};text-decoration:underline">${t}</a>`)
      h = h.replace(/\n/g, '<br>')
      return `<p style="margin:0 0 16px;${style}">${h}</p>`
    })
    .join('')
}
/** Same text, plain: links become "text (url)". */
function plain(src: string): string {
  return name(src)
    .trim()
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
}

const P = `font-family:${BODY};font-size:16px;line-height:1.65;color:${C.soft}`

function button(text: string, url: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px"><tr><td bgcolor="${C.plum}" style="border-radius:999px">
<a href="${esc(safeUrl(url))}" style="display:inline-block;padding:15px 30px;font-family:${BODY};font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px">${esc(text)}&nbsp;&rarr;</a>
</td></tr></table>`
}

function blockHtml(b: Block): string {
  switch (b.type) {
    case 'text':
      return `${b.heading ? `<h2 style="margin:8px 0 12px;font-family:${DISPLAY};font-size:21px;line-height:1.3;font-weight:700;color:${C.ink}">${esc(name(b.heading))}</h2>` : ''}${rich(b.body, P)}`
    case 'article': {
      const url = esc(safeUrl(b.url))
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid ${C.line};border-radius:16px;border-collapse:separate;overflow:hidden">
${b.image ? `<tr><td style="padding:0"><a href="${url}"><img src="${esc(safeUrl(b.image))}" width="518" alt="" style="display:block;width:100%;max-width:518px;height:auto;border:0;border-radius:16px 16px 0 0"></a></td></tr>` : ''}
<tr><td style="padding:20px 22px 22px">
${b.label ? `<p style="margin:0 0 8px;font-family:${BODY};font-size:12px;line-height:1;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${C.plumMid}">${esc(b.label)}</p>` : ''}
<a href="${url}" style="font-family:${DISPLAY};font-size:19px;line-height:1.3;font-weight:700;color:${C.ink};text-decoration:none">${esc(b.title)}</a>
${b.summary ? `<p style="margin:8px 0 0;font-family:${BODY};font-size:15px;line-height:1.6;color:${C.soft}">${esc(name(b.summary))}</p>` : ''}
<p style="margin:14px 0 0"><a href="${url}" style="font-family:${BODY};font-size:15px;font-weight:700;color:${C.plum};text-decoration:none">${esc(b.cta || 'Read the article')}&nbsp;&rarr;</a></p>
</td></tr></table>`
    }
    case 'tip':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px"><tr><td bgcolor="${C.sun}" style="padding:20px 22px 6px;border:1px solid ${C.sunLine};border-radius:16px">
<p style="margin:0 0 8px;font-family:${BODY};font-size:12px;line-height:1;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${C.sunInk}">&#10022;&nbsp; ${esc(b.heading || 'Physio tip')}</p>
${rich(b.body, `font-family:${BODY};font-size:16px;line-height:1.6;color:${C.ink}`)}
</td></tr></table>`
    case 'button':
      return button(b.text, b.url)
    case 'divider':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 28px"><tr><td style="border-top:1px solid ${C.line};font-size:0;line-height:0">&nbsp;</td></tr></table>`
  }
}

function blockText(b: Block): string {
  switch (b.type) {
    case 'text':
      return `${b.heading ? `${plain(b.heading).toUpperCase()}\n\n` : ''}${plain(b.body)}`
    case 'article':
      return `${b.label ? `${b.label.toUpperCase()}: ` : ''}${b.title}\n${b.summary ? `${plain(b.summary)}\n` : ''}${b.url}`
    case 'tip':
      return `${(b.heading || 'Physio tip').toUpperCase()}\n${plain(b.body)}`
    case 'button':
      return `${b.text}: ${b.url}`
    case 'divider':
      return '----'
  }
}

export interface RenderOpts {
  subject: string
  preheader?: string
  /** Absolute URL of the logo image. */
  logoUrl: string
  siteUrl: string
  /** Footer: 'newsletter' shows why they get it + unsubscribe; 'confirm' shows the ignore-if-not-you note. */
  footer: 'newsletter' | 'confirm'
}

/** The full email, as HTML and plain text. Placeholders (PH) are left in for per-recipient filling. */
export function renderEmail(content: EmailContent, o: RenderOpts): { html: string; text: string } {
  const site = o.siteUrl.replace(/\/$/, '')
  const pre = o.preheader?.trim() ?? ''
  const body = (content.blocks ?? []).map(blockHtml).join('\n')
  const signoff = content.signoff?.trim()
  const footer =
    o.footer === 'newsletter'
      ? `You're getting this because you subscribed to the betterhood letter at <a href="${esc(site)}" style="color:${C.mute};text-decoration:underline">betterhood.in</a>.<br>
<a href="${PH.unsub}" style="color:${C.mute};text-decoration:underline">Unsubscribe</a> any time, with one click.`
      : `If you didn't ask to join, just ignore this email. You won't hear from us again.`

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(o.subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Figtree:wght@400;700&display=swap" rel="stylesheet">
<style>
  body { margin:0; padding:0; background:${C.page}; }
  a { color:${C.plumMid}; }
  @media (max-width:620px) {
    .wrap { padding:16px 12px 32px !important; }
    .card { padding:28px 22px 12px !important; border-radius:20px !important; }
    .h1 { font-size:28px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(name(pre))}${'&#847;&zwnj;&nbsp;'.repeat(60)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.page}" style="background:${C.page}">
<tr><td align="center" class="wrap" style="padding:32px 16px 48px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
    <tr><td style="padding:0 8px 22px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="left" valign="middle"><a href="${esc(site)}"><img src="${esc(o.logoUrl)}" width="${LOGO_SIZE.width}" height="${LOGO_SIZE.height}" alt="betterhood" style="display:block;border:0"></a></td>
        <td align="right" valign="middle" style="font-family:${BODY};font-size:13px;color:${C.mute}">The betterhood letter</td>
      </tr></table>
    </td></tr>
    <tr><td class="card" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-radius:24px;padding:40px 40px 16px">
      ${content.eyebrow ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 18px"><tr><td bgcolor="${C.plumSoft}" style="border-radius:999px;padding:7px 14px;font-family:${BODY};font-size:12px;line-height:1;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${C.plum}">${esc(content.eyebrow)}</td></tr></table>` : ''}
      <h1 class="h1" style="margin:0 0 18px;font-family:${DISPLAY};font-size:32px;line-height:1.18;font-weight:700;letter-spacing:-.5px;color:${C.ink}">${esc(name(content.headline || o.subject))}</h1>
      ${content.intro ? rich(content.intro, P) : ''}
      ${body}
      ${signoff ? `<p style="margin:8px 0 24px;${P}">${esc(name(signoff)).replace(/\n/g, '<br>')}</p>` : ''}
    </td></tr>
    <tr><td align="center" style="padding:28px 24px 0;font-family:${BODY};font-size:13px;line-height:1.6;color:${C.mute}">
      ${footer}
      <br><br><span style="color:${C.ink};font-weight:700">betterhood</span> &middot; Physio-backed care for pain-free movement
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`

  const text = [
    plain(content.headline || o.subject),
    content.intro ? plain(content.intro) : '',
    ...(content.blocks ?? []).map(blockText),
    signoff ? plain(signoff) : '',
    o.footer === 'newsletter' ? `You're getting this because you subscribed at betterhood.in.\nUnsubscribe: ${PH.unsub}` : `If you didn't ask to join, ignore this email.`,
  ]
    .filter(Boolean)
    .join('\n\n')

  return { html, text }
}

/** Fill the per-recipient placeholders. */
export function personalise(s: string, v: { firstName?: string | null; unsubUrl?: string; confirmUrl?: string }, html: boolean) {
  const fn = (v.firstName || '').trim().split(/\s+/)[0] || 'there'
  return s
    .replaceAll(PH.firstName, html ? esc(fn) : fn)
    .replaceAll(PH.unsub, v.unsubUrl ? (html ? esc(v.unsubUrl) : v.unsubUrl) : '#')
    .replaceAll(PH.confirm, v.confirmUrl ? (html ? esc(v.confirmUrl) : v.confirmUrl) : '#')
}

// ---------- the confirmation email (fixed copy; it's the consent step) ----------
export const CONFIRM_SUBJECT = 'Confirm your subscription to the betterhood letter'
export function confirmContent(): EmailContent {
  return {
    headline: 'One click and you’re in',
    intro: `Hi ${'{{first_name}}'},\n\nThanks for signing up to **the betterhood letter**: physio-backed tips on posture, recovery and moving without pain.\n\nPlease confirm this is your email address, so we know it was you.`,
    blocks: [{ type: 'button', text: 'Yes, subscribe me', url: PH.confirm }],
    signoff: 'Button not working? Copy this link into your browser:\n' + PH.confirm,
  }
}

// ---------- sending ----------
const list = (s: string) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
const allow = list(env.EMAIL_ALLOWLIST)
export function emailAllowed(to: string) {
  if (!allow.length) return true
  const e = to.toLowerCase()
  return allow.some((a) => (a.startsWith('@') ? e.endsWith(a) : e === a))
}

export const emailConfig = () => ({
  provider: env.RESEND_API_KEY ? ('resend' as const) : ('log' as const),
  from: env.EMAIL_FROM,
  replyTo: env.EMAIL_REPLY_TO ?? null,
  allowlist: allow,
  testTo: list(env.EMAIL_TEST_TO),
  webhook: !!env.RESEND_WEBHOOK_SECRET,
  /** Resend's shared test sender can only deliver to the Resend account's own address. */
  sandboxSender: /@resend\.dev>?\s*$/i.test(env.EMAIL_FROM),
})

export interface OutEmail {
  to: string
  subject: string
  html: string
  text: string
  /** Shown as Resend tags, e.g. { kind: 'issue', issue: 'nl_123' }. */
  tags?: Record<string, string>
  /** One-click unsubscribe (RFC 8058). */
  unsubUrl?: string
}
export type SendResult = { status: 'sent'; id: string } | { status: 'skipped' | 'failed'; error: string }

function payload(m: OutEmail) {
  return {
    from: env.EMAIL_FROM,
    to: [m.to],
    subject: m.subject,
    html: m.html,
    text: m.text,
    ...(env.EMAIL_REPLY_TO ? { reply_to: env.EMAIL_REPLY_TO } : {}),
    ...(m.unsubUrl ? { headers: { 'List-Unsubscribe': `<${m.unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } } : {}),
    ...(m.tags ? { tags: Object.entries(m.tags).map(([name, value]) => ({ name, value: value.replace(/[^\w-]/g, '_') })) } : {}),
  }
}

/**
 * Sends each email (Resend's batch API, 100 per call). Never throws: every email gets a result in the same order.
 * Addresses outside EMAIL_ALLOWLIST are skipped, and with no API key everything is only logged.
 */
export async function sendEmails(msgs: OutEmail[], idempotencyKey?: string): Promise<SendResult[]> {
  const out: SendResult[] = new Array(msgs.length)
  const go: number[] = []
  msgs.forEach((m, i) => {
    if (!emailAllowed(m.to)) out[i] = { status: 'skipped', error: 'Not in EMAIL_ALLOWLIST (test mode)' }
    else if (!env.RESEND_API_KEY) {
      console.log(`[email] logged (no RESEND_API_KEY) to ${m.to.replace(/^(.).*@/, '$1***@')} :: ${m.subject}`)
      out[i] = { status: 'skipped', error: 'Resend not connected: logged only' }
    } else go.push(i)
  })

  for (let start = 0; start < go.length; start += 100) {
    const idx = go.slice(start, start + 100)
    const single = idx.length === 1
    try {
      const res = await fetch(`https://api.resend.com/emails${single ? '' : '/batch'}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': `${idempotencyKey}-${start / 100}` } : {}),
        },
        body: JSON.stringify(single ? payload(msgs[idx[0]]) : idx.map((i) => payload(msgs[i]))),
      })
      const body = (await res.json().catch(() => ({}))) as { id?: string; data?: { id: string }[]; message?: string }
      if (!res.ok) {
        const error = `Resend ${res.status}: ${body.message ?? 'request failed'}`.slice(0, 300)
        idx.forEach((i) => (out[i] = { status: 'failed', error }))
      } else if (single) out[idx[0]] = body.id ? { status: 'sent', id: body.id } : { status: 'failed', error: 'No id from Resend' }
      else idx.forEach((i, k) => (out[i] = body.data?.[k]?.id ? { status: 'sent', id: body.data[k].id } : { status: 'failed', error: 'No id from Resend' }))
    } catch (e) {
      idx.forEach((i) => (out[i] = { status: 'failed', error: `Couldn't reach Resend: ${(e as Error).message}`.slice(0, 300) }))
    }
    // Resend's default limit is 2 requests a second.
    if (start + 100 < go.length) await new Promise((r) => setTimeout(r, 600))
  }
  return out
}
