import { useCallback, useSyncExternalStore } from 'react'
import type { TmdbTitle } from './tmdb'
import { titleOf, yearOf } from './tmdb'
import { currentSettings } from './settings'
import { setPersistenceState, unrefTimer } from './persistence'
import { advanceRewatch, appendRewatchStamp, canSetDropped, MAX_REWATCHES, statusAfterEpisodeProgress, watchedAtAfterProgress, type Status } from './status'
import {
  entryKey,
  epKey,
  isValidTimestamp,
  MAX_IMPORT_ENTRIES,
  normalizeEntry,
  normalizeKeyedEntry,
  type Entry,
  type MediaType,
} from './entry'
export type { Status } from './status'
export type { Entry } from './entry'
export { entryKey, epKey, isSafeKey, isValidTimestamp, normalizeEntry } from './entry'

const LEGACY_STORAGE = 'archive.library.v1'
const LEGACY_CORRUPT_STORAGE = 'archive.library.v1.corrupt'
export const MAX_LIBRARY_FILE_BYTES = 80 * 1024 * 1024

/** Validate + normalize a raw id-keyed map, dropping unsafe keys entirely. */
function sanitizeMap(raw: unknown): Record<string, Entry> {
  const out: Record<string, Entry> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  let dropped = 0
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalized = normalizeKeyedEntry(key, value)
    if (normalized) out[key] = normalized
    else dropped++
  }
  if (dropped > 0) console.warn(`[library] dropped ${dropped} invalid stored rows`)
  return out
}

function readLegacySnapshot(): Record<string, Entry> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(LEGACY_STORAGE)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return sanitizeMap(parsed)
  } catch {
    try {
      localStorage.removeItem(LEGACY_STORAGE)
      console.warn('[library] invalid legacy browser data was discarded')
    } catch {}
    return {}
  }
}

function clearLegacyStorage() {
  try {
    localStorage.removeItem(LEGACY_STORAGE)
    localStorage.removeItem(LEGACY_CORRUPT_STORAGE)
  } catch {
    // The database is already authoritative; inaccessible browser storage is harmless.
  }
}

/** Merge event histories idempotently while preserving distinct events that
 *  happen to share a timestamp (for example, imports created in one tick). */
function mergeTimestampHistory(first: number[], second: number[]): number[] {
  const counts = new Map<number, number>()
  for (const timestamp of first) counts.set(timestamp, (counts.get(timestamp) ?? 0) + 1)
  const secondCounts = new Map<number, number>()
  for (const timestamp of second) secondCounts.set(timestamp, (secondCounts.get(timestamp) ?? 0) + 1)
  for (const [timestamp, count] of secondCounts) {
    counts.set(timestamp, Math.max(counts.get(timestamp) ?? 0, count))
  }
  return [...counts].flatMap(([timestamp, count]) => Array(count).fill(timestamp))
    .sort((a, b) => a - b)
    .slice(-MAX_REWATCHES)
}

const listeners = new Set<() => void>()
const subscribeStore = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
const noopSubscribe = () => () => {}
let cache = readLegacySnapshot()
const legacySnapshot = { ...cache }
/**
 * Stable array snapshot. Rebuilt only on commit, so consumers can safely use
 * `entries` as a hook dependency — a fresh Object.values() per render would
 * invalidate every downstream useMemo/useCallback and loop their effects.
 */
let snapshot = Object.values(cache)

function publish(next: Record<string, Entry>) {
  cache = next
  snapshot = Object.values(next)
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch (e) {
      console.error('[library] subscriber failed', e)
    }
  }
}

/* ---------- load / save status ---------- */

export type LibraryStatus = {
  /** The library has been loaded from the database; edits are allowed. */
  hydrated: boolean
  /** Why the initial load is failing (it keeps retrying), if it is. */
  loadError: string | null
  /** Why the latest save was rejected or is being retried, if it was. */
  saveError: string | null
}
let status: LibraryStatus = { hydrated: false, loadError: null, saveError: null }
const statusListeners = new Set<() => void>()
function setStatus(patch: Partial<LibraryStatus>) {
  const next = { ...status, ...patch }
  if (next.hydrated === status.hydrated && next.loadError === status.loadError && next.saveError === status.saveError) return
  status = next
  for (const fn of [...statusListeners]) fn()
}
const subscribeStatus = (fn: () => void) => {
  statusListeners.add(fn)
  return () => {
    statusListeners.delete(fn)
  }
}
export function useLibraryStatus(): LibraryStatus {
  return useSyncExternalStore(subscribeStatus, () => status, () => status)
}
export function isLibraryHydrated(): boolean {
  return status.hydrated
}

