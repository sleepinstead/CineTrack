/**
 * `/__data/library` and `/__data/settings` — the library and preferences store.
 *
 * Records are validated with the same rules the browser uses (src/lib/entry)
 * plus checks only the server can make: full decoding of custom poster images
 * and status transitions that depend on the stored row.
 */
import { isSafeKey, MAX_CHANGES_PER_REQUEST, normalizeKeyedEntry, type Entry } from '../src/lib/entry.ts'
import type { Database, SqlDatabase } from './database.ts'
import { HttpError, readJsonObject, sendError, sendJson, sendNoContent, type Req, type Res } from './http.ts'

/** Clients chunk saves at 16 MB; anything far larger is not a CineTrack client. */
const MAX_LIBRARY_BODY_BYTES = 32 * 1024 * 1024
const MAX_SETTINGS_BODY_BYTES = 256 * 1024
const MAX_SETTING_VALUE_BYTES = 10_000
const MAX_SETTING_ROWS = 200
const SETTING_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/
const MAX_CUSTOM_POSTER_BYTES = 2 * 1024 * 1024
const WEBP_PREFIX = 'data:image/webp;base64,'

/** Decode the whole image and check its RIFF/WebP container, not just the header. */
export function isValidCustomPoster(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith(WEBP_PREFIX)) return false
  const payload = value.slice(WEBP_PREFIX.length)
  if (!payload || payload.length % 4 !== 0 || payload.length > Math.ceil(MAX_CUSTOM_POSTER_BYTES / 3) * 4) return false
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return false
  const bytes = Buffer.from(payload, 'base64')
  return bytes.byteLength >= 16
    && bytes.byteLength <= MAX_CUSTOM_POSTER_BYTES
    && bytes.toString('base64') === payload
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.readUInt32LE(4) + 8 === bytes.byteLength
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString('ascii'))
}

function readStoredEntry(stmt: ReturnType<SqlDatabase['prepare']>, key: string): Record<string, unknown> | null {
  stmt.bind([key])
  try {
    if (!stmt.step()) return null
    const parsed: unknown = JSON.parse(String(stmt.get()[0]))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {} // An unreadable legacy row exists but proves nothing about progress.
  } finally {
    stmt.reset()
  }
}

/**
 * Dropped is reachable only from Watching with recorded progress. A change
 * that skips that step (a stale second tab, or edits coalesced while offline)
 * is coerced to Watching rather than rejected: rejecting would discard every
 * other change in the same save. normalizeEntry already guarantees a Dropped
 * row carries episode progress.
 */
function enforceDropTransition(entry: Entry, previous: Record<string, unknown> | null) {
  if (entry.status !== 'dropped') return
  const alreadyDropped = previous?.mediaType === 'tv' && previous.status === 'dropped'
  const wasWatching = previous?.mediaType === 'tv' && previous.status === 'watching'
  // A brand-new row may arrive already dropped (import/migration) with its history.
  const importedHistory = previous === null
  if (!alreadyDropped && !wasWatching && !importedHistory) entry.status = 'watching'
}

function applyLibraryChanges(db: SqlDatabase, changes: Record<string, unknown>, clear: boolean) {
  if (clear) db.run('DELETE FROM library')
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO library (
      key, media_type, id, title, year, poster, backdrop, rating, status, favorite,
      added_at, watched_at, runtime, total_episodes, episodes, rewatches, note, json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const remove = db.prepare('DELETE FROM library WHERE key = ?')
  const readPrevious = db.prepare('SELECT json FROM library WHERE key = ?')
  let applied = 0
  try {
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) {
        if (isSafeKey(key)) {
          remove.run([key])
          applied++
        }
        continue
      }
      const entry = normalizeKeyedEntry(key, value)
      if (!entry) continue
      if (entry.customPoster && !isValidCustomPoster(entry.customPoster)) entry.customPoster = null
      if (entry.status === 'dropped') enforceDropTransition(entry, readStoredEntry(readPrevious, key))
      upsert.run([
        key,
        entry.mediaType,
        entry.id,
        entry.title,
        entry.year,
        entry.poster,
        entry.backdrop,
        entry.rating,
        entry.status,
        entry.favorite ? 1 : 0,
        entry.addedAt,
        entry.watchedAt,
        entry.runtime,
        entry.totalEpisodes,
        // The episode logs live in `json`; duplicating them here doubled the
        // size of every series row. Kept as columns for older readers.
        null,
        null,
        entry.note ?? null,
        JSON.stringify(entry),
      ])
      applied++
    }
  } finally {
    upsert.free()
    remove.free()
    readPrevious.free()
  }
  return applied
}

