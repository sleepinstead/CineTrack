export const STATUS_IDS = ['planned', 'watching', 'watched', 'dropped'] as const
export const MAX_REWATCHES = 500
export type Status = (typeof STATUS_IDS)[number]

/** Statuses a title can use based on its media type. Films support an
 *  in-progress state (the default status setting offers 'watching' for every
 *  new title), only Dropped is TV-only. */
export function statusesForMediaType(mediaType: 'movie' | 'tv') {
  return mediaType === 'movie' ? (['planned', 'watching', 'watched'] as const) : STATUS_IDS
}

/** Dropping a show is available only while it is actively being watched and
 *  its original run has recorded episode progress. */
export function canSetDropped(
  mediaType: 'movie' | 'tv',
  currentStatus: Status,
  watchedEpisodeCount: number,
): boolean {
  return mediaType === 'tv' && currentStatus === 'watching' && Number.isSafeInteger(watchedEpisodeCount) && watchedEpisodeCount > 0
}

/** Contextual options for an existing title's status picker. */
export function statusOptionsFor(
  mediaType: 'movie' | 'tv',
  currentStatus: Status,
  watchedEpisodeCount: number,
): readonly Status[] {
  const options = statusesForMediaType(mediaType)
  return canSetDropped(mediaType, currentStatus, watchedEpisodeCount)
    ? options
    : options.filter((status) => status !== 'dropped')
}

/** States that can safely be assigned when a title is first added. */
export const STARTING_STATUS_IDS = ['planned', 'watching'] as const satisfies readonly Status[]
export type StartingStatus = (typeof STARTING_STATUS_IDS)[number]

export type RewatchCycle = {
  rewatching: boolean
  rewatchEpisodes: Record<string, number>
  rewatches: number[]
}

/**
 * Append a logged rewatch timestamp, capped at MAX_REWATCHES. The freshly
 * appended stamp always survives the cap: a backdated completion must not be
 * silently evicted the instant it is recorded (plain sort+slice would drop
 * it whenever the log is already full).
 */
export function appendRewatchStamp(existing: readonly number[], stamp: number): number[] {
  const out = [...existing, stamp]
  if (out.length <= MAX_REWATCHES) return out.sort((a, b) => a - b)
  let dropIndex = 0
  for (let i = 1; i < out.length - 1; i++) {
    if (out[i] < out[dropIndex]) dropIndex = i
  }
  out.splice(dropIndex, 1)
  return out.sort((a, b) => a - b)
}

/** Keep the original completion separate; a rewatch finishes only once all
 *  known episodes have their own timestamps. */
export function advanceRewatch(
  cycle: RewatchCycle,
  episodes: Record<string, number>,
  totalEpisodes: number | null,
): RewatchCycle {
  if (!cycle.rewatching || typeof totalEpisodes !== 'number' || !Number.isSafeInteger(totalEpisodes) || totalEpisodes <= 0 || Object.keys(episodes).length < totalEpisodes) {
    return { ...cycle, rewatchEpisodes: episodes }
  }
  let completedAt: number | null = null
  for (const at of Object.values(episodes)) if (completedAt == null || at > completedAt) completedAt = at
  return {
    rewatching: false,
    rewatchEpisodes: {},
    rewatches: appendRewatchStamp(cycle.rewatches, completedAt ?? Date.now()),
  }
}

export type StatusTransition = {
  status: Status
  watchedAt: number | null
  clearEpisodes: boolean
}

/** Apply status-specific effects without discarding history when dropping or
 *  resuming a title. Moving to Planned from another active state still starts
 *  the episode log over, matching the existing product behavior. */
export function statusTransition(
  previous: Status,
  next: Status,
  watchedAt: number | null,
  now = Date.now(),
): StatusTransition {
  return {
    status: next,
    watchedAt: next === 'watched'
      ? watchedAt ?? now
      : previous === 'dropped' || next === 'dropped'
        ? watchedAt
        : null,
    clearEpisodes: next === 'planned' && previous !== 'dropped',
  }
}

/**
 * Status a TV entry should carry after an episode-log edit. The persisted
 * invariant (enforced by the server too) is that Dropped requires recorded
 * progress: an empty log therefore falls back to Planned even when the title
 * was previously dropped, instead of sending a combination the database
 * rejects — which previously wedged every later save behind a 400 retry loop.
 */
export function statusAfterEpisodeProgress(
  autoComplete: boolean,
  watchedCount: number,
  totalEpisodes: number | null,
): Status {
  if (watchedCount <= 0) return 'planned'
  if (
    autoComplete &&
    typeof totalEpisodes === 'number' &&
    Number.isSafeInteger(totalEpisodes) &&
    totalEpisodes > 0 &&
    watchedCount >= totalEpisodes
  ) {
    return 'watched'
  }
  return 'watching'
}

/** Keep a dropped title's previous completion date when episode edits resume
 *  or reduce its progress; ordinary in-progress titles still clear it. */
export function watchedAtAfterProgress(
  status: Status,
  finished: boolean,
  previous: number | null,
  latestEpisode: number | null,
  now = Date.now(),
): number | null {
  if (status === 'dropped' && !finished) return previous
  if (!finished) return null
  if ((status === 'watched' || status === 'dropped') && previous != null) return previous
  return latestEpisode ?? now
}