/**
 * SQLite at data/database.sqlite is the persistent source of truth. Existing
 * browser storage is read once for migration and removed after the database
 * confirms that the merged snapshot was saved.
 */
const DB_ENDPOINT = '/__data/library'

/** Coalesce rapid per-record changes; the latest value per key wins. */
const pendingDatabaseChanges = new Map<string, Entry | null>()
let pendingDatabaseClear = false
let databaseWriteRunning = false
let databaseRetryTimer: ReturnType<typeof setTimeout> | null = null
let databaseRetryDelay = 1000

/** Per-request bounds, comfortably under the server's 32 MB / 5,000-key caps. */
const MAX_CHANGES_REQUEST_BYTES = 16 * 1024 * 1024
const MAX_CHANGES_REQUEST_KEYS = 1000
/** Statuses that can never succeed on retry: the batch is invalid or oversized. */
const PERMANENT_DB_FAILURE_STATUSES = new Set([400, 404, 405, 413, 414, 415, 422])

/** True while edits exist that the database has not confirmed. */
export function hasUnsavedLibraryChanges(): boolean {
  return databaseWriteRunning || pendingDatabaseClear || pendingDatabaseChanges.size > 0
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body?.error === 'string' && body.error) return body.error.slice(0, 200)
  } catch {
    // Not JSON.
  }
  return `The database answered ${res.status}`
}

/** Take up to one request's worth of pending changes out of the queue. */
function takeDatabaseChangesChunk(): Record<string, Entry | null> {
  const out: Record<string, Entry | null> = {}
  let bytes = 0
  let count = 0
  for (const [key, value] of pendingDatabaseChanges) {
    let entryBytes: number
    if (value == null) {
      entryBytes = 4
    } else {
      try {
        entryBytes = JSON.stringify(value).length
      } catch {
        entryBytes = MAX_CHANGES_REQUEST_BYTES // Never send an entry we cannot serialize.
      }
    }
    const total = bytes + key.length + entryBytes
    if (count > 0 && (total > MAX_CHANGES_REQUEST_BYTES || count >= MAX_CHANGES_REQUEST_KEYS)) break
    out[key] = value
    bytes = total
    count++
  }
  for (const key of Object.keys(out)) pendingDatabaseChanges.delete(key)
  return out
}

function scheduleDatabaseRetry() {
  if (databaseRetryTimer) return
  databaseRetryTimer = setTimeout(() => {
    databaseRetryTimer = null
    void flushDatabaseChanges()
  }, databaseRetryDelay)
  unrefTimer(databaseRetryTimer)
  databaseRetryDelay = Math.min(databaseRetryDelay * 2, 30_000)
}

/** After the server refused some keys, show what it actually holds for them. */
async function reconcileKeys(keys: string[]) {
  try {
    const res = await fetch(DB_ENDPOINT, { cache: 'no-store' })
    if (!res.ok) return
    const stored = sanitizeMap(await res.json())
    const next = { ...cache }
    for (const key of keys) {
      if (pendingDatabaseChanges.has(key)) continue // A newer local edit is on its way.
      if (stored[key]) next[key] = stored[key]
      else delete next[key]
    }
    publish(next)
  } catch {
    // Best effort; the next reload shows the stored state anyway.
  }
}

async function flushDatabaseChanges() {
  if (databaseWriteRunning || (!pendingDatabaseClear && pendingDatabaseChanges.size === 0)) return
  if (databaseRetryTimer) {
    clearTimeout(databaseRetryTimer)
    databaseRetryTimer = null
  }
  databaseWriteRunning = true
  setPersistenceState('library', 'saving')
  const rejectedKeys: string[] = []
  let rejection: string | null = null
  let retrying = false
  try {
    while (pendingDatabaseClear || pendingDatabaseChanges.size > 0) {
      const clearLibrary = pendingDatabaseClear
      pendingDatabaseClear = false
      const changes = takeDatabaseChangesChunk()
      const body = JSON.stringify({ clear: clearLibrary, changes })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 20_000)
      try {
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
        const keepalive = hidden && new TextEncoder().encode(body).byteLength <= 64 * 1024
        const res = await fetch(DB_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive,
          signal: controller.signal,
        })
        if (!res.ok) {
          const message = await readErrorMessage(res)
          if (PERMANENT_DB_FAILURE_STATUSES.has(res.status)) {
            // Retrying can never succeed. Drop only this batch so it cannot
            // wedge later saves, and carry on with the rest of the queue.
            console.error(`[library] the database rejected ${Object.keys(changes).length} change(s): ${message}`)
            rejection = message
            rejectedKeys.push(...Object.keys(changes))
            continue
          }
          throw new Error(message)
        }
        clearLegacyStorage()
        databaseRetryDelay = 1000
      } catch (e) {
        // Keep the latest value per key: a newer edit made during this
        // request already occupies the map and must win over this batch.
        for (const [key, value] of Object.entries(changes)) {
          if (!pendingDatabaseChanges.has(key)) pendingDatabaseChanges.set(key, value)
        }
        if (clearLibrary) pendingDatabaseClear = true
        console.warn('[library] database unavailable; changes will be retried', e)
        const aborted = (e as Error).name === 'AbortError'
        setStatus({ saveError: aborted ? 'Saving is taking longer than expected — retrying.' : "Can't reach the local database — retrying." })
        retrying = true
        scheduleDatabaseRetry()
        break
      } finally {
        clearTimeout(timeout)
      }
    }
  } finally {
    databaseWriteRunning = false
    if (rejection) {
      setStatus({ saveError: `Some changes couldn't be saved: ${rejection}` })
      setPersistenceState('library', 'error')
      void reconcileKeys(rejectedKeys)
    } else if (retrying) {
      setPersistenceState('library', 'error')
    } else if (!pendingDatabaseClear && pendingDatabaseChanges.size === 0) {
      setStatus({ saveError: null })
      setPersistenceState('library', 'saved')
    }
  }
}