function readLibrary(db: SqlDatabase): string {
  // Build the JSON text directly: re-parsing and re-stringifying every row
  // (with its custom poster) doubled the cost of every page load.
  const parts: string[] = []
  const stmt = db.prepare('SELECT key, json FROM library')
  try {
    while (stmt.step()) {
      const [key, json] = stmt.get() as [string, string]
      const entry = (() => {
        try {
          return normalizeKeyedEntry(key, JSON.parse(json))
        } catch {
          return null
        }
      })()
      if (entry) parts.push(`${JSON.stringify(key)}:${JSON.stringify(entry)}`)
    }
  } finally {
    stmt.free()
  }
  return `{${parts.join(',')}}`
}

function readSettings(db: SqlDatabase): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  const stmt = db.prepare('SELECT key, value FROM settings')
  try {
    while (stmt.step()) {
      const [key, value] = stmt.get() as [string, string]
      if (!SETTING_KEY.test(key)) continue
      try {
        out[key] = JSON.parse(value)
      } catch {
        // Skip unreadable values rather than failing the whole load.
      }
    }
  } finally {
    stmt.free()
  }
  return { ...out }
}

function writeSettings(db: SqlDatabase, changes: Record<string, unknown>) {
  const entries = Object.entries(changes).filter(([key, value]) => SETTING_KEY.test(key) && value !== undefined)
  const serialized = entries.map(([key, value]) => [key, JSON.stringify(value)] as const)
  if (serialized.some(([, value]) => value.length > MAX_SETTING_VALUE_BYTES)) {
    throw new HttpError(413, 'A setting value is too large')
  }
  const existing = new Set((db.exec('SELECT key FROM settings')[0]?.values ?? []).map((row) => String(row[0])))
  const added = serialized.filter(([key]) => !existing.has(key)).length
  if (existing.size + added > MAX_SETTING_ROWS) throw new HttpError(413, 'Too many settings')
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
  try {
    for (const [key, value] of serialized) stmt.run([key, value])
  } finally {
    stmt.free()
  }
  return serialized.length
}

export async function handleLibrary(req: Req, res: Res, db: Database) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    const body = await db.read(readLibrary)
    sendJson(res, 200, body, { 'Cache-Control': 'no-store' })
    return
  }
  if (req.method === 'POST') {
    const payload = await readJsonObject(req, MAX_LIBRARY_BODY_BYTES)
    // `{ clear?, changes }` envelope; a bare map of changes is still accepted.
    let changes: Record<string, unknown> = payload
    let clear = false
    if (Object.prototype.hasOwnProperty.call(payload, 'changes')) {
      const inner = payload.changes
      if (!inner || typeof inner !== 'object' || Array.isArray(inner)) throw new HttpError(400, 'Expected a changes object')
      changes = inner as Record<string, unknown>
      clear = payload.clear === true
    }
    if (Object.keys(changes).length > MAX_CHANGES_PER_REQUEST) throw new HttpError(413, 'Too many entries in one request')
    await db.write((handle) => applyLibraryChanges(handle, changes, clear))
    sendNoContent(res)
    return
  }
  sendError(res, 405, 'Method not allowed', { Allow: 'GET, HEAD, POST' })
}

export async function handleSettings(req: Req, res: Res, db: Database) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    const settings = await db.read(readSettings)
    sendJson(res, 200, settings, { 'Cache-Control': 'no-store' })
    return
  }
  if (req.method === 'POST') {
    const changes = await readJsonObject(req, MAX_SETTINGS_BODY_BYTES)
    await db.write((handle) => writeSettings(handle, changes))
    sendNoContent(res)
    return
  }
  sendError(res, 405, 'Method not allowed', { Allow: 'GET, HEAD, POST' })
}
