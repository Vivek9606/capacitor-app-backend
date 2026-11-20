import { env } from './env.js'
import { LOGO_CREAM_SIZE } from './emailArt.js'

/**
 * Email for the newsletter: one branded template (renderEmail) and sending through Resend (sendEmails).
 *
 * The template is table-based with inline styles so it holds up in Gmail, Outlook and Apple Mail: a plum masthead
 * with the orbit artwork (solid plum where a client hides background images), a white letter body and a dark footer.
 * Colours and fonts follow the website. Content is a small set of blocks the admin editor produces; body text
 * supports blank-line paragraphs, **bold** and [links](https://...).
 *
 * Personal bits are placeholders filled per recipient: %%FIRST_NAME%%, %%UNSUB_URL%%, %%CONFIRM_URL%%.
 */

// ---------- content model (shared with the admin editor) ----------
export type Block =
  | { type: 'text'; heading?: string; body: string }
  | { type: 'article'; label?: string; title: string; summary?: string; url: string; image?: string; cta?: string }
  | { type: 'tip'; heading?: string; body: string }
  | { type: 'quote'; text: string; by?: string }
  | { type: 'steps'; heading?: string; items: string }
  | { type: 'image'; src: string; alt?: string; caption?: string; url?: string }
  | { type: 'cta'; heading: string; body?: string; text: string; url: string }
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

// ---------- brand (website tokens) ----------
const C = {
  page: '#f3ece2',
  card: '#ffffff',
  line: '#eadfe6',
  ink: '#240c2c',
  soft: '#5b4a5e',
  mute: '#85758a',
  plum950: '#1b0820',
  plum900: '#240c2c',
  plum800: '#3a1240',
  plum: '#5e1951',
  plum600: '#7a2a6c',
  plum500: '#9b4a8c',
  plum300: '#d7b3cf',
  plum200: '#ead6e5',
  plum100: '#f5eaf2',
  plum50: '#fbf6fa',
  cream: '#fbf7f1',
  sun500: '#ffb547',
  sun200: '#ffe5bd',
  sun100: '#fff4e2',
  sunInk: '#8a5a00',
}
const DISPLAY = `'Bricolage Grotesque','Figtree',Helvetica,Arial,sans-serif`
const BODY = `'Figtree',Helvetica,Arial,sans-serif`
const T = `role="presentation" cellpadding="0" cellspacing="0" border="0"`

// ---------- text helpers ----------
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const safeUrl = (u: string) => (/^(https?:|mailto:|%%)/i.test(u.trim()) ? u.trim() : '#')
const name = (s: string) => s.replace(/\{\{\s*first_name\s*\}\}/gi, PH.firstName)