function saveToDatabase(changes: Record<string, Entry | null>, clearLibrary = false) {
  if (clearLibrary) {
    // The clear supersedes every queued change and per-key deletion.
    pendingDatabaseClear = true
    pendingDatabaseChanges.clear()
  }
  for (const [key, value] of Object.entries(changes)) {
    if (clearLibrary && value === null) continue
    pendingDatabaseChanges.set(key, value)
  }
  if (pendingDatabaseClear || pendingDatabaseChanges.size > 0) void flushDatabaseChanges()
}

function diffEntries(before: Record<string, Entry>, after: Record<string, Entry>) {
  const changes: Record<string, Entry | null> = {}
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = after[key] ?? null
  }
  return changes
}

/* ---------- cross-tab sync ---------- */

type TabMessage = { changes: Record<string, Entry | null>; clear: boolean }
const tabChannel: BroadcastChannel | null =
  typeof window !== 'undefined' && typeof BroadcastChannel === 'function' ? new BroadcastChannel('cinetrack-library') : null

/** Apply another tab's committed edits so this tab never saves stale rows over them. */
tabChannel?.addEventListener('message', (event: MessageEvent<TabMessage>) => {
  if (!status.hydrated) return // This tab loads fresh data from the database anyway.
  const data = event.data
  if (!data || typeof data !== 'object' || !data.changes || typeof data.changes !== 'object') return
  const next = data.clear === true ? {} : { ...cache }
  for (const [key, value] of Object.entries(data.changes)) {
    if (value === null) {
      delete next[key]
      continue
    }
    const entry = normalizeKeyedEntry(key, value)
    if (entry) next[key] = entry
  }
  publish(next)
})

function commit(next: Record<string, Entry>, changes = diffEntries(cache, next), clearLibrary = false) {
  // Subscribers first: the UI reflects edits even if the database is offline.
  publish(next)
  saveToDatabase(changes, clearLibrary)
  try {
    const shared = clearLibrary
      ? Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== null))
      : changes
    tabChannel?.postMessage({ changes: shared, clear: clearLibrary } satisfies TabMessage)
  } catch {
    // Other tabs pick the change up on their next load.
  }
}

/* ---------- initial load ---------- */

let hydrationAttempt = 0
let hydrationTimer: ReturnType<typeof setTimeout> | null = null
let hydrationRunning = false

/**
 * Load the canonical database, merge any records from the previous browser
 * store, and persist that one-time migration before removing the old copy.
 * A failed load retries with backoff; until it succeeds the library is
 * read-only, so nothing can be saved over records the app hasn't seen.
 */
