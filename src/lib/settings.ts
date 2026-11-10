import { useCallback, useSyncExternalStore } from 'react'
import { setPersistenceState, unrefTimer } from './persistence'
import { STARTING_STATUS_IDS, type StartingStatus } from './status'
import { type ThemePreference, DEFAULT_THEME, applyTheme as applyThemeEngine, resolveThemePreference, watchSystemTheme } from './theme'

export type { ThemeId, ThemeMeta, ThemePreference } from './theme'
export { THEMES } from './theme'


export const LANGUAGES: { id: string; label: string }[] = [
  { id: 'en-US', label: 'English' },
  { id: 'de-DE', label: 'Deutsch' },
  { id: 'es-ES', label: 'Español' },
  { id: 'fr-FR', label: 'Français' },
  { id: 'it-IT', label: 'Italiano' },
  { id: 'nl-NL', label: 'Nederlands' },
  { id: 'pl-PL', label: 'Polski' },
  { id: 'pt-BR', label: 'Português' },
  { id: 'ja-JP', label: '日本語' },
  { id: 'ko-KR', label: '한국어' },
  { id: 'zh-CN', label: '中文' },
]



export type Settings = {
  theme: ThemePreference
  density: 'comfortable' | 'compact'
  hideSpoilers: boolean
  hideEpisodeCovers: boolean
  showSpecials: boolean
  autoCompleteSeries: boolean
  posterMotion: boolean
  libraryColumns: number
  discoverColumns: number
  includeAdult: boolean
  showNavHints: boolean
  defaultStatus: StartingStatus
  showCommunityScores: boolean
  metadataLanguage: string
  roundPosters: boolean
}

const DEFAULTS: Settings = {
  theme: DEFAULT_THEME,
  density: 'comfortable',
  hideSpoilers: false,
  hideEpisodeCovers: false,
  showSpecials: true,
  autoCompleteSeries: true,
  posterMotion: true,
  roundPosters: false,
  libraryColumns: 6,
  discoverColumns: 7,
  includeAdult: false,
  showNavHints: true,
  defaultStatus: 'planned',
  showCommunityScores: false,
  metadataLanguage: 'en-US',
}

const LEGACY_STORAGE = 'archive.settings.v1'
const LEGACY_CORRUPT_STORAGE = 'archive.settings.v1.corrupt'

function clamp(n: unknown, min: number, max: number, def: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n as number)))
}

function sanitize(s: Partial<Settings> & Record<string, unknown>): Settings {
  const out: Settings = { ...DEFAULTS }
  // Retired themes (and the old custom palette) map onto the four current ones.
  out.theme = resolveThemePreference(s.theme, s.customColors)
  if (s.density === 'comfortable' || s.density === 'compact') out.density = s.density
  out.hideSpoilers = !!s.hideSpoilers
  out.hideEpisodeCovers = !!s.hideEpisodeCovers
  out.showSpecials = s.showSpecials !== false
  out.autoCompleteSeries = s.autoCompleteSeries !== false
  out.posterMotion = s.posterMotion !== false
  out.showNavHints = s.showNavHints !== false
  out.showCommunityScores = !!s.showCommunityScores
  if ((STARTING_STATUS_IDS as readonly string[]).includes(s.defaultStatus as string)) {
    out.defaultStatus = s.defaultStatus as StartingStatus
  }
  if (typeof s.metadataLanguage === 'string' && LANGUAGES.some((l) => l.id === s.metadataLanguage)) {
    out.metadataLanguage = s.metadataLanguage
  }
  out.libraryColumns = clamp(s.libraryColumns, 3, 10, DEFAULTS.libraryColumns)
  out.discoverColumns = clamp(s.discoverColumns, 3, 10, DEFAULTS.discoverColumns)
  out.includeAdult = !!s.includeAdult
  out.roundPosters = !!s.roundPosters
  return out
}

/**
 * Unknown keys (written by a newer client) ride along untouched so an older
 * client can never delete them on its next write — only known keys sanitize.
 */
