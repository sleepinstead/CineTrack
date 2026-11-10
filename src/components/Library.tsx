import { createPortal } from 'react-dom'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { type MediaType, type TmdbTitle } from '../lib/tmdb'
import { lastActivityAt, useLibrary, useLibraryStatus, type Entry, type Status } from '../lib/library'
import { useSettings } from '../lib/settings'
import { Chip, Empty, Poster, PosterGrid, PosterSkeleton, SearchInput, SectionHead, STATUS_INACTIVE, STATUS_STYLE } from './ui'

/** Stable TMDb-shaped view of each entry, so memoised posters skip re-rendering. */
const itemCache = new WeakMap<Entry, TmdbTitle>()
function itemFor(entry: Entry): TmdbTitle {
  let item = itemCache.get(entry)
  if (!item) {
    item = {
      id: entry.id,
      media_type: entry.mediaType,
      title: entry.mediaType === 'movie' ? entry.title : undefined,
      name: entry.mediaType === 'tv' ? entry.title : undefined,
      poster_path: entry.poster,
      backdrop_path: entry.backdrop,
      overview: '',
      vote_average: 0,
      release_date: entry.year,
    }
    itemCache.set(entry, item)
  }
  return item
}

const FILTER_LABEL: Record<LibraryFilter, string> = {
  all: 'All',
  watching: 'Watching',
  planned: 'Planned',
  watched: 'Watched',
  rewatching: 'Rewatching',
  rewatched: 'Rewatched',
  seen: 'Seen',
  dropped: 'Dropped',
}

type Tab = 'all' | 'movie' | 'tv' | 'favorites'
type LibraryFilter = Status | 'rewatching' | 'rewatched' | 'all' | 'seen'
export type LibraryView = { tab: Tab; filter: LibraryFilter }
const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'movie', label: 'Films' },
  { id: 'tv', label: 'TV' },
  { id: 'favorites', label: 'Favourites' },
]

const FILTERS: LibraryFilter[] = ['all', 'watching', 'planned', 'watched', 'rewatching', 'rewatched', 'seen', 'dropped']
const SORTS = [
  { id: 'added', label: 'Recently added' },
  { id: 'lastWatched', label: 'Last watched' },
  { id: 'title', label: 'A–Z' },
  { id: 'rating', label: 'My rating' },
  { id: 'year', label: 'Year' },
  { id: 'status', label: 'Status' },
] as const
const RATING_OPTIONS = [
  { id: 0, label: 'Any' },
  { id: 7, label: '7+' },
  { id: 8, label: '8+' },
  { id: 9, label: '9+' },
] as const

export type LibrarySort = (typeof SORTS)[number]['id']
/** The library opens sorted by most recently added. */
const DEFAULT_SORT: LibrarySort = 'added'

export function applyLibraryFilters(
  pool: Entry[],
  opts: { status: LibraryFilter; minRating: number; query: string; sort: LibrarySort },
): Entry[] {
  let list = pool
  if (opts.status === 'rewatching') list = list.filter((e) => e.mediaType === 'tv' && e.rewatching)
  else if (opts.status === 'rewatched') list = list.filter((e) => e.rewatches.length > 0)
  else if (opts.status === 'dropped') list = list.filter((e) => e.mediaType === 'tv' && e.status === 'dropped')
  // Mirrors the Home dashboard's "seen" stats: watched or dropped, plus any
  // legacy row that still carries a watch timestamp.
  else if (opts.status === 'seen') list = list.filter((e) => e.status === 'watched' || e.status === 'dropped' || e.watchedAt != null)
  else if (opts.status !== 'all') list = list.filter((e) => e.status === opts.status)
  if (opts.minRating > 0) list = list.filter((e) => (e.rating ?? -1) >= opts.minRating)
  const trimmed = opts.query.trim().toLowerCase()
  if (trimmed) {
    list = list.filter((e) => e.title.toLowerCase().includes(trimmed) || (e.mediaType === 'tv' && e.rewatching && 'rewatching'.includes(trimmed)))
  }
  const sorted = [...list]
  const statusOrder: Record<Status, number> = { planned: 0, watching: 1, watched: 2, dropped: 3 }
  const statusFor = (entry: Entry): Status => entry.mediaType === 'movie' && entry.status === 'dropped' ? 'planned' : entry.status
  sorted.sort((a, b) => {
    if (opts.sort === 'title') return a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true })
    if (opts.sort === 'rating') return (b.rating ?? -1) - (a.rating ?? -1)
    if (opts.sort === 'year') return (Number(b.year) || 0) - (Number(a.year) || 0)
    if (opts.sort === 'lastWatched') return (lastActivityAt(b) ?? -1) - (lastActivityAt(a) ?? -1)
    if (opts.sort === 'status') return statusOrder[statusFor(a)] - statusOrder[statusFor(b)] || Number(b.rewatching) - Number(a.rewatching) || a.title.localeCompare(b.title)
    return b.addedAt - a.addedAt
  })
  return sorted
}

