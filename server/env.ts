/**
 * TMDb credential lookup. The key never leaves the server: the browser talks
 * to /api/tmdb and the proxy attaches the credential upstream.
 *
 * Precedence: process env TMDB_KEY → .env.local → .env → API.txt (legacy).
 * Files are re-checked at most every few seconds, so editing .env takes effect
 * without restarting the server.
 */
import fs from 'node:fs'
import path from 'node:path'

const RECHECK_MS = 5_000

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trimStart() : trimmed
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    let value = body.slice(eq + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1)
    } else {
      // Unquoted values may carry a trailing ` # comment`.
      const hash = value.search(/\s#/)
      if (hash >= 0) value = value.slice(0, hash).trim()
    }
    if (key && value) out[key] = value
  }
  return out
}

function readFileIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function createKeyResolver(root: string, env: NodeJS.ProcessEnv = process.env) {
  let cached: { key: string | null; at: number } | null = null

  function resolve(): string | null {
    const fromEnv = env.TMDB_KEY?.trim()
    if (fromEnv) return fromEnv
    for (const name of ['.env.local', '.env']) {
      const text = readFileIfPresent(path.join(root, name))
      const key = text ? parseDotEnv(text).TMDB_KEY?.trim() : undefined
      if (key) return key
    }
    const legacy = readFileIfPresent(path.join(root, 'API.txt'))?.trim()
    return legacy || null
  }

  return {
    /** The configured key, or null when none is set. */
    get(): string | null {
      const now = Date.now()
      if (!cached || now - cached.at > RECHECK_MS) cached = { key: resolve(), at: now }
      return cached.key
    },
    /** True for a v4 "read access token" (a JWT) rather than a v3 API key. */
    isBearerToken(key: string) {
      return key.startsWith('eyJ') && key.split('.').length === 3
    },
  }
}