async function hydrateFromSqlite() {
  if (status.hydrated || hydrationRunning) return
  if (typeof fetch !== 'function') return
  hydrationRunning = true
  let raw: unknown
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const res = await fetch(DB_ENDPOINT, { signal: controller.signal, cache: 'no-store' })
      if (!res.ok) throw new Error(await readErrorMessage(res))
      if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
        throw new Error('The local database returned an unexpected response.')
      }
      raw = await res.json()
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    hydrationRunning = false
    const message = error instanceof TypeError || (error as Error).name === 'AbortError'
      ? "Can't reach the local database. Is the CineTrack server running?"
      : (error as Error).message
    setStatus({ loadError: message })
    setPersistenceState('library', 'error')
    const delay = Math.min(30_000, 1000 * 2 ** hydrationAttempt++)
    hydrationTimer = setTimeout(() => {
      hydrationTimer = null
      void hydrateFromSqlite()
    }, delay)
    unrefTimer(hydrationTimer)
    return
  }
  hydrationRunning = false

  const databaseSnapshot = sanitizeMap(raw)
  const merged = { ...databaseSnapshot }
  for (const [key, legacyEntry] of Object.entries(legacySnapshot)) {
    const storedEntry = merged[key]
    merged[key] = storedEntry ? mergeImportedEntry(legacyEntry, storedEntry) : legacyEntry
  }
  const changes = diffEntries(databaseSnapshot, merged)
  // sanitizeMap normalizes the in-memory copy, so explicitly persist the
  // one-time status correction for legacy movie rows in SQLite as well.
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      const rawEntry = value as Partial<Entry> | null
      if (merged[key] && rawEntry?.mediaType === 'movie' && rawEntry.status === 'dropped') changes[key] = merged[key]
    }
  }
  setStatus({ hydrated: true, loadError: null })
  publish(merged)
  if (Object.keys(changes).length > 0) saveToDatabase(changes)
  else {
    clearLegacyStorage()
    setPersistenceState('library', 'saved')
  }
}

/** Retry a failed initial load right away (e.g. from a "Retry" button). */
export function retryLibraryLoad() {
  if (status.hydrated) return
  if (hydrationTimer) {
    clearTimeout(hydrationTimer)
    hydrationTimer = null
  }
  hydrationAttempt = 0
  void hydrateFromSqlite()
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    retryLibraryLoad()
    void flushDatabaseChanges()
  })
  window.addEventListener('focus', () => {
    if (status.loadError) retryLibraryLoad()
  })
  // Hidden pages may be frozen or discarded: push queued edits out now.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushDatabaseChanges()
  })
}

void hydrateFromSqlite()

/* ---------- React bindings ---------- */

/** Subscribe to a single record: re-renders only when that title changes. */
export function useEntry(type: MediaType, id: number): Entry | undefined {
  const key = entryKey(type, id)
  return useSyncExternalStore(subscribeStore, () => cache[key], () => cache[key])
}

