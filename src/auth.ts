import type { FastifyRequest } from 'fastify'
import jwt from 'jsonwebtoken'
import { env } from './env.js'
import { HttpError } from './util.js'

export type Role = 'physio' | 'patient'

export interface SessionClaims {
  sub: string // physio id or patient id
  role: Role
}

const ISSUER = 'betterhood'

export function signSession(c: SessionClaims): string {
  return jwt.sign({ role: c.role }, env.JWT_SECRET, { subject: c.sub, issuer: ISSUER, audience: 'session', expiresIn: '30d', algorithm: 'HS256' })
}

/** Short-lived proof that a phone number passed OTP but has no account yet. */
export function signSignup(phone: string): string {
  return jwt.sign({ phone }, env.JWT_SECRET, { issuer: ISSUER, audience: 'signup', expiresIn: '30m', algorithm: 'HS256' })
}

export function verifySignup(token: string): string {
  try {
    const p = jwt.verify(token, env.JWT_SECRET, { issuer: ISSUER, audience: 'signup', algorithms: ['HS256'] }) as { phone: string }
    return p.phone
  } catch {
    throw new HttpError(401, 'Sign-up session expired. Verify your number again.', 'signup_expired')
  }
}

export function sessionFrom(req: FastifyRequest): SessionClaims {
  const h = req.headers.authorization
  if (!h?.startsWith('Bearer ')) throw new HttpError(401, 'Not logged in', 'unauthenticated')
  try {
    const p = jwt.verify(h.slice(7), env.JWT_SECRET, { issuer: ISSUER, audience: 'session', algorithms: ['HS256'] }) as jwt.JwtPayload
    if (!p.sub || (p.role !== 'physio' && p.role !== 'patient')) throw new Error('bad claims')
    return { sub: p.sub, role: p.role }
  } catch {
    throw new HttpError(401, 'Session expired. Please log in again.', 'unauthenticated')
  }
}

export function requireRole(req: FastifyRequest, role: Role): string {
  const s = sessionFrom(req)
  if (s.role !== role) throw new HttpError(403, 'Not allowed for this account', 'forbidden')
  return s.sub
}