let extraKeys: Record<string, unknown> = {}
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const RETIRED_KEYS = new Set([
  'chartStyle', 'customColors', 'episodeWatchedColor', 'defaultShelfTab', 'shelfColumns',
  // The customisable home masthead, replaced by a greeting.
  'archiveName', 'archiveItalicWordIndex', 'archiveItalicWordIndices',
  // Settings removed to keep the panel simple; their behaviour is now fixed.
  'statusBadgeShape', 'statusBadgeSize', 'statusBadgePosition', 'statusBadgeIcon', 'statusBadgeShadow',
  'posterQuality', 'forYouColumns', 'dateStyle', 'defaultLibraryTab', 'defaultSort', 'openAfterAdd',
  'defaultWatchDate', 'blurEpisodeCovers',
])
/** The settings endpoint accepts ~10 KB per key and ~256 KB per request, so
 *  unknown keys are bounded here too — an oversized stray value would
 *  otherwise produce a body the server resets, wedging the retry loop. */
const MAX_EXTRA_KEYS = 40
const MAX_EXTRA_KEY_BYTES = 4096
function stashExtras(s: Record<string, unknown>, opts?: { merge?: boolean }) {
  if (!opts?.merge) extraKeys = {}
  for (const [k, v] of Object.entries(s)) {
    if (k in DEFAULTS || UNSAFE_KEYS.has(k) || RETIRED_KEYS.has(k)) continue
    if (!(k in extraKeys) && Object.keys(extraKeys).length >= MAX_EXTRA_KEYS) continue
    let serialized: string
    try {
      serialized = JSON.stringify(v) ?? ''
    } catch {
      continue
    }
    if (!serialized || serialized.length > MAX_EXTRA_KEY_BYTES) continue
    extraKeys[k] = v
  }
}
function withExtras(s: Settings): Record<string, unknown> {
  return { ...extraKeys, ...s }
}

let legacySettingsPresent = false

function readLegacySettings(): Settings {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULTS }
    const raw = localStorage.getItem(LEGACY_STORAGE)
    if (!raw) return { ...DEFAULTS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...DEFAULTS }
    legacySettingsPresent = true
    stashExtras(parsed as Record<string, unknown>)
    return sanitize(parsed)
  } catch {
    try {
      localStorage.removeItem(LEGACY_STORAGE)
      console.warn('[settings] invalid legacy browser settings were discarded')
    } catch {}
    return { ...DEFAULTS }
  }
}

function clearLegacyStorage() {
  try {
    localStorage.removeItem(LEGACY_STORAGE)
    localStorage.removeItem(LEGACY_CORRUPT_STORAGE)
    legacySettingsPresent = false
  } catch {
    // The database is already authoritative; inaccessible browser storage is harmless.
  }
}

let cache: Settings = readLegacySettings()
const listeners = new Set<() => void>()
let hydrating = true
let hasMutatedDuringHydration = false
/** Keys changed locally — these win over server values during hydrate merge. */
const dirtyKeys = new Set<keyof Settings>()

function getSnapshot(): Settings {
  return cache
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function notify() {
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch (e) {
      console.error(e)
    }
  }
}

export function applyTheme(theme: ThemePreference) {
  applyThemeEngine(theme, cache?.roundPosters ?? false)
}
// Follow the OS live while the preference is `system`.
watchSystemTheme(() => {
  if (cache?.theme === 'system') applyTheme('system')
})
export function applyRoundPosters(round: boolean) {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.roundPosters = round ? 'true' : 'false'
  // Refresh the pre-paint hint so the next load rounds posters immediately.
  if (cache) applyTheme(cache.theme)
}
try {
  applyTheme(cache.theme)
  applyRoundPosters(cache.roundPosters)
} catch {}

const SETTINGS_ENDPOINT = '/__data/settings'
const pendingSettingsChanges = new Map<string, unknown>()
let settingsWriteRunning = false
let settingsRetryTimer: ReturnType<typeof setTimeout> | null = null
let settingsRetryDelay = 1000
/** Statuses that can never succeed on retry: the batch is invalid or oversized. */
const PERMANENT_SETTINGS_FAILURE_STATUSES = new Set([400, 404, 405, 413, 414, 422])

function scheduleSettingsRetry() {
  if (settingsRetryTimer) return
  settingsRetryTimer = setTimeout(() => {
    settingsRetryTimer = null
    void flushSettingsChanges()
  }, settingsRetryDelay)
  unrefTimer(settingsRetryTimer)
  settingsRetryDelay = Math.min(settingsRetryDelay * 2, 30_000)
}