export function useLibrary(subscribeToStore = true) {
  const entries = useSyncExternalStore(subscribeToStore ? subscribeStore : noopSubscribe, () => snapshot, () => snapshot)

  const get = useCallback((type: MediaType, id: number) => cache[entryKey(type, id)], [])

  const upsert = useCallback((type: MediaType, id: number, patch: Partial<Entry>, seed?: TmdbTitle) => {
    if (!status.hydrated) return
    if ((type !== 'movie' && type !== 'tv') || !Number.isSafeInteger(id) || id <= 0) return
    const key = entryKey(type, id)
    const existing = cache[key]
    if (patch.status === 'dropped' && !canSetDropped(type, existing?.status ?? 'planned', Object.keys(existing?.episodes ?? {}).length)) return
    const base: Entry = existing ?? {
      id,
      mediaType: type,
      title: seed ? titleOf(seed) : 'Untitled',
      year: seed ? yearOf(seed) : '',
      poster: seed?.poster_path ?? null,
      customPoster: null,
      backdrop: null, // retired: no backdrop UI ships, so don't mirror dead weight
      rating: null,
      status: 'planned',
      favorite: false,
      addedAt: Date.now(),
      watchedAt: null,
      runtime: null,
      episodes: {},
      totalEpisodes: null,
      rewatches: [],
      rewatching: false,
      rewatchEpisodes: {},
    }
    const updated = normalizeEntry({ ...base, ...patch })
    commit({ ...cache, [key]: updated }, { [key]: updated })
  }, [])

  const remove = useCallback((type: MediaType, id: number) => {
    if (!status.hydrated) return
    if ((type !== 'movie' && type !== 'tv') || !Number.isSafeInteger(id) || id <= 0) return
    const next = { ...cache }
    delete next[entryKey(type, id)]
    commit(next, { [entryKey(type, id)]: null })
  }, [])

  /** Put back a record exactly as it was (undo for delete and edits). */
  const restore = useCallback((entry: Entry) => {
    if (!status.hydrated) return
    const key = entryKey(entry.mediaType, entry.id)
    const normalized = normalizeKeyedEntry(key, entry)
    if (!normalized) return
    commit({ ...cache, [key]: normalized }, { [key]: normalized })
  }, [])

  /** `at` backdates the log; defaults to now. Ignores non-integer season/episodes. */
  const toggleEpisode = useCallback((id: number, s: number, e: number, at?: number) => {
    if (!status.hydrated) return
    if (!Number.isInteger(id) || !Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < 0) return
    const key = entryKey('tv', id)
    const entry = cache[key]
    if (!entry) return
    if (entry.status === 'watched' && !entry.rewatching) return
    const k = epKey(s, e)
    const stamp = isValidTimestamp(at) ? at : Date.now()
    const episodes = { ...(entry.rewatching ? entry.rewatchEpisodes : entry.episodes) }
    if (Object.prototype.hasOwnProperty.call(episodes, k)) delete episodes[k]
    else episodes[k] = stamp
    commitEpisodeLog(key, entry, episodes)
  }, [])

  const setSeasonWatched = useCallback((id: number, s: number, numbers: number[], watched: boolean, at?: number) => {
    if (!status.hydrated) return
    if (!Number.isInteger(id) || !Number.isInteger(s) || s < 0 || !Array.isArray(numbers)) return
    const key = entryKey('tv', id)
    const entry = cache[key]
    if (!entry) return
    if (entry.status === 'watched' && !entry.rewatching) return
    const episodes = { ...(entry.rewatching ? entry.rewatchEpisodes : entry.episodes) }
    const stamp = isValidTimestamp(at) ? at : Date.now()
    for (const n of numbers) {
      if (!Number.isInteger(n) || n < 0) continue
      if (watched) episodes[epKey(s, n)] = episodes[epKey(s, n)] ?? stamp
      else delete episodes[epKey(s, n)]
    }
    commitEpisodeLog(key, entry, episodes)
  }, [])

  const setRewatching = useCallback((id: number, rewatching: boolean) => {
    if (!status.hydrated) return
    const key = entryKey('tv', id)
    const entry = cache[key]
    if (!entry || entry.mediaType !== 'tv' || entry.status !== 'watched') return
    const updated = normalizeEntry({ ...entry, rewatching })
    commit({ ...cache, [key]: updated }, { [key]: updated })
  }, [])

  /** Log an additional watch-through at `at` (defaults to now). Capped at MAX_REWATCHES. */
  const addRewatch = useCallback((type: MediaType, id: number, at?: number) => {
    if (!status.hydrated) return
    const key = entryKey(type, id)
    const entry = cache[key]
    if (!entry || !canLogRewatch(entry)) return
    const stamp = at ?? Date.now()
    if (!isValidTimestamp(stamp)) return
    const updated = { ...entry, rewatches: appendRewatchStamp(entry.rewatches, stamp) }
    commit({ ...cache, [key]: updated }, { [key]: updated })
  }, [])

  /** Rewrite one logged rewatch date by its index. */
  const setRewatchDate = useCallback((type: MediaType, id: number, index: number, at: number) => {
    if (!status.hydrated || !isValidTimestamp(at)) return
    const key = entryKey(type, id)
    const entry = cache[key]
    if (!entry || !Number.isInteger(index) || index < 0 || index >= entry.rewatches.length) return
    const rewatches = [...entry.rewatches]
    rewatches[index] = at
    rewatches.sort((a, b) => a - b)
    const updated = { ...entry, rewatches }
    commit({ ...cache, [key]: updated }, { [key]: updated })
  }, [])

  const removeRewatch = useCallback((type: MediaType, id: number, index: number) => {
    if (!status.hydrated) return
    const key = entryKey(type, id)
    const entry = cache[key]
    if (!entry) return
    const updated = { ...entry, rewatches: entry.rewatches.filter((_, i) => i !== index) }
    commit({ ...cache, [key]: updated }, { [key]: updated })
  }, [])

  /** Erase the whole library. Returns the erased records so the caller can offer undo. */
  const clear = useCallback((): Entry[] => {
    if (!status.hydrated) return []
    const erased = Object.values(cache)
    commit({}, Object.fromEntries(Object.keys(cache).map((key) => [key, null])), true)
    return erased
  }, [])

  /** Replace the whole library with `next` (used by undo-erase and tests). */
  const replaceAll = useCallback((next: Record<string, Entry>) => {
    if (!status.hydrated) return
    commit(sanitizeMap(next))
  }, [])

  /** Merge imported records into the live library; only the touched keys are saved. */
  const importEntries = useCallback((incoming: readonly Entry[]) => {
    if (!status.hydrated) return { imported: 0, combined: 0 }
    const next = { ...cache }
    const changes: Record<string, Entry> = {}
    let imported = 0
    let combined = 0
    for (const entry of incoming) {
      const key = entryKey(entry.mediaType, entry.id)
      const current = next[key]
      const merged = current ? mergeImportedEntry(current, entry) : entry
      if (current) combined++
      else imported++
      if (JSON.stringify(current) !== JSON.stringify(merged)) {
        next[key] = merged
        changes[key] = merged
      }
    }
    if (Object.keys(changes).length > 0) commit(next, changes)
    return { imported, combined }
  }, [])

  return {
    entries,
    get,
    upsert,
    remove,
    restore,
    toggleEpisode,
    setSeasonWatched,
    setRewatching,
    addRewatch,
    setRewatchDate,
    removeRewatch,
    replaceAll,
    importEntries,
    clear,
  }
}

