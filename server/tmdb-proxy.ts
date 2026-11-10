/**
 * `/api/tmdb/*` — a read-only, allow-listed proxy to TMDb.
 *
 * - Only GET/HEAD to a fixed set of path prefixes and query keys.
 * - Responses are cached (bounded by count and bytes) and concurrent
 *   identical requests share one upstream fetch.
 * - Upstream calls carry a timeout, never follow redirects, and are retried
 *   once on transport faults only.
 */
import { HttpError, sendError, sendJson, type Req, type Res } from './http.ts'

const TMDB_BASE = 'https://api.themoviedb.org/3'
const ALLOWED_PREFIXES = ['/search/', '/discover/', '/trending/', '/movie/', '/tv/', '/genre/', '/person/']
export const ALLOWED_QUERY_KEYS = new Set([
  'language',
  'query',
  'page',
  'include_adult',
  'sort_by',
  'with_genres',
  'vote_count.gte',
  'append_to_response',
])
const MAX_PATH_LENGTH = 800
const MAX_QUERY_VALUE_LENGTH = 500
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_CACHE_ENTRIES = 300
const MAX_CACHE_BYTES = 24 * 1024 * 1024
/** TMDb allows ~50 req/s per IP; stay well under it even when Discover fans out. */
const RATE_WINDOW_MS = 10_000
const RATE_MAX = 150

/**
 * Validate the raw sub-path (everything after /api/tmdb) and return the
 * canonical upstream path + query, or throw a 4xx. Traversal is rejected on
 * the raw string: URL normalization alone would turn /movie/../genre into an
 * allowed /genre path.
 */
export function canonicalTmdbPath(raw: string): string {
  if (raw.length > MAX_PATH_LENGTH) throw new HttpError(414, 'URI too long')
  const [rawPath = '', rawQuery = ''] = raw.split('?', 2)
  if (
    rawPath.includes('\\') ||
    rawPath.includes('%') ||
    rawPath.includes('//') ||
    /(?:^|\/)\.{1,2}(?:\/|$)/.test(rawPath) ||
    !/^\/[A-Za-z0-9/_.-]*$/.test(rawPath) ||
    !ALLOWED_PREFIXES.some((prefix) => rawPath.startsWith(prefix))
  ) {
    throw new HttpError(403, 'TMDb endpoint not allowed')
  }
  const params = new URLSearchParams(rawQuery)
  const clean = new URLSearchParams()
  for (const [key, value] of params) {
    // Rejected, not silently dropped: an injected api_key must fail loudly.
    if (!ALLOWED_QUERY_KEYS.has(key) || value.length > MAX_QUERY_VALUE_LENGTH || clean.has(key)) {
      throw new HttpError(403, 'Query parameter not allowed')
    }
    clean.set(key, value)
  }
  clean.sort()
  const query = clean.toString()
  return query ? `${rawPath}?${query}` : rawPath
}

type CachedResponse = { body: Buffer; expires: number }

function createCache() {
  const entries = new Map<string, CachedResponse>()
  let bytes = 0
  const remove = (key: string) => {
    const hit = entries.get(key)
    if (!hit) return
    entries.delete(key)
    bytes -= hit.body.byteLength
  }
  return {
    get(key: string): Buffer | null {
      const hit = entries.get(key)
      if (!hit) return null
      if (hit.expires <= Date.now()) {
        remove(key)
        return null
      }
      // Refresh recency so hot entries survive eviction.
      entries.delete(key)
      entries.set(key, hit)
      return hit.body
    },
    set(key: string, body: Buffer) {
      remove(key)
      entries.set(key, { body, expires: Date.now() + CACHE_TTL_MS })
      bytes += body.byteLength
      while (entries.size > MAX_CACHE_ENTRIES || bytes > MAX_CACHE_BYTES) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        remove(oldest)
      }
    },
  }
}

function createRateLimiter() {
  let stamps: number[] = []
  return {
    /** Seconds to wait, or 0 when the request may proceed. */
    take(): number {
      const now = Date.now()
      stamps = stamps.filter((t) => now - t < RATE_WINDOW_MS)
      if (stamps.length >= RATE_MAX) return Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - stamps[0]!)) / 1000))
      stamps.push(now)
      return 0
    },
  }
}

async function readLimited(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BYTES) throw new HttpError(502, 'Upstream response too large')
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_UPSTREAM_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new HttpError(502, 'Upstream response too large')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

type UpstreamResult = { status: number; body: Buffer; retryAfter: string | null }

export function createTmdbProxy(options: {
  getKey: () => string | null
  isBearerToken: (key: string) => boolean
  logWarn: (message: string) => void
  fetchImpl?: typeof fetch
}) {
  const doFetch = options.fetchImpl ?? fetch
  const cache = createCache()
  const inflight = new Map<string, Promise<UpstreamResult>>()
  const limiter = createRateLimiter()

  async function fetchUpstream(canonical: string, key: string): Promise<UpstreamResult> {
    const bearer = options.isBearerToken(key)
    const url = new URL(TMDB_BASE + canonical)
    if (!bearer) url.searchParams.set('api_key', key)
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await doFetch(url, {
          headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${key}` } : {}) },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          // Never replay credentials to whatever host a redirect names.
          redirect: 'error',
        })
        const body = await readLimited(res)
        const type = res.headers.get('content-type') ?? ''
        if (!type.toLowerCase().includes('application/json')) throw new HttpError(502, 'TMDb returned an unexpected response')
        return { status: res.status, body, retryAfter: res.headers.get('retry-after') }
      } catch (error) {
        const err = error as Error
        if (err instanceof HttpError) throw err
        if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new HttpError(504, 'TMDb did not respond in time')
        // A reset pooled socket is worth exactly one more try; the request is idempotent.
        if (attempt > 0) {
          const code = (err as { cause?: { code?: string } }).cause?.code
          options.logWarn(`[cinetrack] TMDb request failed: ${err.message}${code ? ` (${code})` : ''}`)
          throw new HttpError(502, 'Could not reach TMDb — check your connection')
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  }

  return async function handleTmdb(req: Req, res: Res, rawSubpath: string) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' })
      return
    }
    const canonical = canonicalTmdbPath(rawSubpath || '/')
    const cached = cache.get(canonical)
    if (cached) {
      sendJson(res, 200, cached.toString('utf8'), { 'Cache-Control': 'private, max-age=300', 'X-Cache': 'HIT' })
      return
    }
    let pending = inflight.get(canonical)
    if (!pending) {
      const wait = limiter.take()
      if (wait > 0) {
        sendError(res, 429, `Too many requests — retry in ${wait}s`, { 'Retry-After': String(wait) })
        return
      }
      const key = options.getKey()
      if (!key) {
        sendError(res, 503, 'TMDb API key is not configured. Add TMDB_KEY to the .env file and reload.')
        return
      }
      pending = fetchUpstream(canonical, key).finally(() => inflight.delete(canonical))
      inflight.set(canonical, pending)
    }
    const upstream = await pending
    if (upstream.status === 200) cache.set(canonical, upstream.body)
    if (upstream.status === 401) {
      sendError(res, 502, 'TMDb rejected the API key. Check TMDB_KEY in your .env file.')
      return
    }
    const headers: Record<string, string> = {
      'Cache-Control': upstream.status === 200 ? 'private, max-age=300' : 'no-store',
      'X-Cache': 'MISS',
    }
    if (upstream.status === 429 && upstream.retryAfter) headers['Retry-After'] = upstream.retryAfter
    sendJson(res, upstream.status, upstream.body.toString('utf8'), headers)
  }
}
