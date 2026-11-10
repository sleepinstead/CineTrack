import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  discover,
  genreList,
  recommendations,
  searchMulti,
  trending,
  type MediaType,
  type Page,
  type TmdbTitle,
} from '../lib/tmdb'
import { useLibrary } from '../lib/library'
import { useSettings, useSettingsHydrated } from '../lib/settings'
import { Chip, Empty, Poster, PosterGrid, PosterSkeleton, SearchInput, SectionHead, ShuffleIcon, Spinner } from './ui'
import { ErrorNotice } from './Errors'

type Mode = 'suggested' | 'trending' | 'movie' | 'tv'

const SORTS = [
  { id: 'popularity.desc', label: 'Popular' },
  { id: 'vote_average.desc', label: 'Top rated' },
  { id: 'primary_release_date.desc', label: 'Newest' },
  { id: 'revenue.desc', label: 'Highest grossing' },
]


function BrowseOptionsDropdown({
  sort,
  onSort,
  genres,
  selectedGenre,
  onSelectGenre,
  sortOptions = SORTS,
}: {
  sort: string
  onSort: (value: string) => void
  genres: { id: number; name: string }[]
  selectedGenre: number | null
  onSelectGenre: (id: number | null) => void
  sortOptions?: typeof SORTS
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const selectedSort = sortOptions.find((option) => option.id === sort) ?? sortOptions[0]
  const selectedGenreName = genres.find((g) => g.id === selectedGenre)?.name

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const chipClass = (active: boolean) => `press shrink-0 whitespace-nowrap border px-2.5 py-1.5 font-sans text-[11px] font-medium uppercase tracking-[0.14em] transition-colors ${
    active
      ? 'border-[var(--primary)] bg-[var(--primary)] text-primary-foreground'
      : 'border-border bg-card text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground'
  }`

  return (
    <div ref={rootRef} className="relative z-30 shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls="discover-browse-options"
        aria-label={`Browse options: ${selectedSort.label}${selectedGenreName ? `, ${selectedGenreName}` : ', all genres'}`}
        className={`press flex h-9 shrink-0 items-center gap-2 whitespace-nowrap border px-3 py-1.5 font-sans text-[11px] font-medium uppercase tracking-[0.14em] transition-colors duration-200 ${
          open || selectedGenre !== null || sort !== SORTS[0].id
            ? 'border-[var(--primary)] bg-[var(--primary)] text-primary-foreground font-semibold shadow-xs'
            : 'border-border bg-card/50 text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground'
        }`}
      >
        <span>{selectedSort.label}{selectedGenreName ? ` · ${selectedGenreName}` : ''}</span>
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className={`h-4 w-4 shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>
          <path d="m7 10 5 5 5-5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          id="discover-browse-options"
          role="group"
          aria-label="Discover options"
          className="quiet-scroll animate-[ct-tick_180ms_var(--ease-sheet)_both] absolute right-0 top-[calc(100%+6px)] z-50 max-h-[min(70vh,460px)] w-[320px] max-w-[calc(100vw-32px)] origin-top-right overflow-y-auto border border-border bg-background p-4 shadow-[var(--shadow-pop)] sm:w-[380px]"
        >
          <section aria-labelledby="discover-sort-label" className="mb-4">
            <div className="mb-2 border-b border-border pb-2">
              <span id="discover-sort-label" className="rule-label">Sort by</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {sortOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={option.id === sort}
                  onClick={() => onSort(option.id)}
                  className={chipClass(option.id === sort)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>

          <section aria-labelledby="discover-genre-label">
            <div className="mb-2 flex items-center justify-between gap-2 border-b border-border pb-2">
              <span id="discover-genre-label" className="rule-label">Filter by genre</span>
              {selectedGenre !== null && (
                <button
                  type="button"
                  onClick={() => onSelectGenre(null)}
                  className="press font-sans text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground underline underline-offset-4 hover:text-[var(--primary)]"
                >
                  Reset
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" aria-pressed={selectedGenre === null} onClick={() => onSelectGenre(null)} className={chipClass(selectedGenre === null)}>
                All genres
              </button>
              {genres.map((g) => (
                <button key={g.id} type="button" aria-pressed={selectedGenre === g.id} onClick={() => onSelectGenre(selectedGenre === g.id ? null : g.id)} className={chipClass(selectedGenre === g.id)}>
                  {g.name}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

/**
 * One For You section — a single category of suggestions. `items` is the pool the
 * section deals from; `load` pulls a further TMDb page for the same category when
 * the section is shuffled, so a press can surface titles the pool never held.
 */
type Section = {
  key: string
  title: string
  note?: string
  items: TmdbTitle[]
  load: (page: number, signal?: AbortSignal) => Promise<TmdbTitle[]>
}

/** Plates per section: two stacked rows of the configured width. */
const SECTION_ROWS = 2
/** Candidates kept per section — deeper than one hand so shuffling has room. */
const SECTION_POOL = 24
/** Ceiling for the runtime pool once shuffles start appending fresh pages. */
const SECTION_POOL_CAP = SECTION_POOL * 3
/** Share of a hand drawn from the newest batch; the rest revisits the pool. */
const FRESH_SHARE = 2 / 3
const MAX_GRID_RESULTS = 300
const MAX_CACHED_FEEDS = 6

type FeedSnapshot = { results: TmdbTitle[]; page: number; totalPages: number }

/** Plate identity — media type falls back the same way Poster infers it. */
export const plateKey = (t: TmdbTitle) => `${t.media_type ?? (t.title ? 'movie' : 'tv')}-${t.id}`

function uniqueTitles(items: TmdbTitle[]) {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = plateKey(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function gridColumnsForViewport(configured: number) {
  if (typeof window === 'undefined') return 2
  if (window.innerWidth >= 1024) return configured
  if (window.innerWidth >= 768) return 4
  if (window.innerWidth >= 640) return 3
  return 2
}

/** Keep brief requests from flashing a full row of skeletons. */
function useDelayedLoading(active: boolean, requestKey: string, delayMs = 140) {
  const [visibleKey, setVisibleKey] = useState<string | null>(null)

  useEffect(() => {
    if (!active) {
      setVisibleKey(null)
      return
    }
    setVisibleKey(null)
    const timer = window.setTimeout(() => setVisibleKey(requestKey), delayMs)
    return () => window.clearTimeout(timer)
  }, [active, requestKey, delayMs])

  return active && visibleKey === requestKey
}

/** Deterministic spread pick of genres so sections vary by library but stay stable per session. */
function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function pickGenres(genres: { id: number; name: string }[], sig: string, n: number) {
  if (genres.length === 0) return []
  const out: { id: number; name: string }[] = []
  const used = new Set<number>()
  const start = hashStr(sig || 'cinetrack') % genres.length
  for (let k = 0; k < genres.length && out.length < n; k++) {
    const g = genres[(start + k * 7) % genres.length]
    if (used.has(g.id)) continue
    used.add(g.id)
    out.push(g)
  }
  return out
}

/** xorshift32 — a few lines of determinism so a dealt hand survives re-renders. */
function seedRandom(seed: number): () => number {
  let s = (seed >>> 0) || 0x9e3779b9
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

/** Seeded Fisher–Yates: one seed always deals the same order. */
export function shuffleWithSeed<T>(list: T[], seed: number): T[] {
  const out = [...list]
  const rand = seedRandom(seed)
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Deals one section hand: at most `slots` plates, two thirds of them from the
 * batch the last shuffle pulled so the row visibly turns over, the rest from
 * the wider pool. A title never repeats inside a hand.
 */
export function dealSuggestions(fresh: TmdbTitle[], pool: TmdbTitle[], slots: number, seed: number): TmdbTitle[] {
  const hand: TmdbTitle[] = []
  const used = new Set<string>()
  const draw = (list: TmdbTitle[], limit: number) => {
    for (const item of list) {
      if (hand.length >= slots || limit <= 0) return
      const id = plateKey(item)
      if (used.has(id)) continue
      used.add(id)
      hand.push(item)
      limit -= 1
    }
  }
  draw(shuffleWithSeed(fresh, seed), Math.ceil(slots * FRESH_SHARE))
  draw(shuffleWithSeed(pool, seed + 1), slots)
  return hand
}

/** Plates currently on screen in every mounted section, so a shuffle can steer around them. */
type ClaimRegistry = { current: Map<string, Set<string>> }

/** One category section: two fixed rows of plates with a shuffle control in the header. */
function SuggestionSection({
  section,
  claims,
  onOpen,
}: {
  section: Section
  claims: ClaimRegistry
  onOpen: (t: MediaType, id: number, seed?: TmdbTitle) => void
}) {
  const { get } = useLibrary()
  const { settings } = useSettings()
  const columns = Math.max(1, settings.discoverColumns)
  const slots = columns * SECTION_ROWS

  const [pool, setPool] = useState(section.items)
  const [fresh, setFresh] = useState<TmdbTitle[]>([])
  // A new mount gets a fresh hand; each shuffle advances the seed once.
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 0x1_0000_0000))
  const [hand, setHand] = useState(() => dealSuggestions([], section.items, slots, seed))
  const [busy, setBusy] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  // Every section is assembled from page one, so refreshes walk forward from there.
  const pageRef = useRef(1)
  const busyRef = useRef(false)
  const requestRef = useRef<AbortController | null>(null)

  const visible = useMemo(
    () => hand.length === slots ? hand : dealSuggestions(fresh, pool, slots, seed),
    [fresh, hand, pool, seed, slots],
  )
  const previousVisible = useRef(new Set<string>())

  // Publish this section's plates so a sibling shuffle never repeats one of them.
  useEffect(() => {
    const registry = claims.current
    const keys = new Set(visible.map(plateKey))
    registry.set(section.key, keys)
    previousVisible.current = keys
    return () => {
      registry.delete(section.key)
    }
  }, [claims, section.key, visible])

  useEffect(() => () => requestRef.current?.abort(), [])

  /** Pulls the next page for this category; a failed pull leaves the hand intact. */
  const refresh = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const controller = new AbortController()
    requestRef.current = controller
    try {
      const page = pageRef.current + 1
      const items = await section.load(page, controller.signal)
      if (controller.signal.aborted || items.length === 0) return
      setRefreshError(null)
      pageRef.current = page
      const elsewhere = new Set<string>()
      for (const [otherKey, plates] of claims.current) {
        if (otherKey === section.key) continue
        for (const plate of plates) elsewhere.add(plate)
      }
      const picked = items.filter((item) => !elsewhere.has(plateKey(item)))
      if (picked.length === 0) return
      setFresh(picked)
      setPool((prev) => {
        const held = new Set(prev.map(plateKey))
        return [...picked.filter((item) => !held.has(plateKey(item))), ...prev].slice(0, SECTION_POOL_CAP)
      })
    } catch {
      if (!controller.signal.aborted) setRefreshError('Check your connection and try again.')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [claims, section])

  const shuffle = () => {
    if (busyRef.current) return
    const nextSeed = seed + 1
    setSeed(nextSeed)
    setHand(dealSuggestions(fresh, pool, slots, nextSeed))
    void refresh()
  }

  return (
    <section aria-label={section.title} aria-busy={busy}>
      <div className="relative z-20 mb-4 flex items-end justify-between gap-4 border-b border-border pb-2">
        <div className="min-w-0">
          <h2 className="font-display truncate text-[22px]">{section.title}</h2>
          {section.note && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{section.note}</p>}
        </div>
        <button
          type="button"
          onClick={() => {
            if (!busy) shuffle()
          }}
          // aria-disabled, not disabled: disabling the focused button would drop focus to <body>.
          aria-disabled={busy || undefined}
          aria-label={`Shuffle ${section.title} suggestions`}
          className="press relative z-30 inline-flex shrink-0 items-center gap-1.5 border border-border bg-background px-3 py-1.5 font-sans text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground aria-disabled:cursor-wait aria-disabled:opacity-60"
        >
          <ShuffleIcon className={`size-4 ${busy ? 'animate-spin' : ''}`} />
          Shuffle
        </button>
      </div>
      {refreshError && (
        <ErrorNotice className="mb-3" title="This section couldn’t refresh" message={refreshError} onRetry={() => void refresh()} busy={busy} />
      )}
      <PosterGrid columns={columns}>
        {visible.map((item, index) => {
          const t: MediaType = (item.media_type ?? 'movie') as MediaType
          const key = plateKey(item)
          const entering = !previousVisible.current.has(key)
          return (
            <Poster
              key={`${t}-${item.id}`}
              item={item}
              entry={get(t, item.id)}
              onOpen={onOpen}
              animate={entering}
              style={entering ? { animationDelay: `${Math.floor(index / columns) * 90}ms` } : undefined}
            />
          )
        })}
      </PosterGrid>
    </section>
  )
}


/**
 * True once saved preferences (language, adult filter) have loaded, or after a
 * short grace period if they can't be — so the first fetch isn't thrown away
 * and repeated in a different language a moment later.
 */
function useSettingsReady(graceMs = 1500) {
  const hydrated = useSettingsHydrated()
  const [timedOut, setTimedOut] = useState(false)
  useEffect(() => {
    if (hydrated) return
    const timer = window.setTimeout(() => setTimedOut(true), graceMs)
    return () => window.clearTimeout(timer)
  }, [hydrated, graceMs])
  return hydrated || timedOut
}

export default function Discover({ onOpen }: { onOpen: (t: MediaType, id: number, seed?: TmdbTitle) => void }) {
  const { entries, get } = useLibrary()
  const { settings } = useSettings()
  const settingsReady = useSettingsReady()
  const [mode, setMode] = useState<Mode>('trending')
  const [sort, setSort] = useState('popularity.desc')
  const [genre, setGenre] = useState<number | null>(null)
  const [genres, setGenres] = useState<{ id: number; name: string }[]>([])
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [gridColumns, setGridColumns] = useState(() => gridColumnsForViewport(settings.discoverColumns))

  const [results, setResults] = useState<TmdbTitle[]>([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retryPage, setRetryPage] = useState<number | null>(null)
  const [activeFeedKey, setActiveFeedKey] = useState<string | null>(null)
  const [animatedRange, setAnimatedRange] = useState<{ start: number; end: number } | null>(null)

  const [sections, setSections] = useState<Section[]>([])
  const [sectionsLoading, setSectionsLoading] = useState(false)
  const [sectionsError, setSectionsError] = useState<string | null>(null)
  const [sectionRetry, setSectionRetry] = useState(0)

  const type: MediaType = mode === 'tv' ? 'tv' : 'movie'
  const searching = !!debounced
  // For You browses section rows; every other view is the infinite grid
  const gridActive = mode !== 'suggested' || searching

  useEffect(() => {
    const updateColumns = () => setGridColumns(gridColumnsForViewport(settings.discoverColumns))
    window.addEventListener('resize', updateColumns, { passive: true })
    return () => window.removeEventListener('resize', updateColumns)
  }, [settings.discoverColumns])

  const seedSig = useMemo(
    () =>
      [...entries]
        .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.addedAt - a.addedAt)
        .slice(0, 8)
        .map((e) => `${e.mediaType}:${e.id}`)
        .join(','),
    [entries],
  )
  const seeds = useMemo(
    () =>
      seedSig
        ? seedSig.split(',').map((k) => {
            const [mediaType, idStr] = k.split(':')
            const id = Number(idStr)
            if (!Number.isInteger(id) || id <= 0) return null
            return { id, mediaType: mediaType as MediaType, title: get(mediaType as MediaType, id)?.title ?? '' }
          }).filter(Boolean) as { id: number; mediaType: MediaType; title: string }[]
        : [],
    [seedSig, get],
  )
  const seedsRef = useRef(seeds)
  useEffect(() => { seedsRef.current = seeds }, [seeds])
  /** Only the top three seeds feed the sections; refresh when those change, not on every edit. */
  const topSeedSig = seedSig.split(',').slice(0, 3).join(',')

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 350)
    return () => clearTimeout(t)
  }, [query])

  // Load genres for movie/tv and trending modes — use live flag to avoid stale set
  useEffect(() => {
    if (!settingsReady || (mode !== 'movie' && mode !== 'tv' && mode !== 'trending')) return
    const controller = new AbortController()
    let live = true
    genreList(type, { signal: controller.signal })
      .then((g) => { if (live) setGenres(g) })
      .catch(() => { if (live) setGenres([]) })
    return () => {
      live = false
      controller.abort()
    }
  }, [mode, type, settings.metadataLanguage, settingsReady])

  const sectionToken = useRef(0)
  // Plates on screen per section, shared so a shuffle never repeats one across categories.
  const claims = useRef(new Map<string, Set<string>>())

  // For You sections: per-seed picks + genre exploration + trending, assembled in parallel.
  // Seeds drive the personal rows; genre rows deliberately reach beyond the library.
  useEffect(() => {
    if (gridActive || !settingsReady) return
    const controller = new AbortController()
    let live = true
    const token = ++sectionToken.current
    setSectionsLoading(true)
    setSectionsError(null)
    // Current sections stay on screen until the new set is ready.
    const sig = topSeedSig
    ;(async () => {
      try {
        const topSeeds = seedsRef.current.slice(0, 3)
        const [seedPages, trendItems, movieGenres] = await Promise.all([
          Promise.all(
            topSeeds.map((s) =>
              recommendations(s.mediaType, s.id, 1, { signal: controller.signal }).then(
                (r) => ({ seed: s, items: r.results.map((x) => ({ ...x, media_type: x.media_type ?? s.mediaType })) }),
                () => ({ seed: s, items: [] as TmdbTitle[] }),
              ),
            ),
          ),
          trending('all', 'week', 1, { signal: controller.signal }).then(
            (r) => r.results,
            () => [] as TmdbTitle[],
          ),
          genreList('movie', { signal: controller.signal }).then(
            (g) => g,
            () => [] as { id: number; name: string }[],
          ),
        ])
        if (!live || token !== sectionToken.current) return
        const genrePicks = pickGenres(movieGenres, sig, 3)
        const genreSorts = [
          { id: 'vote_average.desc', label: 'Top rated', gte: 200 },
          { id: 'popularity.desc', label: 'Popular now', gte: 100 },
          { id: 'primary_release_date.desc', label: 'Newest', gte: 50 },
        ]
        const genrePages = await Promise.all(
          genrePicks.map((g, i) => {
            const sort = genreSorts[i % genreSorts.length]
            return discover('movie', {
              page: 1,
              sort_by: sort.id,
              with_genres: String(g.id),
              'vote_count.gte': sort.gte,
            }, { signal: controller.signal }).then(
              (r) => ({ genre: g, sort, items: r.results.map((x) => ({ ...x, media_type: 'movie' as MediaType })) }),
              () => ({ genre: g, sort, items: [] as TmdbTitle[] }),
            )
          }),
        )
        if (!live || token !== sectionToken.current) return
        // First occurrence wins — the same title never repeats across sections
        const seen = new Set<string>()
        const take = (items: TmdbTitle[], n: number) => {
          const out: TmdbTitle[] = []
          for (const it of items) {
            const k = plateKey(it)
            if (seen.has(k)) continue
            seen.add(k)
            out.push(it)
            if (out.length >= n) break
          }
          return out
        }
        const next: Section[] = []
        const allSeedItems: TmdbTitle[] = []
        for (const { items } of seedPages) {
          allSeedItems.push(...items)
        }
        const libraryPicked = take(allSeedItems, SECTION_POOL)
        if (libraryPicked.length >= 4 && topSeeds.length > 0) {
          next.push({
            key: 'from-library',
            title: 'From your library',
            note: 'Recommendations inspired by the titles in your library.',
            items: libraryPicked,
            // A shuffle steps to the next seed, then walks that seed's later pages.
            load: (page, signal) => {
              const seed = topSeeds[(page - 1) % topSeeds.length]
              const inner = Math.floor((page - 1) / topSeeds.length) + 1
              return recommendations(seed.mediaType, seed.id, inner, { signal }).then(
                (r) => r.results.map((x) => ({ ...x, media_type: x.media_type ?? seed.mediaType })),
                () => [] as TmdbTitle[],
              )
            },
          })
        }
        genrePages.forEach(({ genre, sort, items }) => {
          const picked = take(items, SECTION_POOL)
          if (picked.length >= 4) {
            next.push({
              key: `genre-${genre.id}-${sort.label}`,
              title: `${sort.label} ${genre.name}`,
              note: 'Beyond your library — something unlike your usual picks.',
              items: picked,
              load: (page, signal) =>
                discover('movie', {
                  page,
                  sort_by: sort.id,
                  with_genres: String(genre.id),
                  'vote_count.gte': sort.gte,
                }, { signal }).then(
                  (r) => r.results.map((x) => ({ ...x, media_type: 'movie' as MediaType })),
                  () => [] as TmdbTitle[],
                ),
            })
          }
        })
        const trendPicked = take(trendItems, SECTION_POOL)
        if (trendPicked.length >= 4) {
          next.push({
            key: 'trending-week',
            title: 'Trending this week',
            note: 'Across films and series.',
            items: trendPicked,
            load: (page, signal) => trending('all', 'week', page, { signal }).then((r) => r.results, () => [] as TmdbTitle[]),
          })
        }
        setSections(next)
      } catch (e) {
        if (live && token === sectionToken.current) setSectionsError(e instanceof Error ? e.message : 'Failed to load suggestions')
      } finally {
        if (live && token === sectionToken.current) setSectionsLoading(false)
      }
    })()
    return () => {
      live = false
      controller.abort()
    }
  }, [gridActive, settingsReady, topSeedSig, settings.includeAdult, settings.metadataLanguage, sectionRetry])

  /** One page of whichever feed is active. Suggestions walk the seed list. */
  const fetchPage = useCallback(
    (p: number, signal?: AbortSignal): Promise<Page> => {
      if (searching) return searchMulti(debounced, p, { signal })
      if (mode === 'trending') return trending('all', 'week', p, { signal })
      if (mode === 'suggested') {
        const currentSeeds = seedsRef.current
        if (currentSeeds.length === 0) return trending('all', 'week', p, { signal })
        const seed = currentSeeds[(p - 1) % currentSeeds.length]
        const innerPage = Math.floor((p - 1) / currentSeeds.length) + 1
        return recommendations(seed.mediaType, seed.id, innerPage, { signal }).then((r) => ({
          ...r,
          results: r.results.map((x) => ({ ...x, media_type: x.media_type ?? seed.mediaType })),
          total_pages: r.total_pages,
        }))
      }
      return discover(type, {
        page: p,
        sort_by: mode === 'tv' && sort === 'primary_release_date.desc' ? 'first_air_date.desc' : sort,
        ...(genre ? { with_genres: String(genre) } : {}),
      }, { signal }).then((r) => ({ ...r, results: r.results.map((x) => ({ ...x, media_type: type })) }))
    },
    // Language and adult-content preferences are read inside the TMDb client;
    // they are part of feedKey, which is what re-runs the feed.
    [searching, debounced, mode, type, sort, genre],
  )

  const feedToken = useRef(0)
  const feedControllerRef = useRef<AbortController | null>(null)
  const feedCacheRef = useRef(new Map<string, FeedSnapshot>())
  const resultsRef = useRef(results)
  resultsRef.current = results
  const loadingRef = useRef(loading)
  loadingRef.current = loading
  const errorRef = useRef(error)
  errorRef.current = error
  // Trending's sort and genre only reorder/filter loaded pages client-side, so
  // they stay out of the feed identity (changing them used to discard pages).
  const serverSideOptions = !searching && mode !== 'trending'
  const feedKey = JSON.stringify([
    mode,
    searching ? debounced : '',
    serverSideOptions ? sort : null,
    serverSideOptions ? genre : null,
    settings.includeAdult,
    settings.metadataLanguage,
  ])
  const feedKeyRef = useRef(feedKey)
  feedKeyRef.current = feedKey
  const cachedFeed = gridActive ? feedCacheRef.current.get(feedKey) : undefined
  const displayResults = useMemo(
    () => (activeFeedKey === feedKey ? results : cachedFeed?.results ?? []),
    [activeFeedKey, feedKey, results, cachedFeed],
  )
  const visibleResults = useMemo(() => {
    if (mode !== 'trending') return displayResults
    const filtered = genre === null
      ? [...displayResults]
      : displayResults.filter((item) => item.genre_ids?.includes(genre))
    if (sort === 'vote_average.desc') {
      filtered.sort((a, b) => b.vote_average - a.vote_average)
    } else if (sort === 'primary_release_date.desc') {
      filtered.sort((a, b) => (b.release_date ?? b.first_air_date ?? '').localeCompare(a.release_date ?? a.first_air_date ?? ''))
    }
    // Trending results arrive pre-ranked by TMDB popularity; revenue isn't
    // included in the trending response, so those results retain that ranking.
    return filtered
  }, [displayResults, genre, mode, sort])
  const displayPage = activeFeedKey === feedKey ? page : cachedFeed?.page ?? 1
  const displayTotalPages = activeFeedKey === feedKey ? totalPages : cachedFeed?.totalPages ?? 1
  const displayError = activeFeedKey === feedKey ? error : null
  const gridLoading = gridActive && (activeFeedKey === feedKey ? loading : !cachedFeed)
  const showGridSkeletons = useDelayedLoading(gridLoading, feedKey)

  const requestPage = useCallback((requestedPage: number, token: number) => {
    if (token !== feedToken.current) return
    feedControllerRef.current?.abort()
    const controller = new AbortController()
    feedControllerRef.current = controller
    loadingRef.current = true
    errorRef.current = null
    setLoading(true)
    setError(null)
    setRetryPage(null)

    fetchPage(requestedPage, controller.signal)
      .then((response) => {
        if (token !== feedToken.current || controller.signal.aborted) return
        const nextPage = requestedPage === 1 ? 1 : requestedPage
        const firstNewIndex = requestedPage === 1 ? 0 : resultsRef.current.length
        const nextResults = uniqueTitles(
          requestedPage === 1 ? response.results : [...resultsRef.current, ...response.results],
        ).slice(0, MAX_GRID_RESULTS)
        resultsRef.current = nextResults
        setActiveFeedKey(feedKey)
        setAnimatedRange({ start: firstNewIndex, end: nextResults.length })
        setResults(nextResults)
        setPage(nextPage)
        setTotalPages(response.total_pages ?? nextPage)
        feedCacheRef.current.delete(feedKey)
        feedCacheRef.current.set(feedKey, {
          results: nextResults,
          page: nextPage,
          totalPages: response.total_pages ?? nextPage,
        })
        while (feedCacheRef.current.size > MAX_CACHED_FEEDS) {
          const oldestKey = feedCacheRef.current.keys().next().value
          if (oldestKey === undefined) break
          feedCacheRef.current.delete(oldestKey)
        }
      })
      .catch((e) => {
        if (token !== feedToken.current || controller.signal.aborted) return
        const message = e instanceof Error && e.message !== 'Request cancelled'
          ? e.message
          : 'Check your connection and try again.'
        errorRef.current = message
        setError(message)
        setRetryPage(requestedPage)
      })
      .finally(() => {
        if (token === feedToken.current && feedControllerRef.current === controller) {
          feedControllerRef.current = null
          loadingRef.current = false
          setLoading(false)
        }
      })
  }, [fetchPage, feedKey])

  // Reset and load page one when feed identity changes (mode/search/sort/genre/includeAdult)
  // Note: seedsRef is intentionally NOT a dep — adding a library item shouldn't wipe the grid
  // For You sections have their own fetch path — the grid stays idle there
  useEffect(() => {
    if (!settingsReady) return
    feedControllerRef.current?.abort()
    const token = ++feedToken.current
    errorRef.current = null
    setError(null)
    setRetryPage(null)

    if (!gridActive) {
      setAnimatedRange(null)
      loadingRef.current = false
      setLoading(false)
      return () => {
        if (feedToken.current === token) feedToken.current += 1
        feedControllerRef.current?.abort()
      }
    }

    const cached = feedCacheRef.current.get(feedKey)
    if (cached) {
      feedCacheRef.current.delete(feedKey)
      feedCacheRef.current.set(feedKey, cached)
      setActiveFeedKey(feedKey)
      setAnimatedRange(null)
      resultsRef.current = cached.results
      setResults(cached.results)
      setPage(cached.page)
      setTotalPages(cached.totalPages)
      loadingRef.current = false
      setLoading(false)
    } else {
      setActiveFeedKey(feedKey)
      setAnimatedRange(null)
      resultsRef.current = []
      setResults([])
      setPage(1)
      setTotalPages(1)
      requestPage(1, token)
    }

    return () => {
      if (feedToken.current === token) feedToken.current += 1
      feedControllerRef.current?.abort()
    }
  }, [feedKey, gridActive, requestPage, settingsReady])

  const loadMoreRef = useRef<() => void>(() => {})
  const loadMore = useCallback(() => {
    if (feedKey !== feedKeyRef.current || activeFeedKey !== feedKey || !gridActive || loadingRef.current || errorRef.current || page >= totalPages || resultsRef.current.length >= MAX_GRID_RESULTS) return
    requestPage(page + 1, feedToken.current)
  }, [activeFeedKey, feedKey, gridActive, page, requestPage, totalPages])

  useEffect(() => { loadMoreRef.current = loadMore }, [loadMore])

  // IntersectionObserver with proper re-attach when sentinel changes
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const setSentinel = useCallback((node: HTMLDivElement | null) => {
    sentinelRef.current = node
  }, [])
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !gridActive) return
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) loadMoreRef.current()
    }, { rootMargin: '0px 0px 1600px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [results.length, gridActive, error])

  const capped = displayResults.length >= MAX_GRID_RESULTS
  const exhausted = (displayPage >= displayTotalPages || capped) && displayResults.length > 0

  return (
    <div className="space-y-8">
      <SectionHead
        title="Discover"
        fullBleed
        titleClassName="text-[72px] sm:text-[88px]"
        headingLevel={1}
      />

      <div className="relative z-30 flex flex-wrap items-center justify-between gap-x-4 gap-y-3" role="group" aria-label="Discover modes">
        <div className="flex flex-wrap items-center gap-2">
          {(['trending', 'suggested', 'movie', 'tv'] as Mode[]).map((m) => (
            <Chip
              key={m}
              active={mode === m && !searching}
              onClick={() => {
                setQuery('')
                setDebounced('')
                if (m !== mode) setGenre(null)
                setMode(m)
              }}
            >
              {m === 'movie' ? 'Films' : m === 'tv' ? 'TV Shows' : m === 'suggested' ? 'For you' : 'Trending'}
            </Chip>
          ))}
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {(mode === 'movie' || mode === 'tv' || mode === 'trending') && !searching && (
            <BrowseOptionsDropdown
              sort={sort}
              onSort={setSort}
              genres={genres}
              selectedGenre={genre}
              onSelectGenre={setGenre}
              sortOptions={mode === 'trending' ? SORTS.filter((option) => option.id !== 'revenue.desc') : SORTS}
            />
          )}
          <SearchInput value={query} onChange={setQuery} label="Search films and series on TMDb" placeholder="Search films and series…" className="w-full sm:w-64 md:w-96" />
        </div>
      </div>

      {searching && (
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2">
          <h2 className="font-display text-[22px]">{`Search — “${debounced}”`}</h2>
        </div>
      )}
      {!gridActive && sectionsLoading && sections.length > 0 && (
        <span className="rule-label">Refreshing suggestions…</span>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {gridActive
          ? gridLoading
            ? displayResults.length ? 'Loading more titles' : 'Loading titles'
            : searching && !displayError
              ? `${visibleResults.length} result${visibleResults.length === 1 ? '' : 's'} for ${debounced}`
              : ''
          : sectionsLoading ? 'Loading suggestions' : ''}
      </span>
      {!gridActive ? (
        <>
          {sectionsError && (
            <ErrorNotice title="Suggestions couldn’t load" message={sectionsError} onRetry={() => setSectionRetry((n) => n + 1)} />
          )}
          {sectionsLoading && sections.length === 0 && !sectionsError && (
            <div className="flex min-h-[50vh] items-center justify-center py-12 animate-fade" aria-live="polite">
              <Spinner size={38} />
            </div>
          )}
          {!sectionsLoading && !sectionsError && sections.length === 0 && (
            <Empty>No suggestions yet — rate something in your library or try Trending</Empty>
          )}
          {sections.map((s, idx) => (
            <div key={s.key} className="animate-fade" style={{ animationDelay: `${idx * 40}ms` }}>
              <SuggestionSection section={s} claims={claims} onOpen={onOpen} />
            </div>
          ))}
        </>
      ) : (
        <>
          {displayError && (
            <ErrorNotice
              title="Titles couldn’t load"
              message={displayError}
              onRetry={() => requestPage(retryPage ?? 1, feedToken.current)}
              busy={gridLoading}
            />
          )}
          {!gridLoading && !displayError && visibleResults.length === 0 && (
            <Empty>
              {mode === 'trending' && genre !== null
                ? 'No trending titles match this genre'
                : searching
                  ? `No films or series found for “${debounced}”`
                  : 'No titles match — try a different sort or genre'}
            </Empty>
          )}

          <div aria-busy={gridLoading}>
            {showGridSkeletons && displayResults.length === 0 && !displayError && (
              <PosterGrid columns={settings.discoverColumns}>
                {Array.from({ length: gridColumns * 2 }, (_, i) => (
                  <PosterSkeleton
                    key={`init-skel-${i}`}
                    compact={settings.density === 'compact'}
                    style={{ animationDelay: `${Math.floor(i / gridColumns) * 45}ms` }}
                  />
                ))}
              </PosterGrid>
            )}

            {visibleResults.length > 0 && (
              <PosterGrid columns={settings.discoverColumns}>
                {visibleResults.map((item, i) => {
                  const t: MediaType = (item.media_type ?? type) as MediaType
                  // Only a fresh feed gets an entrance; appended pages simply appear
                  // (their art fades in on its own), so scrolling never shimmers.
                  const animate = activeFeedKey === feedKey && animatedRange?.start === 0 && i < animatedRange.end
                  const row = Math.floor(i / gridColumns)
                  return (
                    <Poster
                      key={`${t}-${item.id}`}
                      item={item}
                      entry={get(t, item.id)}
                      onOpen={onOpen}
                      animate={animate}
                      eager={i < gridColumns * 2}
                      style={animate ? { animationDelay: `${Math.min(row, 3) * 45}ms` } : undefined}
                    />
                  )
                })}
                {showGridSkeletons && displayResults.length > 0 && (
                  <>
                    {Array.from({ length: ((gridColumns - (visibleResults.length % gridColumns)) % gridColumns) + gridColumns }, (_, i) => (
                      <PosterSkeleton key={`append-skel-${i}`} compact={settings.density === 'compact'} />
                    ))}
                  </>
                )}
              </PosterGrid>
            )}
          </div>

          <div ref={setSentinel} className="h-px" aria-hidden />

          {exhausted && !gridLoading && (
            <p className="animate-fade rule-label border-t border-border py-6 text-center">
              {capped ? `Catalogue limit reached · first ${displayResults.length} records shown` : `End of catalogue · ${displayResults.length} records`}
            </p>
          )}
        </>
      )}
    </div>
  )
}