/** Apply an edited episode log, moving status/completion along with it. */
function commitEpisodeLog(key: string, entry: Entry, episodes: Record<string, number>) {
  let updated: Entry
  if (entry.rewatching) {
    updated = { ...entry, ...advanceRewatch(entry, episodes, entry.totalEpisodes) }
  } else {
    const status = statusAfterEpisodeProgress(currentSettings().autoCompleteSeries, Object.keys(episodes).length, entry.totalEpisodes)
    const watchedAt = watchedAtAfterProgress(entry.status, status === 'watched', entry.watchedAt, maxTime(Object.values(episodes)))
    updated = { ...entry, episodes, status, watchedAt }
  }
  commit({ ...cache, [key]: updated }, { [key]: updated })
}

export type ImportResult = {
  /** Valid records from the file, normalized (pass to `importEntries`). */
  entries: Entry[]
  /** Preview of the library after merging into `existing`. */
  merged: Record<string, Entry>
  imported: number
  skipped: number
  combined: number
  /** Settings carried by a full backup file; absent for plain library exports. */
  settings: Record<string, unknown> | null
}

/** Identifies CineTrack backup files; bare arrays are the original export format. */
export const BACKUP_FORMAT = 'cinetrack-backup'
export const BACKUP_VERSION = 2

/** Serialize the library (and optionally settings) into a versioned backup document. */
export function buildBackup(entries: readonly Entry[], settings?: Record<string, unknown>): string {
  return JSON.stringify(
    {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      library: entries,
      ...(settings ? { settings } : {}),
    },
    null,
    2,
  )
}

/** Keep existing curated fields on collisions; imports can contribute missing
 * metadata and viewing progress without erasing the current library. */
function mergeImportedEntry(existing: Entry, incoming: Entry): Entry {
  const rewatches = mergeTimestampHistory(existing.rewatches, incoming.rewatches)
  return {
    ...incoming,
    ...existing,
    episodes: { ...incoming.episodes, ...existing.episodes },
    rewatchEpisodes: { ...incoming.rewatchEpisodes, ...existing.rewatchEpisodes },
    rewatching: existing.rewatching || incoming.rewatching,
    rewatches,
    rating: existing.rating ?? incoming.rating,
    favorite: existing.favorite || incoming.favorite,
    watchedAt: existing.watchedAt ?? incoming.watchedAt,
    runtime: existing.runtime ?? incoming.runtime,
    totalEpisodes: existing.totalEpisodes ?? incoming.totalEpisodes,
    poster: existing.poster ?? incoming.poster,
    customPoster: existing.customPoster ?? incoming.customPoster ?? null,
    backdrop: existing.backdrop ?? incoming.backdrop,
    title: existing.title || incoming.title,
    year: existing.year || incoming.year,
    addedAt: Math.min(existing.addedAt, incoming.addedAt),
  }
}

/** Validate a library JSON file and merge it without replacing curated data. */
export function parseLibraryImport(text: string, existing: readonly Entry[]): ImportResult {
  if (text.length > MAX_LIBRARY_FILE_BYTES) throw new Error('File too large — the maximum is 80 MB.')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Not a CineTrack JSON export — file could not be read.')
  }
  let list: unknown = parsed
  let settings: Record<string, unknown> | null = null
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const doc = parsed as Record<string, unknown>
    if (doc.format !== BACKUP_FORMAT) throw new Error('Not a CineTrack JSON export — expected a list of titles.')
    if (typeof doc.version !== 'number' || doc.version > BACKUP_VERSION) {
      throw new Error('This backup was made by a newer version of CineTrack.')
    }
    list = doc.library
    if (doc.settings && typeof doc.settings === 'object' && !Array.isArray(doc.settings)) {
      settings = doc.settings as Record<string, unknown>
    }
  }
  if (!Array.isArray(list)) throw new Error('Not a CineTrack JSON export — expected a list of titles.')
  if (list.length > MAX_IMPORT_ENTRIES) {
    throw new Error(`Too many entries — max ${MAX_IMPORT_ENTRIES.toLocaleString('en-US')} titles per import.`)
  }
  const merged: Record<string, Entry> = {}
  for (const entry of existing) merged[entryKey(entry.mediaType, entry.id)] = entry
  const entries: Entry[] = []
  let imported = 0
  let skipped = 0
  let combined = 0
  for (const raw of list) {
    const candidate = raw as Partial<Entry> | null
    const key = candidate && typeof candidate === 'object' ? `${candidate.mediaType}:${candidate.id}` : ''
    const incoming = normalizeKeyedEntry(key, candidate)
    if (!incoming) {
      skipped++
      continue
    }
    entries.push(incoming)
    const current = merged[key]
    if (current) {
      merged[key] = mergeImportedEntry(current, incoming)
      combined++
    } else {
      merged[key] = incoming
      imported++
    }
  }
  return { entries, merged, imported, skipped, combined, settings }
}