async function flushSettingsChanges() {
  if (settingsWriteRunning || pendingSettingsChanges.size === 0) return
  if (settingsRetryTimer) {
    clearTimeout(settingsRetryTimer)
    settingsRetryTimer = null
  }
  settingsWriteRunning = true
  setPersistenceState('settings', 'saving')
  let permanentFailure = false
  try {
    while (pendingSettingsChanges.size > 0 && !permanentFailure) {
      const changes = Object.fromEntries(pendingSettingsChanges)
      pendingSettingsChanges.clear()
      const body = JSON.stringify(changes)
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 8000)
      try {
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
        const keepalive = hidden && new TextEncoder().encode(body).byteLength <= 64 * 1024
        const res = await fetch(SETTINGS_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive,
          signal: controller.signal,
        })
        if (!res.ok) {
          const message = (await res.text().catch(() => '')).slice(0, 200)
          const permanent =
            PERMANENT_SETTINGS_FAILURE_STATUSES.has(res.status) || /too large/i.test(message)
          if (permanent) {
            // Retrying can never succeed: drop the batch instead of wedging
            // every later settings write behind an eternal retry loop.
            console.error(
              `[settings] database permanently rejected ${Object.keys(changes).length} change(s) (${res.status}${message ? ` — ${message}` : ''}); the batch was dropped and will not be retried`,
            )
            permanentFailure = true
            break
          }
          throw new Error(`Database rejected settings (${res.status})`)
        }
        clearLegacyStorage()
        settingsRetryDelay = 1000
      } catch (e) {
        for (const [key, value] of Object.entries(changes)) {
          if (!pendingSettingsChanges.has(key)) pendingSettingsChanges.set(key, value)
        }
        console.warn('[settings] database unavailable; changes will be retried', e)
        setPersistenceState('settings', 'error')
        scheduleSettingsRetry()
        break
      } finally {
        clearTimeout(timeout)
      }
    }
  } finally {
    settingsWriteRunning = false
    if (permanentFailure) {
      setPersistenceState('settings', 'error')
      // Later, unrelated changes still deserve a save attempt.
      if (pendingSettingsChanges.size > 0) scheduleSettingsRetry()
    } else if (pendingSettingsChanges.size === 0) {
      setPersistenceState('settings', 'saved')
    }
  }
}

/** Coalesce bursts (typing a name, dragging a colour) into one save. */
const SAVE_DEBOUNCE_MS = 400
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null

function flushSoon() {
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer)
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null
    void flushSettingsChanges()
  }, SAVE_DEBOUNCE_MS)
}

function saveToDatabase(changes: Record<string, unknown>) {
  if (hydrating) {
    hasMutatedDuringHydration = true
    return
  }
  for (const [key, value] of Object.entries(changes)) pendingSettingsChanges.set(key, value)
  if (pendingSettingsChanges.size > 0) {
    setPersistenceState('settings', 'saving')
    flushSoon()
  }
}

/** True while preference changes exist that the database has not confirmed. */
export function hasUnsavedSettingsChanges(): boolean {
  return settingsWriteRunning || saveDebounceTimer !== null || pendingSettingsChanges.size > 0
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (hydrating) retrySettingsLoad()
    void flushSettingsChanges()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer)
      saveDebounceTimer = null
    }
    void flushSettingsChanges()
  })
}

let hydrationAttempt = 0
let hydrationTimer: ReturnType<typeof setTimeout> | null = null
let hydrationRunning = false

/**
 * Load saved preferences. Until this succeeds the app runs on local values;
 * edits made meanwhile are marked dirty and win over the stored copy once it
 * arrives. A failed load retries with backoff instead of giving up.
 */
