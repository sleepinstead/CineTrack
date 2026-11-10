import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { img, type MediaType, type TmdbTitle } from '../lib/tmdb'
import { countRewatches, formatRelativeDay, minutesWatched, progress, recentCompletions, useLibrary, useLibraryStatus, watchedCount, type Entry } from '../lib/library'
import type { LibraryView } from './Library'
import MonthlyChart from './MonthlyChart'
import { CloseButton, Empty, PosterTilt, PosterTiltInline, SectionHead, ShuffleIcon, Stat, useBodyScrollLock, useFocusTrap } from './ui'
import Greeting from './Greeting'

const TITLE_STOP_WORDS = new Set(['a', 'an', 'and', 'of', 'the'])

// ponytail: title tokens approximate franchise membership; use collection IDs if the library stores them.
function titleWords(title: string) {
  return [...new Set((title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !TITLE_STOP_WORDS.has(word)))]
}

function sharesTitleFamily(a: string, b: string) {
  const aWords = titleWords(a)
  const bWords = titleWords(b)
  if (!aWords.length || !bWords.length) return false

  const smaller = aWords.length <= bWords.length ? aWords : bWords
  const larger = aWords.length <= bWords.length ? bWords : aWords
  const shared = smaller.filter((word) => larger.includes(word))
  const exactMatch = aWords.length === bWords.length && shared.length === aWords.length
  return exactMatch || (shared.length >= 2 && shared.length / smaller.length >= 0.4) ||
    (shared.length === 1 && smaller.length === 1 && smaller[0].length >= 6)
}

function pickDiverse<T extends { title: string }>(items: T[], count: number) {
  const shuffled = [...items]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  const picks: T[] = []
  for (const item of shuffled) {
    if (picks.every((pick) => !sharesTitleFamily(pick.title, item.title))) picks.push(item)
    if (picks.length === count) return picks
  }

  // If the library is mostly one franchise, fill the remaining slots anyway.
  for (const item of shuffled) {
    if (!picks.includes(item)) picks.push(item)
    if (picks.length === count) break
  }
  return picks
}