/* ---------- date helpers ---------- */

/** Timestamp → yyyy-mm-dd in local time (toISOString would shift the day). */
export function toDateInput(ts: number) {
  if (!isValidTimestamp(ts)) return ''
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** yyyy-mm-dd → timestamp at local midday, keeping the day stable across zones.
 *  Returns null for malformed input (including rolled-over dates like Feb 30)
 *  instead of NaN or a silently wrong day. */
export function fromDateInput(value: string): number | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  const ts = new Date(y, mo - 1, d, 12).getTime()
  if (!Number.isFinite(ts)) return null
  const check = new Date(ts)
  if (check.getFullYear() !== y || check.getMonth() !== mo - 1 || check.getDate() !== d) return null
  return ts
}

export const todayInput = () => toDateInput(Date.now())

/* ---------- derived metrics ---------- */

export function countStatuses(entries: Entry[]): Record<Status, number> {
  const counts: Record<Status, number> = { planned: 0, watching: 0, watched: 0, dropped: 0 }
  for (const entry of entries) {
    const status = entry.status === 'dropped' && entry.mediaType !== 'tv' ? 'planned' : entry.status
    counts[status]++
  }
  return counts
}

export const watchedCount = (e: Entry) => Object.keys(e.episodes ?? {}).length

/** Latest timestamp in a list without spread (avoids stack overflow on huge maps). */
function maxTime(times: readonly unknown[]): number | null {
  let max: number | null = null
  for (const t of times) {
    if (typeof t !== 'number' || !Number.isFinite(t)) continue
    if (max == null || t > max) max = t
  }
  return max
}

const validStamp = isValidTimestamp

export function progress(e: Entry) {
  if (e.mediaType === 'movie') return e.watchedAt != null && validStamp(e.watchedAt) ? 1 : 0
  if (!e.totalEpisodes || e.totalEpisodes <= 0) return 0
  const seen = e.rewatching ? Object.keys(e.rewatchEpisodes).length : watchedCount(e)
  return Math.min(1, Math.max(0, seen / e.totalEpisodes))
}

/** Episodes from the original run, finished rewatches, and a partial rewatch. */
export function loggedEpisodeCount(e: Entry): number {
  if (e.mediaType !== 'tv') return 0
  return watchedCount(e) + (e.rewatches.length * (e.totalEpisodes ?? 0)) + Object.keys(e.rewatchEpisodes).length
}

/**
 * Whether the title has been completed at least once (watched).
 * - Film: status must be 'watched'.
 * - Series: status must be 'watched', or all known episodes have been watched.
 */
export function isCompletedAtLeastOnce(entry: Entry | null | undefined): boolean {
  if (!entry) return false
  if (entry.mediaType === 'movie') {
    return entry.status === 'watched'
  }
  if (entry.status === 'watched') return true
  const total = entry.totalEpisodes
  if (typeof total === 'number' && Number.isSafeInteger(total) && total > 0) {
    return watchedCount(entry) >= total
  }
  return false
}

/**
 * Whether a rewatch can currently be logged manually for this title.
 * Requires having completed the title at least once, and not being in an active episodic TV rewatch.
 */
export function canLogRewatch(entry: Entry | null | undefined): boolean {
  if (!entry || !isCompletedAtLeastOnce(entry)) return false
  if (entry.mediaType === 'tv' && entry.rewatching) return false
  return true
}

/**
 * Explanatory reason when manual rewatch logging is unavailable.
 */
export function rewatchLockedReason(entry: Entry | null | undefined): string | null {
  if (!entry) return null
  if (!isCompletedAtLeastOnce(entry)) {
    return entry.mediaType === 'movie'
      ? 'Mark this film as watched to log a rewatch.'
      : 'Complete the series to log a rewatch.'
  }
  if (entry.mediaType === 'tv' && entry.rewatching) {
    return 'Finish the episode list to log this rewatch.'
  }
  return null
}

export function countRewatches(entries: Entry[]): number {
  return entries.reduce((sum, entry) => sum + entry.rewatches.length, 0)
}

/** Approximate minutes watched: movies use runtime per viewing; episodes assume 42m when unknown. */
export function minutesWatched(entries: Entry[]) {
  return entries.reduce((sum, e) => {
    const runtime = typeof e.runtime === 'number' && Number.isFinite(e.runtime) ? Math.max(0, e.runtime) : 0
    if (e.mediaType === 'movie') {
      const viewings = (validStamp(e.watchedAt) ? 1 : 0) + (e.rewatches ?? []).filter(validStamp).length
      return sum + viewings * (runtime || 110)
    }
    return sum + loggedEpisodeCount(e) * (runtime || 42)
  }, 0)
}