async function hydrateFromSqlite() {
  if (!hydrating || hydrationRunning || typeof fetch !== 'function') return
  hydrationRunning = true
  let stored: Record<string, unknown>
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const res = await fetch(SETTINGS_ENDPOINT, { signal: controller.signal, cache: 'no-store' })
      if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) throw new Error(`HTTP ${res.status}`)
      const result: unknown = await res.json()
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid settings payload')
      stored = result as Record<string, unknown>
    } finally {
      clearTimeout(timer)
    }
  } catch {
    hydrationRunning = false
    setPersistenceState('settings', 'error')
    const delay = Math.min(30_000, 1000 * 2 ** hydrationAttempt++)
    hydrationTimer = setTimeout(() => {
      hydrationTimer = null
      void hydrateFromSqlite()
    }, delay)
    unrefTimer(hydrationTimer)
    return
  }
  hydrationRunning = false
  hydrating = false

  stashExtras(stored, { merge: true })
  const sanitized = sanitize(stored as Partial<Settings> & Record<string, unknown>)
  // Keep locally customized values (legacy browser settings and edits made
  // while loading). The database fills the rest and is canonical afterwards.
  const merged: Record<string, unknown> = { ...sanitized }
  for (const [k, v] of Object.entries(cache)) {
    if (dirtyKeys.has(k as keyof Settings) || (legacySettingsPresent && JSON.stringify(v) !== JSON.stringify(DEFAULTS[k as keyof Settings]))) {
      merged[k] = v
    }
  }
  cache = sanitize(merged)
  try {
    applyTheme(cache.theme)
    applyRoundPosters(cache.roundPosters)
  } catch {}
  const current = withExtras(cache)
  const changes: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(current)) {
    if (JSON.stringify(stored[key]) !== JSON.stringify(value)) changes[key] = value
  }
  if ((legacySettingsPresent || hasMutatedDuringHydration) && Object.keys(changes).length > 0) {
    saveToDatabase(changes)
  } else {
    clearLegacyStorage()
    setPersistenceState('settings', 'saved')
  }
  hasMutatedDuringHydration = false
  dirtyKeys.clear()
  notify()
  notifySettingsHydrated()
}

/** Retry a failed settings load immediately. */
export function retrySettingsLoad() {
  if (!hydrating) return
  if (hydrationTimer) {
    clearTimeout(hydrationTimer)
    hydrationTimer = null
  }
  hydrationAttempt = 0
  void hydrateFromSqlite()
}

// Settings hydration completion signal
const settingsHydrationListeners = new Set<() => void>()
function notifySettingsHydrated() {
  for (const fn of [...settingsHydrationListeners]) fn()
}
export function subscribeSettingsHydrated(cb: () => void): () => void {
  settingsHydrationListeners.add(cb)
  return () => {
    settingsHydrationListeners.delete(cb)
  }
}
export function isSettingsHydrated(): boolean {
  return !hydrating
}
/** Re-renders once saved preferences have loaded. */
export function useSettingsHydrated(): boolean {
  return useSyncExternalStore(subscribeSettingsHydrated, isSettingsHydrated, isSettingsHydrated)
}

/**
 * Apply settings from a backup file. Every value goes through the same
 * sanitizer as stored settings; unknown keys are kept only within the usual
 * bounds. Returns false if the payload was unusable.
 */
export function importSettings(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const incoming = raw as Record<string, unknown>
  stashExtras(incoming, { merge: true })
  cache = sanitize({ ...cache, ...(incoming as Partial<Settings>) })
  try {
    applyTheme(cache.theme)
    applyRoundPosters(cache.roundPosters)
  } catch {}
  for (const key of Object.keys(cache) as (keyof Settings)[]) dirtyKeys.add(key)
  if (hydrating) hasMutatedDuringHydration = true
  else saveToDatabase(withExtras(cache))
  notify()
  return true
}

/** The current settings (with unknown keys from newer versions) for backups. */
export function settingsForBackup(): Record<string, unknown> {
  return withExtras(cache)
}

void hydrateFromSqlite()

/** Non-reactive read, for modules that aren't components. Returns copy. */
export const currentSettings = (): Settings => ({ ...cache })

/** Subscribe to one setting: re-renders only when that value changes. */
export function useSetting<K extends keyof Settings>(key: K): Settings[K] {
  return useSyncExternalStore(subscribe, () => cache[key], () => cache[key])
}

export function useSettings() {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const set = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    let sanitized: Settings[K] = value
    // Validate per-key
    if (key === 'theme') sanitized = resolveThemePreference(value) as Settings[K]
    if ((key === 'libraryColumns' || key === 'discoverColumns') && typeof value === 'number') {
      sanitized = clamp(value as unknown as number, 3, 10, (DEFAULTS as Record<string, unknown>)[key] as number) as Settings[K]
    }
    if ((key === 'density' && value !== 'comfortable' && value !== 'compact')) {
      return
    }
    const next = sanitize({ ...cache, [key]: sanitized })
    cache = next
    dirtyKeys.add(key)
    if (key === 'theme')
      try {
        applyTheme(cache.theme)
      } catch {}
    if (key === 'roundPosters')
      try {
        applyRoundPosters(cache.roundPosters)
      } catch {}
    if (hydrating) hasMutatedDuringHydration = true
    else saveToDatabase({ [key]: cache[key] })
    notify()
  }, [])

  return { settings, set }
}
