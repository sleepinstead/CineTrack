/**
 * The library record and its validation rules.
 *
 * This module is pure (no React, no DOM, no network) so the browser store and
 * the local API server share one definition of what a valid record is. Any
 * rule changed here applies to both sides at once.
 */
import { isSafeCustomPosterDataUrl } from './custom-poster.ts'
import { MAX_REWATCHES, STATUS_IDS, type Status } from './status.ts'

export type MediaType = 'movie' | 'tv'

export type Entry = {
  id: number
  mediaType: MediaType
  title: string
  year: string
  poster: string | null
  /** Compact WebP image uploaded by the user; the TMDb poster path stays in `poster`. */
  customPoster: string | null
  backdrop: string | null
  rating: number | null // personal 1–10
  status: Status
  favorite: boolean
  addedAt: number
  /** Movies: timestamp of the watch. */
  watchedAt: number | null
  runtime: number | null
  /** TV: "season-episode" → timestamp watched. */
  episodes: Record<string, number>
  totalEpisodes: number | null
  /** Timestamps of additional complete watch-throughs, beyond the first. */
  rewatches: number[]
  /** A TV rewatch is tracked separately from the original completed run. */
  rewatching: boolean
  rewatchEpisodes: Record<string, number>
  /** Retired: free-text notes were removed from the UI. Kept for back-compat. */
  note?: string
}

export const MAX_TITLE_LEN = 200
export const MAX_NOTE_LEN = 2000
export const MAX_IMAGE_PATH_LEN = 500
export const MAX_RUNTIME = 600
export const MAX_TOTAL_EPISODES = 10000
export const MAX_EPISODE_KEYS = 20000
export const MAX_TIMESTAMP = 8_640_000_000_000_000
/** Upper bound on titles accepted by one save request (clients send far fewer). */
export const MAX_CHANGES_PER_REQUEST = 5000
/** Upper bound on titles in one imported backup file. */
export const MAX_IMPORT_ENTRIES = 50_000

const EPISODE_KEY = /^\d+-\d+$/

export const epKey = (s: number, e: number) => `${s}-${e}`
export const entryKey = (type: MediaType, id: number) => `${type}:${id}`

/** Map keys must be `movie:<id>` / `tv:<id>` — anything else (incl. __proto__
 *  style keys from crafted data) is dropped before it can touch the store. */
export function isSafeKey(key: unknown): key is string {
  if (typeof key !== 'string') return false
  const match = /^(movie|tv):(\d+)$/.exec(key)
  return !!match && Number.isSafeInteger(Number(match[2])) && Number(match[2]) > 0
}

export function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= MAX_TIMESTAMP
}

/** TMDb-relative image paths only: leading slash, no scheme/host/traversal.
 *  Shared by img() and record normalization so a crafted payload can never
 *  store an arbitrary URL into the library. */
export function isSafeImagePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length > MAX_IMAGE_PATH_LEN) return false
  if (path.includes('..') || path.includes('\\') || !path.startsWith('/')) return false
  return /^\/[A-Za-z0-9/_\-.]+$/.test(path)
}

function finiteOrNull(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function clampInt(n: unknown, max: number): number | null {
  const value = finiteOrNull(n)
  return value == null ? null : Math.min(max, Math.max(0, Math.floor(value)))
}

/** Keep only well-formed `season-episode → timestamp` pairs, bounded in count. */
function cleanEpisodeLog(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const valid: [string, number][] = []
  for (const [key, stamp] of Object.entries(raw as Record<string, unknown>)) {
    if (EPISODE_KEY.test(key) && isValidTimestamp(stamp)) valid.push([key, stamp])
  }
  // Bound per-entry growth so one crafted row can't stall every commit.
  for (const [key, stamp] of valid.slice(-MAX_EPISODE_KEYS)) out[key] = stamp
  return out
}

/**
 * Bring a stored or incoming record up to the current shape: rename the
 * retired 'completed' status, coerce every scalar, and drop malformed episode
 * / rewatch timestamps — so one bad row can never crash a whole view.
 *
 * Returns a new object; the input is never mutated.
 */
export function normalizeEntry(input: Entry): Entry {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof Entry, unknown>>
  const mediaType: MediaType = raw.mediaType === 'tv' ? 'tv' : 'movie'

  let status: Status = raw.status === 'completed' ? 'watched' : (raw.status as Status)
  if (!STATUS_IDS.includes(status)) status = 'planned'
  // Movies have no Dropped state; keep their data and move them to Planned.
  if (mediaType === 'movie' && status === 'dropped') status = 'planned'

  const episodes = cleanEpisodeLog(raw.episodes)
  // Dropped is only meaningful while a show has recorded progress; the server
  // rejects Dropped rows with an empty log.
  if (mediaType === 'tv' && status === 'dropped' && Object.keys(episodes).length === 0) status = 'planned'

  const rating = raw.rating
  const entry: Entry = {
    id: Number.isSafeInteger(raw.id) && (raw.id as number) > 0 ? (raw.id as number) : 0,
    mediaType,
    title: typeof raw.title === 'string' && raw.title ? raw.title.slice(0, MAX_TITLE_LEN) : 'Untitled',
    year: typeof raw.year === 'string' ? raw.year.slice(0, 4) : '',
    poster: isSafeImagePath(raw.poster) ? raw.poster : null,
    customPoster: isSafeCustomPosterDataUrl(raw.customPoster) ? raw.customPoster : null,
    backdrop: isSafeImagePath(raw.backdrop) ? raw.backdrop : null,
    rating: typeof rating === 'number' && Number.isInteger(rating) && rating >= 1 && rating <= 10 ? rating : null,
    status,
    favorite: raw.favorite === true || raw.favorite === 1,
    addedAt: isValidTimestamp(raw.addedAt) ? raw.addedAt : Date.now(),
    watchedAt: isValidTimestamp(raw.watchedAt) ? raw.watchedAt : null,
    runtime: clampInt(raw.runtime, MAX_RUNTIME),
    episodes,
    totalEpisodes: clampInt(raw.totalEpisodes, MAX_TOTAL_EPISODES),
    rewatches: Array.isArray(raw.rewatches) ? raw.rewatches.filter(isValidTimestamp).slice(-MAX_REWATCHES) : [],
    rewatching: mediaType === 'tv' && status === 'watched' && raw.rewatching === true,
    rewatchEpisodes: mediaType === 'tv' ? cleanEpisodeLog(raw.rewatchEpisodes) : {},
  }
  if (typeof raw.note === 'string' && raw.note) entry.note = raw.note.slice(0, MAX_NOTE_LEN)
  return entry
}

/** Normalize a record stored under `key`, or null when it doesn't belong there. */
export function normalizeKeyedEntry(key: string, value: unknown): Entry | null {
  if (!isSafeKey(key) || !value || typeof value !== 'object' || Array.isArray(value)) return null
  const [mediaType, rawId] = key.split(':')
  const raw = value as Partial<Entry>
  // The key is authoritative: a row whose body names another title is corrupt.
  if (raw.mediaType !== mediaType || raw.id !== Number(rawId)) return null
  return normalizeEntry(value as Entry)
}