/** Consistent short date for ledger microcopy ("05 Sept"; "05 Sept 2024" for other years). */
export function formatDayMonth(at: number, now = Date.now()) {
  if (!isValidTimestamp(at)) return 'Unknown date'
  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString('en-GB', sameYear ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Friendly relative date for the ledger ("Today", "3d ago"); falls back to
 *  the absolute form once the stamp is a year or more old. */
export function formatRelativeDay(at: number, now = Date.now()) {
  if (!isValidTimestamp(at) || !isValidTimestamp(now)) return 'Unknown date'
  const day = 86_400_000
  const startOfDay = (ts: number) => {
    const d = new Date(ts)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const diff = Math.round((startOfDay(now) - startOfDay(at)) / day)
  // A future timestamp is data error, not "Today".
  if (diff < 0) return 'Unknown date'
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return `${diff}d ago`
  if (diff < 30) {
    const w = Math.floor(diff / 7)
    return w <= 1 ? '1w ago' : `${w}w ago`
  }
  if (diff < 365) {
    const m = Math.floor(diff / 30)
    return m <= 1 ? '1mo ago' : `${m}mo ago`
  }
  return formatDayMonth(at)
}

/** Original completion timestamp for a series, excluding subsequent rewatches. */
export function originalCompletionAt(e: Entry): number | null {
  if (validStamp(e.watchedAt)) return e.watchedAt
  return e.mediaType === 'tv' ? maxTime(Object.values(e.episodes ?? {})) : maxTime(e.rewatches ?? [])
}

/** Latest viewing timestamp, including completed rewatches and a show rewatch in progress. */
export function lastActivityAt(e: Entry): number | null {
  if (e.mediaType === 'movie') {
    return maxTime([e.watchedAt, ...(e.rewatches ?? [])])
  }
  return [e.watchedAt, maxTime(Object.values(e.episodes ?? {})), maxTime(e.rewatches ?? []), maxTime(Object.values(e.rewatchEpisodes ?? {}))]
    .filter(validStamp)
    .reduce<number | null>((latest, at) => latest == null ? at : Math.max(latest, at), null)
}

export type Activity = { entry: Entry; at: number; label: string }

/** Completed viewings only — no per-episode rows. Movies use watchedAt,
 *  finished series collapse to a single row at their latest episode
 *  timestamp, and rewatch logs pass through. */
export function recentCompletions(entries: Entry[], limit?: number): Activity[] {
  const events: Activity[] = []
  for (const e of entries) {
    if (e.mediaType === 'movie') {
      if (validStamp(e.watchedAt)) events.push({ entry: e, at: e.watchedAt, label: 'Film' })
    } else if (e.status === 'watched' || validStamp(e.watchedAt)) {
      const at = validStamp(e.watchedAt) ? e.watchedAt : maxTime(Object.values(e.episodes ?? {}))
      if (at != null) events.push({ entry: e, at, label: 'Series' })
    }
    for (const at of e.rewatches ?? []) {
      if (validStamp(at)) events.push({ entry: e, at, label: 'Rewatch' })
    }
  }
  events.sort((a, b) => b.at - a.at)
  return limit == null ? events : events.slice(0, limit)
}

/** Completed titles per calendar month for the trailing `months` window —
 *  each finished movie/series counts once (never per episode); rewatch logs
 *  each count as one completed viewing. */
export function activityByMonth(entries: Entry[], months = 12) {
  const buckets = new Map<string, number>()
  const bump = (at: unknown) => {
    if (!validStamp(at)) return
    const d = new Date(at)
    const key = `${d.getFullYear()}-${d.getMonth()}`
    buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  for (const e of entries) {
    if (e.mediaType === 'movie') {
      if (e.watchedAt != null) bump(e.watchedAt)
    } else if (e.status === 'watched' || validStamp(e.watchedAt)) {
      const at = validStamp(e.watchedAt) ? e.watchedAt : maxTime(Object.values(e.episodes ?? {}))
      if (at != null) bump(at)
    }
    for (const at of e.rewatches ?? []) bump(at)
  }

  const out: { month: string; label: string; count: number }[] = []
  const cursor = new Date()
  cursor.setDate(1)
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1)
    const key = `${d.getFullYear()}-${d.getMonth()}`
    out.push({
      month: key,
      label: d.toLocaleDateString(undefined, { month: 'short' }),
      count: buckets.get(key) ?? 0,
    })
  }
  return out
}
