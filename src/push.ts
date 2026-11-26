import { createSign } from 'node:crypto'
import { q } from './db.js'
import { env } from './env.js'

/**
 * Push notifications to the betterhood app through Firebase Cloud Messaging (HTTP v1). FCM delivers to Android
 * directly and to iPhones through Apple (the APNs key is uploaded in the Firebase console, not here).
 *
 * PUSH_PROVIDER=log (default) only logs. PUSH_PROVIDER=fcm needs FCM_SERVICE_ACCOUNT: the Firebase service-account
 * JSON (Project settings → Service accounts → Generate new private key), stored as one secret.
 */
export interface Push {
  title: string
  body: string
  /** Where the app opens when the notification is tapped, e.g. "/me" or "/plan/<token>". */
  path?: string
}
type Who = { type: 'patient' | 'physio'; id: string }

interface ServiceAccount { project_id: string; client_email: string; private_key: string }
let account: ServiceAccount | null | undefined
function serviceAccount(): ServiceAccount | null {
  if (account !== undefined) return account
  try {
    const a = JSON.parse(env.FCM_SERVICE_ACCOUNT || 'null')
    account = a?.project_id && a.client_email && a.private_key ? a : null
  } catch {
    account = null
  }
  if (!account && env.PUSH_PROVIDER === 'fcm') console.error('PUSH_PROVIDER=fcm needs FCM_SERVICE_ACCOUNT (the Firebase service-account JSON)')
  return account ?? null
}

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url')
let cached: { token: string; exp: number } | null = null
/** Google OAuth access token for FCM, from a JWT signed with the service account's key (cached ~55 minutes). */
async function accessToken(a: ServiceAccount): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({ iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(a.private_key)
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(sig)}` }),
  })
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number }
  if (!res.ok || !data.access_token) throw new Error(`FCM auth failed (${res.status})`)
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in ?? 3600) * 1000 }
  return cached.token
}

/** Send to every device this person is signed in on. Returns how many devices accepted it. Never throws. */
export async function sendPush(who: Who, p: Push): Promise<number> {
  const tokens = await q<{ token: string }>('select token from push_tokens where subject_type = $1 and subject_id = $2', [who.type, who.id]).catch(() => [])
  if (!tokens.length) return 0
  if (env.PUSH_PROVIDER !== 'fcm') {
    console.log(`[push] logged to ${who.type} ${who.id} (${tokens.length} device${tokens.length === 1 ? '' : 's'}) :: ${p.title} | ${p.body}`)
    return 0
  }
  const a = serviceAccount()
  if (!a) return 0
  let sent = 0
  try {
    const auth = await accessToken(a)
    for (const { token } of tokens) {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: p.title, body: p.body },
            data: p.path ? { path: p.path } : {},
            android: { priority: 'high', notification: { channel_id: 'default' } },
            apns: { payload: { aps: { sound: 'default' } } },
          },
        }),
      })
      if (res.ok) sent++
      else {
        const body = await res.text()
        // The app was uninstalled or the token rotated: forget it.
        if (res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*token/i.test(body)) await q('delete from push_tokens where token = $1', [token]).catch(() => {})
        else console.error(`[push] FCM ${res.status}: ${body.slice(0, 200)}`)
      }
    }
  } catch (e) {
    console.error('[push]', (e as Error).message)
  }
  return sent
}

/** Fire-and-forget push for transactional messages (a reply, a booking): failures are logged, never break the request. */
export function pushLater(who: Who, p: Push) {
  sendPush(who, p).catch((e) => console.error('[push]', e.message))
}