/** Inline markup: **bold** and [text](url). Input must already be escaped. */
function inline(h: string, linkColor: string, boldColor: string) {
  return h
    .replace(/\*\*(.+?)\*\*/g, `<strong style="color:${boldColor};font-weight:700">$1</strong>`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${esc(safeUrl(u.replace(/&amp;/g, '&')))}" style="color:${linkColor};text-decoration:underline">${t}</a>`)
}

/** Paragraphs, **bold**, [text](url) and line breaks → HTML. Everything else is escaped. */
function rich(src: string, style: string, o: { link?: string; bold?: string; gap?: number } = {}): string {
  return name(src)
    .trim()
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 ${o.gap ?? 18}px;${style}">${inline(esc(p.trim()), o.link ?? C.plum600, o.bold ?? C.ink).replace(/\n/g, '<br>')}</p>`)
    .join('')
}
/** Same text, plain: links become "text (url)". */
function plain(src: string): string {
  return name(src)
    .trim()
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
}
/** One step per line; leading "-", "•" or "1." is dropped. */
const lines = (s: string) => s.split('\n').map((x) => x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean)
const two = (n: number) => String(n).padStart(2, '0')
const gap = (px: number) => `<div style="height:${px}px;line-height:${px}px;font-size:0">&nbsp;</div>`

const P = `font-family:${BODY};font-size:17px;line-height:1.7;color:${C.soft}`
const LABEL = `font-family:${BODY};font-size:12px;line-height:1;font-weight:700;letter-spacing:1.4px;text-transform:uppercase`
const H2 = `font-family:${DISPLAY};font-size:25px;line-height:1.22;font-weight:700;letter-spacing:-.4px;color:${C.ink}`

function button(text: string, url: string, o: { bg?: string; fg?: string; margin?: string } = {}) {
  const bg = o.bg ?? C.plum
  const fg = o.fg ?? '#ffffff'
  return `<table ${T} style="margin:${o.margin ?? '4px 0 32px'}"><tr><td bgcolor="${bg}" style="border-radius:999px;background:${bg}">
<a class="btn" href="${esc(safeUrl(url))}" style="display:inline-block;padding:17px 32px;font-family:${BODY};font-size:16px;line-height:1;font-weight:700;color:${fg};text-decoration:none;border-radius:999px">${esc(text)}&nbsp;&nbsp;&rarr;</a>
</td></tr></table>`
}

interface Ctx {
  art: { hero: string; cta: string; logo: string; mark: string }
  articleNo: number
}

function blockHtml(b: Block, x: Ctx): string {
  switch (b.type) {
    case 'text':
      return `${b.heading ? `<h2 style="margin:4px 0 14px;${H2}">${esc(name(b.heading))}</h2>` : ''}${rich(b.body, P)}${gap(8)}`
    case 'article': {
      const url = esc(safeUrl(b.url))
      const n = ++x.articleNo
      return `<table ${T} width="100%" style="margin:0 0 24px;border:1px solid ${C.line};border-radius:22px;border-collapse:separate;background:${C.card}">
${b.image ? `<tr><td style="padding:8px 8px 0"><a href="${url}"><img src="${esc(safeUrl(b.image))}" width="494" alt="${esc(b.title)}" style="display:block;width:100%;max-width:494px;height:auto;border:0;border-radius:16px"></a></td></tr>` : ''}
<tr><td class="pad-card" style="padding:26px 28px 28px">
  <table ${T} width="100%"><tr>
    <td valign="middle">${b.label ? `<span style="${LABEL};color:${C.plum};background:${C.plum100};border-radius:999px;padding:7px 12px;display:inline-block">${esc(b.label)}</span>` : ''}</td>
    <td valign="middle" align="right" style="font-family:${DISPLAY};font-size:15px;line-height:1;font-weight:700;color:${C.plum300};letter-spacing:.5px">${two(n)}</td>
  </tr></table>
  <a href="${url}" style="display:block;margin:16px 0 0;font-family:${DISPLAY};font-size:23px;line-height:1.25;font-weight:700;letter-spacing:-.4px;color:${C.ink};text-decoration:none">${esc(b.title)}</a>
  ${b.summary ? `<p style="margin:10px 0 0;font-family:${BODY};font-size:16px;line-height:1.65;color:${C.soft}">${esc(name(b.summary))}</p>` : ''}
  <table ${T} style="margin:20px 0 0"><tr><td style="border:1.5px solid ${C.plum200};border-radius:999px">
    <a href="${url}" style="display:inline-block;padding:11px 18px;font-family:${BODY};font-size:14px;line-height:1;font-weight:700;color:${C.plum};text-decoration:none">${esc(b.cta || 'Read the article')}&nbsp;&nbsp;&rarr;</a>
  </td></tr></table>
</td></tr></table>`
    }
    case 'tip':
      return `<table ${T} width="100%" style="margin:0 0 28px;border-collapse:separate"><tr><td bgcolor="${C.sun100}" class="pad-card" style="background:${C.sun100};border:1px solid ${C.sun200};border-radius:22px;padding:24px 26px 8px">
  <table ${T} width="100%"><tr>
    <td width="44" valign="top" style="padding:0 16px 0 0"><table ${T}><tr><td width="44" height="44" align="center" valign="middle" bgcolor="${C.sun500}" style="width:44px;height:44px;border-radius:999px;background:${C.sun500};font-family:${BODY};font-size:20px;line-height:44px;color:${C.plum900}">&#10022;</td></tr></table></td>
    <td valign="top">
      <p style="margin:4px 0 10px;${LABEL};color:${C.sunInk}">${esc(b.heading || 'Physio tip')}</p>
      ${rich(b.body, `font-family:${BODY};font-size:17px;line-height:1.6;color:${C.ink}`, { gap: 16 })}
    </td>
  </tr></table>
</td></tr></table>`
    case 'quote':
      return `<table ${T} width="100%" style="margin:4px 0 32px;border-collapse:separate"><tr><td bgcolor="${C.plum50}" class="pad-card" style="background:${C.plum50};border-radius:22px;padding:30px 32px">
  <p style="margin:0 0 6px;font-family:${DISPLAY};font-size:64px;line-height:.8;font-weight:800;color:${C.plum300}">&ldquo;</p>
  <p style="margin:0;font-family:${DISPLAY};font-size:23px;line-height:1.38;font-weight:600;letter-spacing:-.3px;color:${C.ink}">${inline(esc(name(b.text.trim())), C.plum600, C.plum).replace(/\n/g, '<br>')}</p>
  ${b.by ? `<p style="margin:18px 0 0;font-family:${BODY};font-size:14px;line-height:1.4;font-weight:700;color:${C.plum}"><span style="color:${C.plum300}">&mdash;&nbsp;</span>${esc(b.by)}</p>` : ''}
</td></tr></table>`
    case 'steps': {
      const items = lines(b.items)
      const last = items.length - 1
      return `${b.heading ? `<h2 style="margin:4px 0 20px;${H2}">${esc(name(b.heading))}</h2>` : ''}<table ${T} width="100%" style="margin:0 0 30px">${items
        .map(
          (it, i) => `<tr>
  <td width="34" valign="top" style="padding:0 16px 0 0"><table ${T}><tr><td width="34" height="34" align="center" valign="middle" bgcolor="${C.plum}" style="width:34px;height:34px;border-radius:999px;background:${C.plum};font-family:${DISPLAY};font-size:15px;line-height:34px;font-weight:700;color:${C.cream}">${i + 1}</td></tr></table></td>
  <td valign="top" style="padding:5px 0 ${i === last ? 0 : 16}px;${i === last ? '' : `border-bottom:1px solid ${C.line};`}font-family:${BODY};font-size:17px;line-height:1.6;color:${C.soft}">${inline(esc(name(it)), C.plum600, C.ink)}</td>
</tr>${i === last ? '' : `<tr><td colspan="2" style="height:16px;line-height:16px;font-size:0">&nbsp;</td></tr>`}`,
        )
        .join('')}</table>`
    }
    case 'image': {
      const img = `<img src="${esc(safeUrl(b.src))}" width="512" alt="${esc(b.alt ?? '')}" style="display:block;width:100%;max-width:512px;height:auto;border:0;border-radius:20px">`
      return `<table ${T} width="100%" style="margin:4px 0 30px"><tr><td>${b.url ? `<a href="${esc(safeUrl(b.url))}">${img}</a>` : img}</td></tr>${
        b.caption ? `<tr><td style="padding:12px 4px 0;font-family:${BODY};font-size:14px;line-height:1.5;color:${C.mute};text-align:center">${esc(b.caption)}</td></tr>` : ''
      }</table>`
    }
    case 'cta':
      return `<table ${T} width="100%" style="margin:4px 0 32px;border-collapse:separate"><tr><td bgcolor="${C.plum800}" background="${x.art.cta}" class="pad-card" style="background:${C.plum800} url('${x.art.cta}') right top / cover no-repeat;border-radius:24px;padding:36px 34px 8px">
  <h2 style="margin:0 0 12px;font-family:${DISPLAY};font-size:28px;line-height:1.15;font-weight:700;letter-spacing:-.6px;color:${C.cream}">${esc(name(b.heading))}</h2>
  ${b.body ? rich(b.body, `font-family:${BODY};font-size:16px;line-height:1.65;color:${C.plum200}`, { link: C.sun200, bold: C.cream, gap: 22 }) : gap(10)}
  ${button(b.text, b.url, { bg: C.sun500, fg: C.plum900, margin: '0 0 28px' })}
</td></tr></table>`
    case 'button':
      return button(b.text, b.url)
    case 'divider':
      return `<table ${T} width="100%" style="margin:6px 0 32px"><tr>
  <td width="46%" valign="middle"><div style="border-top:1px solid ${C.line};font-size:0;line-height:0">&nbsp;</div></td>
  <td align="center" valign="middle" style="padding:0 14px;font-family:${BODY};font-size:14px;line-height:1;color:${C.plum300};white-space:nowrap">&#10022;</td>
  <td width="46%" valign="middle"><div style="border-top:1px solid ${C.line};font-size:0;line-height:0">&nbsp;</div></td>
</tr></table>`
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
    case 'quote':
      return `"${plain(b.text)}"${b.by ? `\n- ${b.by}` : ''}`
    case 'steps':
      return `${b.heading ? `${plain(b.heading).toUpperCase()}\n` : ''}${lines(b.items).map((it, i) => `${i + 1}. ${plain(it)}`).join('\n')}`
    case 'image':
      return b.caption ? `[${b.caption}]` : ''
    case 'cta':
      return `${plain(b.heading).toUpperCase()}\n${b.body ? `${plain(b.body)}\n` : ''}${b.text}: ${b.url}`
    case 'button':
      return `${b.text}: ${b.url}`
    case 'divider':
      return '----'
  }
}

export interface RenderOpts {
  subject: string
  preheader?: string
  /** Absolute base URL that serves /email/hero.jpg, /email/cta.jpg, /email/logo-cream.png and /email/mark.png (this API). */
  assetBase: string
  siteUrl: string
  /** Footer: 'newsletter' shows why they get it + unsubscribe; 'confirm' shows the ignore-if-not-you note. */
  footer: 'newsletter' | 'confirm'
  /** Small label at the top right of the masthead, e.g. "No. 3 · November 2026". */
  meta?: string
}

/** The full email, as HTML and plain text. Placeholders (PH) are left in for per-recipient filling. */
export function renderEmail(content: EmailContent, o: RenderOpts): { html: string; text: string } {
  const site = o.siteUrl.replace(/\/$/, '')
  const a = o.assetBase.replace(/\/$/, '')
  const x: Ctx = { art: { hero: `${a}/email/hero.jpg`, cta: `${a}/email/cta.jpg`, logo: `${a}/email/logo-cream.png`, mark: `${a}/email/mark.png` }, articleNo: 0 }
  const pre = o.preheader?.trim() ?? ''
  const blocks = content.blocks ?? []
  const body = blocks.map((b) => blockHtml(b, x)).join('\n')
  const signoff = content.signoff?.trim()
  const articles = blocks.filter((b): b is Extract<Block, { type: 'article' }> => b.type === 'article')
  const newsletter = o.footer === 'newsletter'

  // "In this letter": a contents list when there are two or more articles.
  const toc =
    articles.length >= 2
      ? `<table ${T} width="100%" style="margin:0 0 34px"><tr><td style="border-top:1px solid ${C.line};border-bottom:1px solid ${C.line};padding:22px 0 8px">
  <p style="margin:0 0 16px;${LABEL};color:${C.mute}">In this letter</p>
  ${articles
    .map(
      (b, i) =>
        `<table ${T} width="100%" style="margin:0 0 14px"><tr><td width="34" valign="top" style="font-family:${DISPLAY};font-size:15px;line-height:1.45;font-weight:700;color:${C.plum300}">${two(i + 1)}</td><td valign="top"><a href="${esc(safeUrl(b.url))}" style="font-family:${BODY};font-size:16px;line-height:1.45;font-weight:700;color:${C.ink};text-decoration:none">${esc(b.title)}</a></td></tr></table>`,
    )
    .join('')}
</td></tr></table>`
      : ''

  let sign = ''
  if (signoff) {
    const [first, ...rest] = esc(name(signoff)).split('\n')
    sign = `<table ${T} width="100%" style="margin:6px 0 8px"><tr>
  <td width="48" valign="middle" style="padding:0 14px 0 0"><img src="${x.art.mark}" width="48" height="48" alt="" style="display:block;border:0;border-radius:999px"></td>
  <td valign="middle" style="font-family:${BODY};font-size:16px;line-height:1.45;color:${C.soft}">${first}${rest.length ? `<br><span style="font-family:${DISPLAY};font-size:17px;font-weight:700;color:${C.ink}">${rest.join('<br>')}</span>` : ''}</td>
</tr></table>`
  }

  const links: [string, string][] = [
    ['Read', `${site}/learn/`],
    ['Free pain check', `${site}/quiz-landing-page/`],
    ['Find a physio', `${site}/physio-directory/`],
  ]
  const why = newsletter
    ? `You're getting this because you subscribed to the betterhood letter.<br><a href="${PH.unsub}" style="color:${C.plum300};text-decoration:underline">Unsubscribe</a> any time, in one click.`
    : `If you didn't ask to join, just ignore this email.<br>You won't hear from us again.`

  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${esc(o.subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=Figtree:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: light only; supported-color-schemes: light only; }
  body { margin:0; padding:0; background:${C.page}; -webkit-text-size-adjust:100%; }
  a { color:${C.plum600}; }
  @media (max-width:620px) {
    .wrap { padding:10px 8px 28px !important; }
    .hero { padding:26px 24px 34px !important; border-radius:22px 22px 0 0 !important; }
    .hero-gap { height:48px !important; line-height:48px !important; }
    .h1 { font-size:34px !important; letter-spacing:-.8px !important; }
    .body { padding:30px 22px 20px !important; border-radius:0 0 22px 22px !important; }
    .pad-card { padding-left:22px !important; padding-right:22px !important; }
    .foot { padding:30px 24px !important; border-radius:22px !important; }
    .meta { display:none !important; }
    .btn { padding:16px 22px !important; font-size:15px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${esc(name(pre))}${'&#847;&zwnj;&nbsp;'.repeat(60)}</div>
<table ${T} width="100%" bgcolor="${C.page}" style="background:${C.page}">
<tr><td align="center" class="wrap" style="padding:28px 16px 44px">
  <table ${T} width="600" style="width:100%;max-width:600px">

    <tr><td class="hero" bgcolor="${C.plum800}" background="${x.art.hero}" valign="top" style="background:${C.plum800} url('${x.art.hero}') right top / cover no-repeat;border-radius:28px 28px 0 0;padding:34px 44px 48px">
      <table ${T} width="100%"><tr>
        <td align="left" valign="middle"><a href="${esc(site)}"><img src="${x.art.logo}" width="${LOGO_CREAM_SIZE.width}" height="${LOGO_CREAM_SIZE.height}" alt="betterhood" style="display:block;border:0"></a></td>
        ${o.meta ? `<td align="right" valign="middle" class="meta"><span style="display:inline-block;background:${C.plum800};border:1px solid #6b3a6a;border-radius:999px;padding:8px 13px;font-family:${BODY};font-size:12px;line-height:1;font-weight:600;letter-spacing:.3px;color:${C.plum200};white-space:nowrap">${esc(o.meta)}</span></td>` : ''}
      </tr></table>
      <div class="hero-gap" style="height:72px;line-height:72px;font-size:0">&nbsp;</div>
      <p style="margin:0 0 16px;${LABEL};color:${C.sun200}">&#10022;&nbsp;&nbsp;${esc(content.eyebrow || 'The betterhood letter')}</p>
      <h1 class="h1" style="margin:0;max-width:400px;font-family:${DISPLAY};font-size:44px;line-height:1.06;font-weight:700;letter-spacing:-1.2px;color:${C.cream}">${esc(name(content.headline || o.subject))}</h1>
    </td></tr>

    <tr><td class="body" bgcolor="${C.card}" style="background:${C.card};border-radius:0 0 28px 28px;padding:40px 44px 26px">
      ${content.intro ? `${rich(content.intro, `font-family:${BODY};font-size:18px;line-height:1.7;color:${C.soft}`)}${gap(10)}` : ''}
      ${toc}
      ${body}
      ${sign}
    </td></tr>

    <tr><td style="height:14px;line-height:14px;font-size:0">&nbsp;</td></tr>
    <tr><td class="foot" bgcolor="${C.plum950}" style="background:${C.plum950};border-radius:28px;padding:36px 44px">
      <a href="${esc(site)}"><img src="${x.art.logo}" width="${Math.round(LOGO_CREAM_SIZE.width * 0.8)}" height="${Math.round(LOGO_CREAM_SIZE.height * 0.8)}" alt="betterhood" style="display:block;border:0"></a>
      <p style="margin:16px 0 22px;font-family:${DISPLAY};font-size:21px;line-height:1.28;font-weight:600;letter-spacing:-.3px;color:${C.cream}">Physio-backed care for<br>pain-free movement.</p>
      ${newsletter ? `<p style="margin:0 0 26px;font-family:${BODY};font-size:14px;line-height:1.6;font-weight:700">${links.map(([t, u]) => `<a href="${esc(u)}" style="color:${C.sun200};text-decoration:none">${t}</a>`).join(`<span style="color:${C.plum500}">&nbsp;&nbsp;&middot;&nbsp;&nbsp;</span>`)}</p>` : ''}
      <p style="margin:0;padding:20px 0 0;border-top:1px solid #33193a;font-family:${BODY};font-size:13px;line-height:1.65;color:${C.plum300}">${why}</p>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`

  const text = [
    plain(content.headline || o.subject),
    content.intro ? plain(content.intro) : '',
    ...blocks.map(blockText),
    signoff ? plain(signoff) : '',
    newsletter ? `You're getting this because you subscribed at betterhood.in.\nUnsubscribe: ${PH.unsub}` : `If you didn't ask to join, ignore this email.`,
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
    eyebrow: 'Almost there',
    headline: 'One last click',
    intro: `Hi ${'{{first_name}}'},\n\nThanks for signing up to **the betterhood letter**: physio-backed tips on posture, recovery and moving without pain.\n\nPlease confirm this is your email address, so we know it was you.`,
    blocks: [
      { type: 'button', text: 'Yes, subscribe me', url: PH.confirm },
      { type: 'text', body: `Button not working? [Open this link instead](${PH.confirm}).` },
    ],
    signoff: 'See you inside,\nThe betterhood physio team',
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
