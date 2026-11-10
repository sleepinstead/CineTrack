/**
 * Small HTTP helpers shared by the local API routes. The routes run as Connect
 * middleware inside Vite, which applies `server.headers` too late to reach
 * them, so every API response sets its own hardening headers here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export type Req = IncomingMessage
export type Res = ServerResponse

/** An error whose status and message are safe to show the client. */
export class HttpError extends Error {
  status: number
  constructor(status: number, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.status = status
  }
}

const API_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
}

export function applyApiHeaders(res: Res) {
  for (const [name, value] of Object.entries(API_HEADERS)) res.setHeader(name, value)
}

export function sendJson(res: Res, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(Buffer.byteLength(payload)))
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end(res.req?.method === 'HEAD' ? undefined : payload)
}

export function sendError(res: Res, status: number, message: string, headers: Record<string, string> = {}) {
  sendJson(res, status, { error: message }, { 'Cache-Control': 'no-store', ...headers })
}

export function sendNoContent(res: Res) {
  res.statusCode = 204
  res.setHeader('Cache-Control', 'no-store')
  res.end()
}

/** Read a request body, failing fast on a declared or streamed size over `limit`. */
export async function readBody(req: Req, limit: number, timeoutMs = 30_000): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'Payload too large')
  const chunks: Buffer[] = []
  let size = 0
  const timer = setTimeout(() => req.destroy(new Error('Request body timed out')), timeoutMs)
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer
      size += buf.length
      if (size > limit) throw new HttpError(413, 'Payload too large')
      chunks.push(buf)
    }
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timer)
  }
}

/** Parse a JSON object body; arrays and primitives are rejected. */
export async function readJsonObject(req: Req, limit: number): Promise<Record<string, unknown>> {
  const type = String(req.headers['content-type'] ?? '').toLowerCase()
  // Requiring JSON forces a CORS preflight for any cross-site write attempt,
  // which this server never approves — defence in depth behind the Origin check.
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Expected application/json')
  const buf = await readBody(req, limit)
  let parsed: unknown
  try {
    parsed = JSON.parse(buf.toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Expected a JSON object')
  return parsed as Record<string, unknown>
}

/** True for a Host header that names this machine — the DNS-rebinding guard. */
export function isLocalHostHeader(host: unknown): boolean {
  if (typeof host !== 'string' || !host) return false
  let url: URL
  try {
    url = new URL(`http://${host}`)
  } catch {
    return false
  }
  // A userinfo component means the parsed host is not what the header claims.
  if (url.username || url.password) return false
  const name = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  // 0.0.0.0 reaches this loopback-bound server on macOS/Linux; it is an IP
  // literal, so it cannot be rebound to an attacker's DNS name.
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || name === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(name)
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/**
 * CSRF / cross-origin read guard. Browsers always send Origin or
 * Sec-Fetch-Site on the requests this app makes; header-less clients (curl)
 * may read in development but never write, and strict mode refuses them.
 */
export function isSameOriginRequest(req: Req, strict: boolean): boolean {
  const origin = req.headers.origin
  const host = req.headers.host
  if (typeof origin === 'string' && origin) {
    try {
      return typeof host === 'string' && new URL(origin).host === host
    } catch {
      return false
    }
  }
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site) return site === 'same-origin'
  const method = (req.method ?? 'GET').toUpperCase()
  return !strict && (method === 'GET' || method === 'HEAD')
}