export default function Home({
  onOpen,
  onLibraryNavigate,
}: {
  onOpen: (t: MediaType, id: number, seed?: TmdbTitle) => void
  onLibraryNavigate: (view: LibraryView) => void
}) {
  const { entries } = useLibrary()
  const { hydrated } = useLibraryStatus()

  const stats = useMemo(() => {
    const movies = entries.filter((e) => e.mediaType === 'movie')
    const shows = entries.filter((e) => e.mediaType === 'tv')
    const moviesSeen = movies.filter((m) => m.status === 'watched' || m.status === 'dropped' || m.watchedAt != null).length
    const showsSeen = shows.filter((s) => s.status === 'watched' || s.status === 'dropped' || s.watchedAt != null).length
    const mins = minutesWatched(entries)
    const rated = entries.filter((e) => e.rating)
    return {
      total: entries.length,
      favorites: entries.filter((e) => e.favorite).length,
      rewatches: countRewatches(entries),
      moviesSeen,
      moviesTotal: movies.length,
      showsSeen,
      showsTotal: shows.length,
      hours: Math.round(mins / 60),
      avg: rated.length ? (rated.reduce((s, e) => s + (e.rating ?? 0), 0) / rated.length).toFixed(1) : '—',
      inProgress: entries.filter((e) => e.status === 'watching' || (e.mediaType === 'tv' && e.rewatching)),
      planned: entries.filter((e) => e.status === 'planned'),
    }
  }, [entries])

  const allActivity = useMemo(() => recentCompletions(entries), [entries])
  const activity = allActivity.slice(0, 10)
  const hasData = entries.length > 0

  const [shuffleKey, setShuffleKey] = useState(0)
  const [activityOpen, setActivityOpen] = useState(false)
  // Re-deal only when the set of planned titles changes or on Shuffle — not
  // on every unrelated edit (ticking an episode used to reshuffle the picks).
  const plannedSignature = stats.planned.map((e) => `${e.mediaType}:${e.id}`).sort().join(',')
  const [picks, setPicks] = useState<{ key: string; ids: string[] }>({ key: '', ids: [] })
  const pickKey = `${plannedSignature}#${shuffleKey}`
  useEffect(() => {
    setPicks({ key: pickKey, ids: pickDiverse(stats.planned, 3).map((e) => `${e.mediaType}:${e.id}`) })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-deal on the signature, not on array identity
  }, [pickKey])
  const suggestions = useMemo(() => {
    const byKey = new Map(stats.planned.map((e) => [`${e.mediaType}:${e.id}`, e]))
    return picks.ids.map((key) => byKey.get(key)).filter((e): e is Entry => !!e)
  }, [picks, stats.planned])

  return (
    <div className="space-y-16">
      <section>
        <div className="border-b border-border pb-6">

          <Greeting />
        </div>
        <div className="mt-8 grid grid-cols-2 gap-y-8 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Titles held" value={stats.total} onClick={() => onLibraryNavigate({ tab: 'all', filter: 'all' })} />
          <Stat label="Films seen" value={stats.moviesSeen} unit={`/ ${stats.moviesTotal}`} onClick={() => onLibraryNavigate({ tab: 'movie', filter: 'seen' })} />
          <Stat label="Shows seen" value={stats.showsSeen} unit={`/ ${stats.showsTotal}`} onClick={() => onLibraryNavigate({ tab: 'tv', filter: 'seen' })} />
          <Stat label="Favourites" value={stats.favorites} onClick={() => onLibraryNavigate({ tab: 'favorites', filter: 'all' })} />
          <Stat label="Rewatches" value={stats.rewatches} onClick={() => onLibraryNavigate({ tab: 'all', filter: 'rewatched' })} />
          <Stat label="Time in seat" value={stats.hours} unit="hrs" onClick={() => document.getElementById('monthly-log')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })} />
        </div>
      </section>

      <section>
        <SectionHead
          title="Currently in progress"
          note="Series, films, and rewatches left mid-viewing."
          rule={false}
          right={stats.inProgress.length > 2 ? (
            <button
              type="button"
              onClick={() => onLibraryNavigate({ tab: 'all', filter: 'watching' })}
              className="press inline-flex py-2 font-sans text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:text-[var(--primary)]"
            >
              See all {stats.inProgress.length}
            </button>
          ) : undefined}
        />
        {!hydrated ? (
          <div className="h-[130px] border border-border bg-card shimmer" aria-hidden="true" />
        ) : stats.inProgress.length === 0 ? (
          <Empty>Nothing underway — visit Discover to begin a title</Empty>
        ) : (
          <div className="grid gap-px border border-border bg-border md:grid-cols-2">
            {stats.inProgress.slice(0, 2).map((e, i) => (
              <button
                type="button"
                key={`${e.mediaType}-${e.id}`}
                onClick={() => onOpen(e.mediaType, e.id)}
                style={{ animationDelay: `${i * 55}ms` }}
                className={`group animate-rise flex items-center gap-4 bg-background p-4 text-left transition-colors duration-300 hover:bg-card ${
                  stats.inProgress.length === 1 ? 'md:col-span-2' : ''
                }`}
              >
                {(e.customPoster ?? img(e.poster, 'w185')) && (
                  <PosterTiltInline className="block h-24 w-16 shrink-0">
                    <span data-poster-surface className="poster-card-3d__art relative block h-full w-full overflow-hidden">
                      <img
                        src={(e.customPoster ?? img(e.poster, 'w185'))!}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        width={64}
                        height={96}
                        className="h-full w-full object-cover"
                      />
                    </span>
                  </PosterTiltInline>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-display text-[21px] leading-tight group-hover:text-[var(--primary)]">
                    {e.title}
                  </span>
                  <span className="rule-label">
                    {e.mediaType === 'tv'
                      ? `${e.rewatching ? Object.keys(e.rewatchEpisodes).length : watchedCount(e)} of ${e.totalEpisodes ?? '?'} episodes${e.rewatching ? ' · Rewatching' : ''}`
                      : 'Film · in progress'}
                  </span>
                  {e.mediaType === 'tv' && (
                    <span className="mt-2 block h-[3px] w-full bg-secondary">
                      <span
                        className="animate-grow block h-full bg-[var(--primary)] transition-[width] duration-500 ease-out"
                        style={{ width: `${progress(e) * 100}%` }}
                      />
                    </span>
                  )}
                </span>
                {e.mediaType === 'tv' && (
                  <span className="font-sans text-[11px] tabular-nums text-muted-foreground">
                    {Math.round(progress(e) * 100)}%
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-8 md:grid-cols-[1.2fr_1fr] xl:grid-cols-[1fr_1.2fr]">
        <div>
          <SectionHead
            title="Activity"
            note="A running ledger of the last entries marked seen."
            rule={false}
            right={allActivity.length > 0 ? (
              <button
                type="button"
                onClick={() => setActivityOpen(true)}
                aria-haspopup="dialog"
                className="press inline-flex py-2 font-sans text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:text-[var(--primary)]"
              >
                See all activity
              </button>
            ) : undefined}
          />
          {!hydrated ? (
            <div className="h-[260px] border-y border-border shimmer" aria-hidden="true" />
          ) : activity.length === 0 ? (
            <Empty>No viewings recorded</Empty>
          ) : (
            <ol className="divide-y divide-border border-y border-border">
              {activity.map((a, i) => (
                <li key={`${a.entry.mediaType}-${a.entry.id}-${a.label}-${a.at}`} className="animate-rise" style={{ animationDelay: `${i * 40}ms` }}>
                  <button
                    type="button"
                    onClick={() => onOpen(a.entry.mediaType, a.entry.id)}
                    className="group flex w-full items-baseline gap-4 py-[12.5px] text-left transition-colors duration-200 hover:text-[var(--primary)]"
                  >
                    <span className="min-w-0 flex-1 truncate font-sans text-[16px] transition-transform duration-300 group-hover:translate-x-1">
                      {a.entry.title}
                    </span>
                    <span className="flex shrink-0 items-baseline gap-3 transition-transform duration-300 group-hover:-translate-x-1 sm:gap-5">
                      <span className="font-sans text-[10px] text-[var(--accent)]">{a.label}</span>
                      <time dateTime={new Date(a.at).toISOString()} className="min-w-[3.5rem] text-right font-sans text-[10px] tabular-nums text-muted-foreground">
                        {formatRelativeDay(a.at)}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="flex min-w-0 flex-col">
          <SectionHead
            title="Feeling lucky?"
            note="Three random picks from your watchlist."
            rule={false}
            right={
              stats.planned.length > 3 ? (
                <button
                  type="button"
                  onClick={() => setShuffleKey((k) => k + 1)}
                  aria-label="Shuffle recommendations"
                  className="press relative z-50 inline-flex items-center gap-2 border border-border bg-background px-3.5 py-2 font-sans text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-[var(--primary)] hover:text-[var(--primary)]"
                >
                  <ShuffleIcon className="size-4" /> Shuffle
                </button>
              ) : undefined
            }
          />
          {!hydrated ? (
            <div className="min-h-40 border border-border bg-card shimmer" aria-hidden="true" />
          ) : stats.planned.length === 0 ? (
            <div className="flex min-h-40 items-center gap-5 border border-dashed border-border px-6 py-8">
              <span aria-hidden className="font-display text-4xl italic text-[var(--primary)]">∅</span>
              <p className="max-w-[34ch] text-[13px] leading-relaxed text-muted-foreground">
                Your watchlist is waiting for its first feature.{' '}
                <a href="#discover" className="text-foreground underline decoration-border underline-offset-4 transition-colors hover:text-[var(--primary)]">
                  Find something in Discover <span aria-hidden>→</span>
                </a>
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 items-start gap-3 sm:gap-4 xl:gap-4">
                {suggestions.map((e, i) => (
                  <PosterTilt
                    key={`${e.mediaType}-${e.id}-${shuffleKey}`}
                    style={{ animationDelay: `${i * 60}ms` }}
                    className="mx-auto w-full max-w-[300px] animate-plate-fade"
                  >
                    <button
                      type="button"
                      onClick={() => onOpen(e.mediaType, e.id)}
                      aria-label={`${e.title}${e.year ? ` (${e.year})` : ''}`}
                      className="group flex w-full flex-col text-left"
                    >
                      <span data-poster-surface className="poster-card-3d__art relative block aspect-[2/3] w-full overflow-hidden bg-card">
                        {(e.customPoster ?? img(e.poster, 'w500')) ? (
                          <img src={(e.customPoster ?? img(e.poster, 'w500'))!} alt="" loading="lazy" decoding="async" width={300} height={450} className="h-full w-full object-contain transition-[filter,opacity] duration-500 group-hover:brightness-110 group-hover:saturate-110" />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center font-display text-4xl text-muted-foreground">
                            {e.title.slice(0, 1)}
                          </span>
                        )}
                      </span>
                      <span className="poster-card-3d__meta">
                        <span className="mt-3 block line-clamp-2 font-sans text-[13px] leading-tight transition-colors duration-300 group-hover:text-[var(--primary)] sm:text-[15px]">
                          {e.title}
                        </span>
                        <span className="rule-label mt-1.5 block transition-colors duration-300 group-hover:text-foreground">
                          {e.mediaType === 'movie' ? 'Film' : 'Series'} <span className="px-1 text-border">/</span> {e.year || '—'}
                        </span>
                      </span>
                    </button>
                  </PosterTilt>
                ))}
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-border pt-3 rule-label">
                <span>{stats.planned.length} {stats.planned.length === 1 ? 'title' : 'titles'} planned</span>
                <span><span className="text-[var(--primary)]">{String(suggestions.length).padStart(2, '0')}</span> selected</span>
              </div>
            </>
          )}
        </div>
      </section>

      {activityOpen && (
        <ActivityModal
          items={allActivity}
          onClose={() => setActivityOpen(false)}
          onOpenTitle={(mediaType, id) => {
            setActivityOpen(false)
            onOpen(mediaType, id)
          }}
        />
      )}

      <div id="monthly-log" className="scroll-mt-24">
        <MonthlyChart entries={entries} />
      </div>

      {hydrated && !hasData && (
        <p className="border-t border-border pt-6 text-[13px] leading-relaxed text-muted-foreground">
          Your archive is empty. Head to{' '}
          <a href="#discover" className="font-medium text-foreground underline underline-offset-4 hover:text-[var(--primary)]">
            Discover
          </a>{' '}
          to search TMDb and add your first title. Your archive is stored locally on this device.
        </p>
      )}
    </div>
  )
}

function ActivityModal({
  items,
  onClose,
  onOpenTitle,
}: {
  items: ReturnType<typeof recentCompletions>
  onClose: () => void
  onOpenTitle: (type: MediaType, id: number) => void
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const [shown, setShown] = useState(false)
  useBodyScrollLock(true)
  useFocusTrap(dialogRef, shown)

  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true))
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])

  return createPortal((
    <div
      className={`modal-backdrop fixed inset-0 z-[80] flex items-center justify-center bg-[var(--scrim)] p-3 sm:p-4 ${shown ? '' : 'pointer-events-none'}`}
      data-open={shown}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="activity-modal-title"
        className="modal-sheet flex h-[min(82vh,680px)] w-full max-w-[620px] flex-col border border-border bg-background shadow-[var(--shadow-sheet)]"
        data-open={shown}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4.5 py-3">
          <div className="min-w-0 pr-2">
            <span className="rule-label block text-[var(--primary)] text-[10px]">Viewing ledger · {items.length} {items.length === 1 ? 'entry' : 'entries'}</span>
            <h2 id="activity-modal-title" className="mt-0.5 truncate font-display text-[20px] leading-tight">Activity</h2>
          </div>
          <CloseButton onClick={onClose} label="Close activity" />
        </header>
        <ol className="quiet-scroll min-h-0 flex-1 divide-y divide-border overflow-y-auto px-4.5">
          {items.map((item, index) => (
            <li key={`${item.entry.mediaType}-${item.entry.id}-${item.at}-${index}`}>
              <button
                type="button"
                onClick={() => onOpenTitle(item.entry.mediaType, item.entry.id)}
                className="group flex w-full items-baseline gap-4 py-3 text-left transition-colors duration-200 hover:text-[var(--primary)]"
              >
                <span className="min-w-0 flex-1 truncate font-sans text-[14px] transition-transform duration-300 group-hover:translate-x-1 sm:text-[15px]">
                  {item.entry.title}
                </span>
                <span className="flex shrink-0 items-baseline gap-3 transition-transform duration-300 group-hover:-translate-x-1 sm:gap-5">
                  <span className="font-sans text-[10px] text-[var(--accent)]">{item.label}</span>
                  <time dateTime={new Date(item.at).toISOString()} className="min-w-[3.5rem] text-right font-sans text-[10px] tabular-nums text-muted-foreground">
                    {formatRelativeDay(item.at)}
                  </time>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </div>
  ), document.body)
}