export default function Library({
  onOpen,
  initialView,
}: {
  onOpen: (t: MediaType, id: number, seed?: TmdbTitle) => void
  initialView?: LibraryView | null
}) {
  const { entries } = useLibrary()
  const { hydrated } = useLibraryStatus()
  const { settings } = useSettings()
  const [tab, setTab] = useState<Tab>(() => initialView?.tab ?? 'all')
  const [filter, setFilter] = useState<LibraryFilter>(() => initialView?.filter ?? 'all')
  const [sort, setSort] = useState<(typeof SORTS)[number]['id']>(DEFAULT_SORT)
  const [minRating, setMinRating] = useState<(typeof RATING_OPTIONS)[number]['id']>(0)
  const [q, setQ] = useState('')

  useEffect(() => {
    setTab(initialView?.tab ?? 'all')
    setFilter(initialView?.filter ?? 'all')
    setMinRating(0)
    setQ('')
  }, [initialView])

  const pool = useMemo(() => {
    if (tab === 'favorites') return entries.filter((e) => e.favorite)
    if (tab === 'movie') return entries.filter((e) => e.mediaType === 'movie')
    if (tab === 'tv') return entries.filter((e) => e.mediaType === 'tv')
    return entries
  }, [entries, tab])

  const deferredQ = useDeferredValue(q)
  const shown = useMemo(
    () => applyLibraryFilters(pool, { status: filter, minRating, query: deferredQ, sort }),
    [pool, filter, minRating, deferredQ, sort],
  )

  const PAGE_SIZE = 40
  // Paging resets whenever the query changes; keying it on the query avoids a
  // render with a stale page count.
  const queryKey = `${tab}|${filter}|${minRating}|${deferredQ}|${sort}`
  const [paging, setPaging] = useState({ key: queryKey, page: 1 })
  const page = paging.key === queryKey ? paging.page : 1
  const setPage = (update: (p: number) => number) => setPaging({ key: queryKey, page: update(page) })
  const paged = useMemo(() => shown.slice(0, page * PAGE_SIZE), [shown, page])

  // Infinite scroll: observe a sentinel element near the bottom
  const loadMoreRef = useRef<() => void>(() => {})
  loadMoreRef.current = () => {
    if (paged.length < shown.length) setPage((p) => p + 1)
  }
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const setSentinel = useCallback((node: HTMLDivElement | null) => {
    sentinelRef.current = node
  }, [])
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) loadMoreRef.current() },
      { rootMargin: '600px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [paged.length, shown.length])

  return (
    <div className="space-y-8">
      <SectionHead
        title="Library"
        fullBleed
        headingLevel={1}
        titleClassName="text-[72px] sm:text-[88px]"
      />

      {/* Tabs + Filter */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {TABS.map((t) => (
            <Chip
              key={t.id}
              active={tab === t.id}
              onClick={() => {
                setTab(t.id)
                // Films have no Dropped state.
                if (t.id === 'movie' && filter === 'dropped') setFilter('all')
              }}
            >
              {t.label}
            </Chip>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <FilterBar
            filter={filter}
            showDropped={tab !== 'movie'}
            sort={sort}
            minRating={minRating}
            count={shown.length}
            onFilter={setFilter}
            onSort={setSort}
            onMinRating={setMinRating}
          />
          <SearchInput value={q} onChange={setQ} label="Search your library" placeholder="Search your library…" className="w-full sm:w-64 md:w-96" />
        </div>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {hydrated ? `${shown.length} title${shown.length === 1 ? '' : 's'} shown` : 'Loading your library'}
      </p>

      {!hydrated ? (
        <PosterGrid columns={settings.libraryColumns}>
          {Array.from({ length: 12 }, (_, i) => (
            <PosterSkeleton key={i} />
          ))}
        </PosterGrid>
      ) : entries.length === 0 ? (
        <div className="space-y-3 text-center">
          <Empty>No titles here yet</Empty>
          <a
            href="#discover"
            className="press inline-block font-sans text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground underline underline-offset-4 hover:text-[var(--primary)]"
          >
            Find something in Discover
          </a>
        </div>
      ) : shown.length === 0 ? (
        <div className="space-y-3">
          <Empty>
            {tab === 'favorites' && pool.length === 0
              ? 'No favourites yet — mark one with the heart on a title page'
              : deferredQ.trim()
                ? `Nothing in your library matches “${deferredQ.trim()}”`
                : 'No titles match these filters'}
          </Empty>
          <button
            type="button"
            onClick={() => {
              setTab('all')
              setFilter('all')
              setSort(DEFAULT_SORT)
              setMinRating(0)
              setQ('')
            }}
            className="press font-sans text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground underline underline-offset-4 hover:text-[var(--primary)]"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <>
          <PosterGrid columns={settings.libraryColumns}>
            {paged.map((e) => (
              <Poster key={`${e.mediaType}-${e.id}`} item={itemFor(e)} entry={e} onOpen={onOpen} />
            ))}
          </PosterGrid>
          {paged.length < shown.length && <div ref={setSentinel} className="h-px" aria-hidden />}
        </>
      )}
    </div>
  )
}

/** Collapses filter / sort controls into a single popover button. */
function FilterBar({
  filter,
  showDropped,
  sort,
  minRating,
  count,
  onFilter,
  onSort,
  onMinRating,
}: {
  filter: LibraryFilter
  showDropped: boolean
  sort: (typeof SORTS)[number]['id']
  minRating: (typeof RATING_OPTIONS)[number]['id']
  count: number
  onFilter: (v: LibraryFilter) => void
  onSort: (v: (typeof SORTS)[number]['id']) => void
  onMinRating: (v: (typeof RATING_OPTIONS)[number]['id']) => void
}) {
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [popoverStyle, setPopoverStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  const leaveTimer = useRef<number | null>(null)

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const popoverWidth = Math.min(300, viewportWidth - 32)
    const left = Math.min(rect.right - popoverWidth, viewportWidth - popoverWidth - 16)
    const desiredHeight = Math.min(boxRef.current?.scrollHeight ?? 520, 520, viewportHeight * 0.7)
    const spaceBelow = Math.max(0, viewportHeight - rect.bottom - 24)
    const spaceAbove = Math.max(0, rect.top - 24)
    const placeAbove = desiredHeight > spaceBelow && spaceAbove > spaceBelow
    const availableHeight = placeAbove ? spaceAbove : spaceBelow
    const maxHeight = Math.min(520, viewportHeight * 0.7, availableHeight)
    const panelHeight = Math.min(desiredHeight, maxHeight)
    const top = placeAbove ? rect.top - panelHeight - 8 : rect.bottom + 8

    setPopoverStyle({
      left: `${Math.max(16, left) + window.scrollX}px`,
      top: `${Math.max(8, top) + window.scrollY}px`,
      maxHeight: `${maxHeight}px`,
      transformOrigin: placeAbove ? 'bottom right' : 'top right',
    })
  }, [])

  useEffect(
    () => () => {
      if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    },
    [],
  )

  useEffect(() => {
    if (open) {
      setLeaving(false)
      let raf2 = 0
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          setShown(true)
          updatePosition()
          boxRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
        })
      })
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          setOpen(false)
          triggerRef.current?.focus()
        }
      }
      const onPointerDown = (e: PointerEvent) => {
        const target = e.target as Node
        if (!boxRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false)
      }
      const onResize = () => updatePosition()
      window.addEventListener('keydown', onKey, true)
      document.addEventListener('pointerdown', onPointerDown)
      window.addEventListener('resize', onResize)
      return () => {
        cancelAnimationFrame(raf1)
        cancelAnimationFrame(raf2)
        window.removeEventListener('keydown', onKey, true)
        document.removeEventListener('pointerdown', onPointerDown)
        window.removeEventListener('resize', onResize)
      }
    }
    setShown(false)
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => setLeaving(true), 200)
    return undefined
  }, [open, updatePosition])

  const active = filter !== 'all' || sort !== DEFAULT_SORT || minRating > 0
  const activeCount = (filter !== 'all' ? 1 : 0) + (sort !== DEFAULT_SORT ? 1 : 0) + (minRating > 0 ? 1 : 0)
  const sortLabel = SORTS.find((s) => s.id === sort)?.label

  const popover = (
    <div
      ref={boxRef}
      id="library-filter-popover"
      role="dialog"
      aria-label="Filter library"
      style={popoverStyle}
      onKeyDown={(e) => {
        // The popover is portaled to <body>; send Tab back into page order
        // (to the trigger) instead of letting focus fall off the document.
        if (e.key !== 'Tab') return
        const focusables = Array.from(boxRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])
        const atEdge = e.shiftKey ? document.activeElement === focusables[0] : document.activeElement === focusables[focusables.length - 1]
        if (atEdge) {
          e.preventDefault()
          setOpen(false)
          triggerRef.current?.focus()
        }
      }}
      className="quiet-scroll animate-[ct-tick_180ms_var(--ease-sheet)_both] absolute z-30 max-h-[min(70vh,520px)] w-[300px] max-w-[calc(100vw-32px)] origin-top-right overflow-y-auto border border-border bg-background p-4 shadow-[var(--shadow-pop)]"
    >
      <div className="rule-label mb-3 border-b border-border pb-2">
        {count} shown · sorted by {sortLabel}
      </div>
      <FilterGroup label="Status">
        {FILTERS.filter((f) => showDropped || f !== 'dropped').map((f) => {
          const isActive = filter === f
          const isStatus = f !== 'all'
          // 'rewatching', 'rewatched', and 'seen' are aggregate filters, not
          // statuses — they get the accent styling instead of a status color.
          const isRewatchFilter = f === 'rewatching' || f === 'rewatched' || f === 'seen'
          const statusKey = f as Status
          const activeStyle = isRewatchFilter
            ? 'bg-[var(--accent)] text-[var(--accent-foreground)] border border-[var(--accent)]'
            : isStatus
              ? STATUS_STYLE[statusKey]
              : 'border-[var(--primary)] bg-[var(--primary)] text-primary-foreground'
          const inactiveStyle = isRewatchFilter
            ? 'border border-[var(--accent)]/30 bg-[var(--accent)]/[0.06] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)] hover:border-[var(--accent)]'
            : isStatus
              ? STATUS_INACTIVE[statusKey]
              : 'border-border text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground'
          return (
            <button
              key={f}
              type="button"
              onClick={() => onFilter(f)}
              aria-pressed={isActive}
              className={`press shrink-0 whitespace-nowrap border px-3 py-1.5 font-sans text-[11px] font-medium uppercase tracking-[0.14em] ${isActive ? activeStyle : inactiveStyle}`}
            >
              {FILTER_LABEL[f]}
            </button>
          )
        })}
      </FilterGroup>
      <FilterGroup label="Order">
        {SORTS.map((s) => (
          <Chip key={s.id} active={sort === s.id} onClick={() => onSort(s.id)}>
            {s.label}
          </Chip>
        ))}
      </FilterGroup>
      <FilterGroup label="Minimum rating">
        {RATING_OPTIONS.map((r) => (
          <Chip key={r.id} active={minRating === r.id} onClick={() => onMinRating(r.id)}>
            {r.label}
          </Chip>
        ))}
      </FilterGroup>
      {active && (
        <button
          type="button"
          onClick={() => {
            onFilter('all')
            onSort(DEFAULT_SORT)
            onMinRating(0)
            triggerRef.current?.focus()
          }}
          className="press mt-1 font-sans text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground underline underline-offset-4 hover:text-[var(--primary)]"
        >
          Reset filters
        </button>
      )}
    </div>
  )

  return (
    <>
      <div className="relative shrink-0">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            if (!open) updatePosition()
            setOpen((o) => !o)
          }}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls="library-filter-popover"
          aria-label={`Filter library${activeCount ? `, ${activeCount} active` : ''}`}
          className={`press relative flex h-9 items-center justify-center gap-2 border px-3 py-1.5 font-sans text-[11px] font-medium uppercase tracking-[0.14em] transition-colors duration-200 ${
            open || active
              ? 'border-[var(--primary)] bg-[var(--primary)] text-primary-foreground font-semibold shadow-xs'
              : 'border-border bg-card/50 text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground'
          }`}
        >
          <span>Filter</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            className={`h-4 w-4 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          >
            <path d="m7 10 5 5 5-5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {activeCount > 0 && (
            <span className="absolute -right-2 -top-2 flex h-[18px] min-w-[18px] items-center justify-center border border-[var(--primary)] bg-[var(--primary)] px-1 font-sans text-[10px] font-bold leading-none text-primary-foreground">
              {activeCount}
            </span>
          )}
        </button>
      </div>
      {(open || shown) && !leaving && createPortal(popover, document.body)}
    </>
  )
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 last:mb-2">
      <div className="rule-label mb-2">{label}</div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  )
}
