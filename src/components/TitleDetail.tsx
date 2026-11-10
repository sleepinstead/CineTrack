import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  details,
  img,
  season as fetchSeason,
  titleOf,
  yearOf,
  type Episode,
  type MediaType,
  type SeasonSummary,
  type TitleDetail as Detail,
  type TmdbTitle,
  isNotFoundError,
} from '../lib/tmdb'
import {
  canLogRewatch,
  epKey,
  useEntry,
  fromDateInput,
  isCompletedAtLeastOnce,
  originalCompletionAt,
  rewatchLockedReason,
  toDateInput,
  todayInput,
  useLibrary,
  useLibraryStatus,
  watchedCount,
  type Entry,
  type Status,
} from '../lib/library'
import { canSetDropped, statusOptionsFor, statusTransition } from '../lib/status'
import { MAX_CUSTOM_POSTER_FILE_BYTES, prepareCustomPoster } from '../lib/custom-poster'
import { useSettings } from '../lib/settings'
import { CarouselNav, CloseButton, ConfirmDialog, Empty, PosterTilt, Spinner, STATUS_BADGE, STATUS_INACTIVE, STATUS_STYLE, handleRadioGroupKeyDown, useBodyScrollLock, useFocusTrap, usePosterArt, useTimedTooltip } from './ui'
import { useToast } from './Toast'
import CastDetail from './CastDetail'
import { ErrorNotice, ErrorState, NotFound } from './Errors'

const MAX_AUTO_EPISODES = 20000
const DRAWER_TRANSITION_MS = 320

function markAllEpisodes(seasons: SeasonSummary[], at: number, seed: Record<string, number> = {}) {
  const marked = { ...seed }
  let count = Object.keys(marked).length
  outer: for (const season of seasons) {
    if (!Number.isInteger(season.season_number) || season.season_number <= 0) continue
    const episodeCount = typeof season.episode_count === 'number' && Number.isSafeInteger(season.episode_count)
      ? Math.min(10000, Math.max(0, season.episode_count))
      : 0
    for (let ep = 1; ep <= episodeCount; ep++) {
      if (count >= MAX_AUTO_EPISODES) break outer
      const key = epKey(season.season_number, ep)
      if (marked[key] == null) {
        marked[key] = at
        count++
      }
    }
  }
  return marked
}

export default function TitleDetail({
  type,
  id,
  seed,
  onClose: requestClose,
  onOpenTitle,
}: {
  type: MediaType
  id: number
  seed?: TmdbTitle
  onClose: () => void
  onOpenTitle?: (t: MediaType, id: number) => void
}) {
  const [data, setData] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** TMDb has no record of this title (deleted, or a bad id in a link). */
  const [notFound, setNotFound] = useState(false)
  const [editing, setEditing] = useState(false)
  const [rewatchOpen, setRewatchOpen] = useState(false)
  const [pendingStatus, setPendingStatus] = useState<Status | null>(null)
  const [confirmDeaccession, setConfirmDeaccession] = useState(false)
  const [tvView, setTvView] = useState<'seasons' | 'cast'>('seasons')
  const [personId, setPersonId] = useState<number | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const closeTimer = useRef<number | null>(null)
  const { toast } = useToast()
  useBodyScrollLock(true)
  useFocusTrap(panelRef)
  const { settings } = useSettings()
  const libraryStatus = useLibraryStatus()
  const metadataLanguage = settings.metadataLanguage
  const castTrackRef = useRef<HTMLDivElement>(null)
  // Actions only: the drawer subscribes to its own record via useEntry, so
  // edits to other titles don't re-render it.
  const {
    upsert,
    remove,
    restore,
    toggleEpisode,
    setSeasonWatched,
    setRewatching,
    addRewatch,
    setRewatchDate,
    removeRewatch,
  } = useLibrary(false)
  const entry = useEntry(type, id)
  const seasonEpisodeTotal = data?.seasons?.reduce(
    (total, season) => total + (Number.isSafeInteger(season.episode_count) ? Math.max(0, season.episode_count) : 0),
    0,
  ) ?? 0
  const detailTotalEpisodes = type === 'tv'
    ? data?.number_of_episodes ?? (seasonEpisodeTotal || entry?.totalEpisodes || null)
    : null

  // Slide the drawer in on mount, out on close.
  const [shown, setShown] = useState(false)
  const [panelSettled, setPanelSettled] = useState(false)
  const onClose = useCallback(() => {
    setShown(false)
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(requestClose, DRAWER_TRANSITION_MS)
  }, [requestClose])

  useEffect(() => {
    if (!shown) {
      setPanelSettled(false)
      return
    }
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : DRAWER_TRANSITION_MS
    const timer = window.setTimeout(() => setPanelSettled(true), delay)
    return () => window.clearTimeout(timer)
  }, [shown])

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    },
    [],
  )

  // Double-rAF latch: paint the off-screen pose first, then slide in.
  // Mirrors SettingsPanel exactly — the single rAF here let the first open
  // skip the entrance because the browser never painted the closed pose.
  useEffect(() => {
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShown(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [])

  const [detailAttempt, setDetailAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let live = true
    setData(null)
    setError(null)
    setNotFound(false)
    details(type, id, { signal: controller.signal })
      .then((d) => live && setData(d))
      .catch((e) => {
        if (!live) return
        setError(e.message)
        setNotFound(isNotFoundError(e))
      })
    return () => {
      live = false
      controller.abort()
    }
  }, [type, id, detailAttempt, metadataLanguage])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Keep stored runtime / episode totals fresh once details land if not already set.
  useEffect(() => {
    if (!data || !entry) return
    const runtime = type === 'movie' ? (data.runtime ?? null) : (data.episode_run_time?.[0] ?? null)
    const patch: Partial<Entry> = {}
    if (entry.runtime == null && runtime != null) patch.runtime = runtime
    if (entry.totalEpisodes == null && detailTotalEpisodes != null) patch.totalEpisodes = detailTotalEpisodes
    if (type === 'tv' && entry.status === 'watched' && watchedCount(entry) === 0 && data.seasons) {
      const at = entry.watchedAt ?? Date.now()
      const episodes = markAllEpisodes(data.seasons, at)
      if (Object.keys(episodes).length > 0) patch.episodes = episodes
    }
    if (Object.keys(patch).length > 0) {
      upsert(type, id, patch)
    }
  }, [data, detailTotalEpisodes, entry, type, id, upsert])

  const source = data ?? seed ?? (entry ? ({
    id: entry.id,
    media_type: entry.mediaType,
    title: entry.title,
    poster_path: entry.poster,
    backdrop_path: entry.backdrop,
    overview: '',
    // Never stand the user's own rating in for the community score.
    vote_average: 0,
    release_date: entry.year,
  } as TmdbTitle) : null)

  // The tab names the open title; the page view restores its own on close.
  const displayTitle = entry?.title || (source ? titleOf(source) : null)
  const tabTitle = displayTitle ?? (notFound ? 'Title not found' : error ? 'Title unavailable' : null)
  useEffect(() => {
    if (!tabTitle) return
    const previous = document.title
    document.title = `${tabTitle} · CineTrack`
    return () => {
      document.title = previous
    }
  }, [tabTitle])
  const contentLang = metadataLanguage.split('-')[0] !== 'en' ? metadataLanguage : undefined
  const cast = data?.credits?.cast ?? []
  // Stable identity so the season list doesn't re-run its effects every render.
  const airedSeasons = useMemo(() => data?.seasons?.filter((s) => s.episode_count > 0) ?? [], [data])

  // Hero plate. The stored poster wins over the fetched one so a library that has
  // art never loses it to a detail response that came back bare.
  const heroPath = entry?.poster ?? source?.poster_path ?? null
  const heroSource = entry?.customPoster ?? img(heroPath, 'w342')
  const heroArt = usePosterArt(
    heroSource,
    entry?.customPoster ? undefined : `${img(heroPath, 'w185')} 185w, ${img(heroPath, 'w342')} 342w, ${img(heroPath, 'w500')} 500w`,
    { fallbackSrc: img(heroPath, 'w185') },
  )

  const add = (patch: Record<string, unknown> = {}) => {
    const runtime = data ? (type === 'movie' ? (data.runtime ?? null) : (data.episode_run_time?.[0] ?? null)) : null
    upsert(type, id, { runtime, totalEpisodes: detailTotalEpisodes, ...patch }, source ?? undefined)
  }

  const rawRuntime = entry?.runtime ?? (type === 'movie' ? (data?.runtime ?? null) : (data?.episode_run_time?.[0] ?? null))
  const formattedRuntime = rawRuntime ? formatRuntime(rawRuntime) : null
  const releaseRaw =
    (data?.release_date ?? data?.first_air_date ?? source?.release_date ?? source?.first_air_date ?? '').trim()
  const releaseLabel = formatReleaseDate(releaseRaw)

  /** Single transition table for status changes (picker + confirms). */
  const applyStatus = (s: Status, announce = true) => {
    if (!entry) return
    if (s === 'dropped' && !canSetDropped(type, entry.status, watchedCount(entry))) return
    const now = Date.now()
    const priorCompletion = entry.status === 'watched' ? originalCompletionAt(entry) : entry.watchedAt
    const transition = statusTransition(entry.status, s, priorCompletion, now)
    let episodesPatch: Record<string, number> | undefined
    if (type === 'tv' && s === 'watched' && data?.seasons) {
      episodesPatch = markAllEpisodes(data.seasons, now, entry.episodes)
    }
    if (transition.clearEpisodes && type === 'tv') {
      // Starting over — clear every logged episode.
      episodesPatch = {}
    }
    upsert(type, id, {
      status: transition.status,
      watchedAt: transition.watchedAt,
      ...(episodesPatch ? { episodes: episodesPatch } : {}),
      ...(transition.clearEpisodes && type === 'tv' ? { rewatching: false, rewatchEpisodes: {} } : {}),
    })
    if (announce) toast(`Marked ${STATUS_BADGE[s]?.label?.toLowerCase() ?? s}`, 'info')
  }

  const imdbIdRaw = data?.imdb_id ?? data?.external_ids?.imdb_id ?? null
  const imdbId = typeof imdbIdRaw === 'string' && /^tt\d+$/.test(imdbIdRaw) ? imdbIdRaw : null
  const metaParts: { text: string; isScore?: boolean; href?: string }[] = source
    ? [
        { text: releaseLabel ?? entry?.year ?? yearOf(source) ?? '—' },
        ...(type === 'movie'
          ? (formattedRuntime ? [{ text: formattedRuntime }] : [])
          : [{ text: `${data?.number_of_episodes ?? entry?.totalEpisodes ?? '—'} EPISODES` }]),
        ...(typeof source.vote_average === 'number' && source.vote_average > 0
          ? [{ text: `TMDb ${source.vote_average.toFixed(1)}`, isScore: true }]
          : []),
        ...(imdbId ? [{ text: 'IMDb', href: `https://www.imdb.com/title/${imdbId}/` }] : []),
      ]
    : []

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-end bg-[var(--scrim-soft)] transition-opacity duration-[var(--dur-quick)] ${shown ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      data-open={shown}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={source ? `${entry?.title || titleOf(source)} — catalogue entry` : 'Catalogue entry'}
        className="drawer-sheet relative flex h-full w-full max-w-[920px] flex-col overflow-hidden border-l border-border bg-background shadow-[var(--shadow-drawer)]"
        data-open={shown}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-6 py-3">
          <span className="rule-label">{type === 'movie' ? 'Film' : 'Series'} · Title details</span>
          <CloseButton onClick={onClose} label="Close title details" />
        </header>

        <div className="quiet-scroll min-h-0 flex-1 overflow-y-auto">

        {error && !source && (notFound ? (
          <NotFound
            size="panel"
            title="This title isn’t on TMDb"
            message="It may have been removed, or the link has the wrong ID."
            actions={[{ label: 'Close', onClick: onClose }]}
          />
        ) : (
          <ErrorState
            size="panel"
            title="This title couldn’t load"
            message={error}
            actions={[
              { label: 'Retry', onClick: () => setDetailAttempt((a) => a + 1) },
              { label: 'Close', onClick: onClose },
            ]}
          />
        ))}

        {!source && !data && !error && (
          <div className="flex min-h-[65vh] flex-col items-center justify-center gap-3 animate-fade">
            <Spinner size={38} />
          </div>
        )}

        {source && (
          <div className="animate-fade">
            {error && (
              <ErrorNotice
                className="mx-4 mt-4 sm:mx-6"
                title={notFound ? 'TMDb no longer lists this title' : 'Showing saved details'}
                message={notFound ? 'Your library entry is kept as it is.' : `Latest catalogue details are unavailable — ${error}`}
                onRetry={notFound ? undefined : () => setDetailAttempt((a) => a + 1)}
              />
            )}
            <div className="grid gap-6 px-4 pb-5 pt-6 sm:grid-cols-[160px_1fr] sm:px-6 sm:pt-7 lg:grid-cols-[230px_1fr] lg:grid-rows-[345px] lg:gap-8">
              <PosterTilt className="w-full max-w-[180px] select-none sm:max-w-none">
                <div data-poster-surface className="overflow-hidden border border-border lg:h-[345px] lg:min-h-0">
                  {heroArt.status === 'ready' || heroArt.status === 'loading' ? (
                    <img
                      ref={heroArt.elRef}
                      src={heroArt.src!}
                      srcSet={heroArt.srcSet}
                      sizes="(max-width: 1024px) 230px, 230px"
                      alt={`Poster for ${entry?.title || titleOf(source)}`}
                      width={342}
                      height={513}
                      decoding="async"
                      onLoad={heroArt.onLoad}
                      onError={heroArt.onError}
                      className={`animate-plate h-full w-full bg-muted object-cover ${
                        heroArt.status === 'loading' ? 'opacity-0' : 'opacity-100'
                      }`}
                    />
                  ) : (
                    // No art, and art that would not load, look the same — and both
                    // name the title. An empty plate read as a missing poster.
                    <div className="flex aspect-[2/3] w-full items-center justify-center bg-muted p-3 text-center font-display text-lg text-muted-foreground">
                      {entry?.title || titleOf(source)}
                    </div>
                  )}
                </div>
              </PosterTilt>

              <div className="animate-rise relative flex flex-col [animation-delay:80ms] lg:h-[345px] lg:min-h-0">
                <h1 lang={entry?.title ? undefined : contentLang} className="line-clamp-2 min-h-[2.75rem] overflow-hidden font-display text-[34px] leading-[1.05] tracking-tight sm:text-[42px]">{entry?.title || titleOf(source)}</h1>
                <p className="mt-1 font-sans text-[11px] tracking-[0.14em] text-muted-foreground lg:truncate">
                  {metaParts.map((part, idx) => (
                    <span key={idx}>
                      {idx > 0 && <span className="mx-2 text-border">·</span>}
                      {part.href ? (
                        <a
                          href={part.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          referrerPolicy="no-referrer"
                          className="font-medium text-[var(--primary)] underline decoration-[var(--primary)]/40 underline-offset-[3px] transition-opacity hover:opacity-75"
                        >
                          {part.text}
                          <span className="sr-only"> (opens IMDb in a new tab)</span>
                        </a>
                      ) : part.isScore ? (
                        <span title="TMDb community score">{part.text}</span>
                      ) : (
                        part.text
                      )}
                    </span>
                  ))}
                </p>
                <div className="relative mt-2 min-h-0 max-w-prose flex-1">
                  {/* Scrolls rather than clipping long synopses in the fixed-height desktop layout. */}
                  <p
                    lang={contentLang}
                    tabIndex={0}
                    aria-label="Synopsis"
                    className="quiet-scroll text-[14px] leading-relaxed text-secondary-foreground lg:h-full lg:overflow-y-auto lg:pb-16"
                  >
                    {source.overview || 'No synopsis on file.'}
                  </p>
                </div>
                {entry?.note && (
                  <div className="mt-1 h-12 overflow-hidden border-l-2 border-[var(--primary)] bg-card/60 px-3.5 py-1">
                    <span className="rule-label block text-[9px] text-[var(--primary)]">Personal Note</span>
                    <p className="mt-0.5 line-clamp-1 font-serif text-[13px] italic leading-tight text-foreground">{entry.note}</p>
                  </div>
                )}

                {/* Control row — mirrors the reference: status · rating · date, then actions.
                    mt-auto floats it to the bottom edge of the poster beside it. */}
                <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border pt-4 lg:absolute lg:inset-x-0 lg:bottom-0 lg:mt-0 lg:flex-nowrap lg:items-end">
                  {!entry ? (
                    <button
                      type="button"
                      disabled={!libraryStatus.hydrated}
                      onClick={() => {
                        add({ status: settings.defaultStatus })
                        toast(`${displayTitle ?? 'Title'} added to your library`, 'success')
                      }}
                      className="press animate-tick flex h-8 items-center gap-2 bg-[var(--primary)] px-5 font-sans text-[11px] font-medium uppercase tracking-[0.16em] text-primary-foreground hover:opacity-85"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M12 5v14M5 12h14" />
                      </svg>
                      <span>Add to library</span>
                    </button>
                  ) : (
                    <>
                      <div className="flex flex-1 flex-wrap items-center gap-3">
                        <StatusButtons
                          title={entry?.title || titleOf(source)}
                          status={entry.status}
                          mediaType={type}
                          watchedEpisodeCount={watchedCount(entry)}
                          rewatching={entry.rewatching}
                          rewatchProgress={Object.keys(entry.rewatchEpisodes).length}
                          onToggleRewatch={(active) => {
                            setRewatching(id, active)
                            toast(active ? 'Rewatch started' : 'Rewatch paused', 'info')
                          }}
                          onChange={(s) => {
                            const transition = statusTransition(entry.status, s, entry.watchedAt)
                            // Resetting a logged series is destructive — confirm first.
                            if (transition.clearEpisodes && type === 'tv' && (Object.keys(entry.episodes ?? {}).length > 0 || Object.keys(entry.rewatchEpisodes ?? {}).length > 0)) {
                              setPendingStatus(s)
                              return
                            }
                            applyStatus(s)
                          }}
                        />
                        <div className="relative group">
                          <button
                            type="button"
                            onClick={() => setEditing(true)}
                            aria-label={entry.rating ? `Rating: ${entry.rating}/10` : 'Rate title'}
                            className={`press flex h-8 w-8 items-center justify-center transition-all ${
                              entry.rating
                                ? 'bg-[var(--accent)] text-accent-foreground font-sans text-[12px] font-medium tabular-nums shadow-xs hover:opacity-90'
                                : 'border border-dashed border-border text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground font-sans text-[12px]'
                            }`}
                          >
                            {entry.rating ?? '—'}
                          </button>
                          <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap border border-border bg-foreground px-2 py-0.5 font-sans text-[10px] font-medium tracking-[0.04em] text-background opacity-0 transition-opacity duration-150 group-hover:opacity-100 z-30 shadow-xs select-none">
                            {entry.rating ? `Rating: ${entry.rating}/10` : 'Rate title'}
                          </span>
                        </div>
                        {entry.watchedAt != null && (
                          <span className="font-sans text-[12px] tabular-nums text-muted-foreground">
                            {new Date(entry.watchedAt).toLocaleDateString('en-GB')}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <IconButton
                          label="Favourite"
                          tooltip={entry.favorite ? 'Remove from favourites' : 'Add to favourites'}
                          pressed={entry.favorite}
                          onClick={() => upsert(type, id, { favorite: !entry.favorite })}
                        >
                          <HeartIcon filled={entry.favorite} />
                        </IconButton>
                        <IconButton
                          label="Rewatches"
                          tooltip={
                            !isCompletedAtLeastOnce(entry)
                              ? (type === 'movie' ? 'Complete film to log rewatch' : 'Complete series to log rewatch')
                              : entry.rewatches.length > 0
                                ? `Rewatches (${entry.rewatches.length})`
                                : 'Rewatches'
                          }
                          disabled={!isCompletedAtLeastOnce(entry)}
                          active={entry.rewatches.length > 0}
                          hasPopup
                          onClick={() => {
                            if (!isCompletedAtLeastOnce(entry)) return
                            setRewatchOpen(true)
                          }}
                        >
                          <RewatchIcon />
                          {entry.rewatches.length > 0 && (
                            <span className="pointer-events-none absolute -right-1.5 -top-1.5 flex h-[17px] min-w-[17px] items-center justify-center border border-[var(--primary)] bg-[var(--primary)] px-1 font-sans text-[10px] font-bold leading-none text-primary-foreground shadow-xs">
                              {entry.rewatches.length}
                            </span>
                          )}
                        </IconButton>
                        <IconButton
                          label="Edit details"
                          tooltip="Edit details"
                          active={editing}
                          hasPopup
                          onClick={() => setEditing(true)}
                        >
                          <PencilIcon />
                        </IconButton>
                        <IconButton
                          label="Remove from library"
                          tooltip="Remove from library"
                          tone="danger"
                          hasPopup
                          onClick={() => setConfirmDeaccession(true)}
                        >
                          <TrashIcon />
                        </IconButton>
                      </div>
                    </>
                  )}
                </div>

              </div>
            </div>

            {/* Movies: cast only. Series: Seasons ⇄ Cast toggle, Seasons default. */}
            {type === 'movie' ? (
              <Panel
                title="Cast"
                right={
                  cast.length > 5 ? (
                    <CarouselNav
                      onPrev={() => castTrackRef.current?.scrollBy({ left: -640, behavior: 'smooth' })}
                      onNext={() => castTrackRef.current?.scrollBy({ left: 640, behavior: 'smooth' })}
                      prevLabel="Previous cast"
                      nextLabel="Next cast"
                    />
                  ) : null
                }
              >
                {!data ? (
                  error ? (
                    <Empty>Unavailable until catalogue details load</Empty>
                  ) : (
                    <div className="flex items-center justify-center py-12">
                      <Spinner size={28} />
                    </div>
                  )
                ) : (
                  <CastCarousel cast={cast} trackRef={castTrackRef} onSelect={setPersonId} />
                )}
              </Panel>
            ) : (
              <Panel
                title={tvView === 'seasons' ? 'Seasons' : 'Cast'}
                right={
                  <div className="flex items-center gap-3">
                    {tvView === 'cast' && cast.length > 5 && (
                      <CarouselNav
                        onPrev={() => castTrackRef.current?.scrollBy({ left: -640, behavior: 'smooth' })}
                        onNext={() => castTrackRef.current?.scrollBy({ left: 640, behavior: 'smooth' })}
                        prevLabel="Previous cast"
                        nextLabel="Next cast"
                      />
                    )}
                    <button
                      onClick={() => setTvView((v) => (v === 'seasons' ? 'cast' : 'seasons'))}
                      className="press border border-border px-4 py-1.5 font-sans text-[11px] font-medium uppercase tracking-[0.14em] hover:border-[var(--foreground)] hover:bg-card"
                    >
                      {tvView === 'seasons' ? 'View Cast' : 'View Seasons'}
                    </button>
                  </div>
                }
              >
                {!data ? (
                  error ? (
                    <Empty>Unavailable until catalogue details load</Empty>
                  ) : (
                    <div className="flex items-center justify-center py-12">
                      <Spinner size={28} />
                    </div>
                  )
                ) : tvView === 'cast' ? (
                  <CastCarousel cast={cast} trackRef={castTrackRef} onSelect={setPersonId} />
                ) : data?.seasons ? (
                  <Seasons
                    key={id}
                    showId={id}
                    seasons={airedSeasons}
                    watched={entry?.rewatching ? entry.rewatchEpisodes : entry?.episodes ?? {}}
                    tracked={!!entry && (entry.status !== 'watched' || entry.rewatching)}
                    completed={isCompletedAtLeastOnce(entry)}
                    rewatching={!!entry?.rewatching}
                    continueFromProgress={entry?.status === 'watching' || !!entry?.rewatching}
                    panelSettled={panelSettled}
                    onAdd={() => add({ status: 'watching' })}
                    onToggle={(s, e) => toggleEpisode(id, s, e)}
                    onBulk={(s, nums, w) => setSeasonWatched(id, s, nums, w)}
                  />
                ) : null}
              </Panel>
            )}
          </div>
        )}
        </div>

        {entry && editing && (
          <EditModal
            title={entry.title || (source ? titleOf(source) : 'Entry')}
            type={type}
            entry={entry}
            source={source}
            seasons={data?.seasons}
            onClose={() => setEditing(false)}
            onUpsert={(patch) => upsert(type, id, patch)}
          />
        )}

        {entry && rewatchOpen && (
          <RewatchModal
            title={source ? titleOf(source) : 'Entry'}
            entry={entry}
            onClose={() => setRewatchOpen(false)}
            onAddRewatch={(at) => addRewatch(type, id, at)}
            onSetRewatchDate={(i, at) => setRewatchDate(type, id, i, at)}
            onRemoveRewatch={(i) => removeRewatch(type, id, i)}
          />
        )}

        {personId != null && (
          <CastDetail
            personId={personId}
            onClose={() => setPersonId(null)}
            onOpenTitle={(t, i) => onOpenTitle?.(t, i)}
          />
        )}

        <ConfirmDialog
          open={pendingStatus !== null}
          title="Start over?"
          message={
            <>
              Moving <strong className="text-foreground">{entry?.title || (source ? titleOf(source) : 'this title')}</strong> back
              to Planned clears its episode progress, including any rewatch. You can undo this right afterwards.
            </>
          }
          confirmLabel="Clear progress"
          onCancel={() => setPendingStatus(null)}
          onConfirm={() => {
            const before = entry
            if (pendingStatus) applyStatus(pendingStatus, false)
            setPendingStatus(null)
            if (before) toast('Progress cleared', 'info', { action: { label: 'Undo', onAction: () => restore(before) } })
          }}
        />

        <ConfirmDialog
          open={confirmDeaccession}
          title="Remove from library?"
          message={
            <>
              <strong className="text-foreground">{entry?.title || (source ? titleOf(source) : 'This title')}</strong> and its watch
              history, rating and logged episodes will be removed. You can undo this right afterwards.
            </>
          }
          confirmLabel="Remove"
          onCancel={() => setConfirmDeaccession(false)}
          onConfirm={() => {
            const name = entry?.title || (source ? titleOf(source) : 'Title')
            const removed = entry
            setConfirmDeaccession(false)
            remove(type, id)
            toast(`${name} removed from your library`, 'info', removed ? { action: { label: 'Undo', onAction: () => restore(removed) } } : undefined)
            onClose()
          }}
        />
      </div>
    </div>
  )
}

/* ---------- shared bits ---------- */

function Panel({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-border px-6 py-7">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <h2 className="font-display text-[26px] leading-none">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  )
}

function IconButton({
  children,
  label,
  tooltip,
  pressed,
  active,
  disabled = false,
  hasPopup = false,
  tone = 'default',
  onClick,
}: {
  children: React.ReactNode
  /** Stable accessible name ("Favourite", "Delete"). */
  label: string
  /** Visible hint; null hides it. Also read as the button's description. */
  tooltip?: string | null
  /** Toggle state for on/off buttons (announced as pressed). */
  pressed?: boolean
  /** Visual emphasis only. */
  active?: boolean
  /** Stays focusable so keyboard users can still hear why it is unavailable. */
  disabled?: boolean
  hasPopup?: boolean
  tone?: 'default' | 'danger'
  onClick: () => void
}) {
  const tip = tooltip === null ? null : tooltip ?? label
  const hoverTip = useTimedTooltip()
  const tipId = useId()
  const highlighted = pressed ?? active

  return (
    <div className="relative" onMouseEnter={hoverTip.show} onMouseLeave={hoverTip.hide}>
      <button
        type="button"
        onClick={() => {
          if (disabled) return
          hoverTip.hide()
          onClick()
        }}
        onFocus={hoverTip.show}
        onBlur={hoverTip.hide}
        aria-label={label}
        aria-pressed={pressed}
        aria-haspopup={hasPopup ? 'dialog' : undefined}
        aria-disabled={disabled || undefined}
        aria-describedby={tip && tip !== label ? tipId : undefined}
        className={`relative flex h-9 w-9 items-center justify-center border transition-colors ${
          disabled
            ? 'cursor-not-allowed border-border text-muted-foreground opacity-50'
            : `press ${
                tone === 'danger'
                  ? 'border-[var(--destructive)]/40 bg-[var(--destructive)]/[0.06] text-[var(--destructive)] hover:border-[var(--destructive)] hover:bg-[var(--destructive)] hover:text-[var(--destructive-foreground)]'
                  : highlighted
                    ? 'border-[var(--primary)] text-[var(--primary)]'
                    : 'border-border text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground'
              }`
        }`}
      >
        {children}
      </button>
      {tip && (
        <span
          id={tipId}
          role="tooltip"
          className={`pointer-events-none absolute -top-8 left-1/2 z-30 -translate-x-1/2 select-none whitespace-nowrap border border-border bg-foreground px-2 py-0.5 font-sans text-[10px] font-medium tracking-[0.04em] text-background shadow-xs transition-opacity duration-150 ${hoverTip.visible ? 'opacity-100' : 'opacity-0'}`}
        >
          {tip}
        </span>
      )}
    </div>
  )
}

/* ---------- icons ---------- */

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  )
}

function HeartIcon({ filled }: { filled?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78Z" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </svg>
  )
}

function formatRuntime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}M`
  if (m === 0) return `${h}H`
  return `${h}H ${m}M`
}

/** yyyy-mm-dd (TMDb) → DD/MM/YYYY for ledger microcopy. */
function formatEpisodeDate(raw: string | null): string {
  if (!raw) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  if (!m) return raw
  return `${m[3]}/${m[2]}/${m[1]}`
}

/** yyyy-mm-dd → "09 JUL 2025" to match the mono meta row. Null when unparseable. */
function formatReleaseDate(raw: string | undefined): string | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return null
  const d = new Date(`${raw.slice(0, 10)}T12:00:00`)
  if (isNaN(d.getTime())) return null
  return d
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    .replace(/,/g, '')
    .toUpperCase()
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

function RewatchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  )
}

/** Horizontally scrolling cast reel with snap controls in panel header. */
function CastCarousel({
  cast,
  trackRef,
  onSelect,
}: {
  cast: { id: number; name: string; character: string; profile_path: string | null }[]
  trackRef?: React.RefObject<HTMLDivElement | null>
  onSelect?: (personId: number) => void
}) {
  const localTrack = useRef<HTMLDivElement>(null)
  const track = trackRef ?? localTrack

  if (cast.length === 0) {
    return (
      <div className="animate-fade border border-dashed border-border px-6 py-12 text-center font-sans text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
        No cast on file
      </div>
    )
  }

  return (
    <div className="relative">
      <div ref={track} className="quiet-scroll -mx-1 flex snap-x gap-4 overflow-x-auto px-1 pb-2">
        {cast.map((c, i) => (
          <div
            key={`${c.id}-${i}`}
            className="animate-plate w-[150px] shrink-0 snap-start"
            style={{ animationDelay: `${Math.min(i, 12) * 32}ms` }}
          >
            <button
              type="button"
              onClick={() => onSelect?.(c.id)}
              aria-label={`Open ${c.name}`}
              className="press group block w-full text-left"
            >
              <span className="block aspect-[2/3] w-full overflow-hidden border border-border bg-muted transition-colors hover:border-[var(--foreground)]">
                {img(c.profile_path, 'w185') ? (
                  <img
                    src={img(c.profile_path, 'w185')!}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width={185}
                    height={278}
                    className="h-full w-full origin-center object-cover grayscale transition-[filter,scale] duration-500 ease-out group-hover:scale-[1.04] group-hover:grayscale-0 group-focus-visible:scale-[1.04] group-focus-visible:grayscale-0 motion-reduce:transition-none"
                  />
                ) : (
                  <span className="flex h-full items-center justify-center font-display text-[34px] text-muted-foreground">
                    {c.name.slice(0, 1)}
                  </span>
                )}
              </span>
              <span className="mt-2 block">
                <span className="block truncate font-display text-[16px] leading-tight">{c.name}</span>
                {c.character && (
                  <span className="mt-0.5 block truncate text-[12px] leading-tight text-muted-foreground">
                    {c.character}
                  </span>
                )}
              </span>
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function StatusModal({
  title,
  status,
  mediaType,
  watchedEpisodeCount,
  rewatching,
  rewatchProgress,
  onSelect,
  onToggleRewatch,
  onClose,
}: {
  title: string
  status: Status
  mediaType: MediaType
  watchedEpisodeCount: number
  rewatching: boolean
  rewatchProgress: number
  onSelect: (s: Status) => void
  onToggleRewatch: (active: boolean) => void
  onClose: () => void
}) {
  const [shown, setShown] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)
  useFocusTrap(boxRef)
  const closeTimer = useRef<number | null>(null)
  const options = statusOptionsFor(mediaType, status, watchedEpisodeCount)
  // Stable identity: onClose is an inline prop that changes every parent
  // render — depending on it would re-run the mount effect on every commit,
  // whose cleanup kills the dismiss timer (modal never closes on Save).
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const close = useCallback(() => {
setShown(false)
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => onCloseRef.current(), 200) // matches the exit transition duration
  }, [])

  useEffect(() => {
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShown(true))
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [close])

  // A pending close belongs to its timer: only unmount may cancel it, never
  // a re-render, or Save-style commits would wedge the modal open.
  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    },
    [],
  )

  const content = (
    <div
      className={`modal-backdrop fixed inset-0 z-[60] flex items-center justify-center bg-[var(--scrim)] p-4 ${shown ? '' : 'pointer-events-none'}`}
      data-open={shown}
      onClick={close}
      onWheel={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Status — ${title}`}
        style={{ width: '100%', maxWidth: '320px' }}
        className="modal-sheet border border-border bg-background shadow-[var(--shadow-sheet)]"
        data-open={shown}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-4.5 py-3">
          <div className="min-w-0 pr-2">
            <span className="rule-label block text-[var(--primary)] text-[10px]">Status</span>
            <span className="mt-0.5 block truncate font-display text-[18px] leading-tight">{title}</span>
          </div>
          <CloseButton onClick={close} label="Close status options" />
        </header>

        <div className="space-y-2.5 p-3.5">
          {options.map((s) => {
            const active = status === s
            return (
              <button
                key={s}
                type="button"
                onClick={() => {
                  onSelect(s)
                  close()
                }}
                className={`press flex h-9 w-full items-center justify-between border px-3 font-sans text-[11px] font-medium uppercase tracking-[0.14em] transition-all ${
                  active ? `${STATUS_STYLE[s]} shadow-xs` : STATUS_INACTIVE[s]
                }`}
                aria-pressed={active}
              >
                <span>{s}</span>
                {active && (
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </button>
            )
          })}
          {mediaType === 'tv' && status === 'watched' && (
            <div className="border-t border-border pt-2.5">
              <button
                type="button"
                aria-label={`Rewatching: ${rewatching ? 'pause' : rewatchProgress ? 'resume' : 'start'} rewatch`}
                aria-pressed={rewatching}
                onClick={() => {
                  onToggleRewatch(!rewatching)
                  close()
                }}
                className={`press flex h-9 w-full items-center justify-between border px-3 text-left font-sans text-[11px] font-medium uppercase tracking-[0.14em] transition-all ${
                  rewatching
                    ? 'border-[var(--primary)] bg-[var(--primary)]/[0.08] text-[var(--primary)] shadow-xs'
                    : 'border-border text-muted-foreground hover:border-[var(--primary)] hover:text-[var(--primary)]'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <RewatchIcon />
                  Rewatching
                </span>
                {rewatching && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  return createPortal(content, document.body)
}

function StatusButtons({
  title,
  status,
  mediaType,
  watchedEpisodeCount,
  rewatching,
  rewatchProgress,
  onChange,
  onToggleRewatch,
}: {
  title: string
  status: Status
  mediaType: MediaType
  watchedEpisodeCount: number
  rewatching: boolean
  rewatchProgress: number
  onChange: (s: Status) => void
  onToggleRewatch: (active: boolean) => void
}) {
  const [modalOpen, setModalOpen] = useState(false)
  const badge = STATUS_BADGE[status] ?? STATUS_BADGE.planned
  const badgeStyle = STATUS_STYLE[status] ?? STATUS_STYLE.planned
  const hintTip = useTimedTooltip()

  return (
    <>
      <div
        className="relative"
        onMouseEnter={hintTip.show}
        onMouseLeave={hintTip.hide}
        onFocus={hintTip.show}
        onBlur={hintTip.hide}
      >
        <button
          type="button"
          onClick={() => {
            // Keep focus on the trigger: the status dialog returns it here on close.
            hintTip.hide()
            setModalOpen(true)
          }}
          aria-haspopup="dialog"
          aria-expanded={modalOpen}
          aria-label={`Status: ${badge?.label ?? status}${rewatching ? ', rewatching' : ''}. Change status`}
          className={`press flex h-8 w-[108px] shrink-0 items-center justify-center px-3 font-sans text-[11px] font-medium uppercase tracking-[0.14em] shadow-xs transition-opacity hover:opacity-90 ${badgeStyle}`}
        >
          <span>{badge?.label ?? status}</span>
        </button>
        <span className={`pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap border border-border bg-foreground px-2 py-0.5 font-sans text-[10px] font-medium tracking-[0.04em] text-background transition-opacity duration-150 z-30 shadow-xs select-none ${hintTip.visible ? 'opacity-100' : 'opacity-0'}`}>
          Change status
        </span>
      </div>
      {rewatching && <span className="rule-label flex items-center gap-1 text-[9px] text-[var(--primary)]"><RewatchIcon /> Rewatching</span>}

      {modalOpen && (
        <StatusModal
          title={title}
          status={status}
          mediaType={mediaType}
          watchedEpisodeCount={watchedEpisodeCount}
          rewatching={rewatching}
          rewatchProgress={rewatchProgress}
          onToggleRewatch={onToggleRewatch}
          onSelect={(s) => {
            onChange(s)
          }}
          onClose={() => setModalOpen(false)}
        />
      )}
    </>
  )
}

/* ---------- edit panel ---------- */

function EditModal({
  title,
  type,
  entry,
  source,
  seasons,
  onClose,
  onUpsert,
}: {
  title: string
  type: MediaType
  entry: Entry
  source?: TmdbTitle | null
  seasons?: SeasonSummary[]
  onClose: () => void
  onUpsert: (patch: Partial<Entry>) => void
}) {
  const [shown, setShown] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [confirmResetProgress, setConfirmResetProgress] = useState(false)
  const boxRef = useRef<HTMLFormElement | null>(null)
  const posterFileRef = useRef<HTMLInputElement | null>(null)
  const posterTaskRef = useRef(0)
  useFocusTrap(boxRef, !confirmDiscard && !confirmResetProgress)
  const closeTimer = useRef<number | null>(null)
  const { toast } = useToast()
  const prefillToday = true
  // See StatusModal: keep close identity stable across parent re-renders.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Draft-only editing — nothing commits until Save. Edits are measured
  // against the record as it was when the editor opened: a background update
  // (e.g. runtime filled in from TMDb) is neither "unsaved" nor overwritten.
  const [initial] = useState(entry)
  const [draftRating, setDraftRating] = useState(entry.rating)
  const [draftFavorite, setDraftFavorite] = useState(entry.favorite)
  const [draftWatchedAt, setDraftWatchedAt] = useState(entry.watchedAt)
  const [draftStatus, setDraftStatus] = useState(entry.status)
  const [draftRewatching, setDraftRewatching] = useState(entry.rewatching)
  const statusOptions = statusOptionsFor(type, entry.status, watchedCount(entry))
  const [customTitle, setCustomTitle] = useState(entry.title ?? '')
  const [customYear, setCustomYear] = useState(entry.year ?? '')
  const [customRuntime, setCustomRuntime] = useState(entry.runtime != null ? String(entry.runtime) : '')
  const [customEpisodes, setCustomEpisodes] = useState(entry.totalEpisodes != null ? String(entry.totalEpisodes) : '')
  const defaultPosterPath = source?.poster_path ?? entry.poster ?? null
  const [customPosterPath, setCustomPosterPath] = useState(entry.poster ?? '')
  const [customPosterImage, setCustomPosterImage] = useState(entry.customPoster ?? null)
  const [posterProcessing, setPosterProcessing] = useState(false)
  const [posterError, setPosterError] = useState<string | null>(null)
  const [customNote, setCustomNote] = useState(entry.note ?? '')

  useEffect(() => () => { posterTaskRef.current++ }, [])

  const selectPoster = async (file: File | undefined) => {
    if (!file) return
    const task = ++posterTaskRef.current
    setPosterProcessing(true)
    setPosterError(null)
    try {
      const image = await prepareCustomPoster(file)
      if (task === posterTaskRef.current) setCustomPosterImage(image)
    } catch (error) {
      if (task === posterTaskRef.current) {
        setPosterError(error instanceof Error ? error.message : 'The poster could not be prepared. Try another image.')
      }
    } finally {
      if (task === posterTaskRef.current) setPosterProcessing(false)
    }
  }

  const resetPoster = () => {
    posterTaskRef.current++
    setPosterProcessing(false)
    setCustomPosterImage(null)
    setCustomPosterPath(defaultPosterPath ?? '')
    setPosterError(null)
    if (posterFileRef.current) posterFileRef.current.value = ''
  }

  const dismiss = useCallback(() => {
    setShown(false)
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => onCloseRef.current(), 260) // matches the exit transition duration
  }, [])

  const isDirty =
    posterProcessing ||
    draftRating !== initial.rating ||
    draftFavorite !== initial.favorite ||
    draftWatchedAt !== initial.watchedAt ||
    draftStatus !== initial.status ||
    draftRewatching !== initial.rewatching ||
    customTitle.trim() !== (initial.title ?? '') ||
    customYear.trim() !== (initial.year ?? '') ||
    (type === 'movie'
      ? customRuntime.trim() !== (initial.runtime != null ? String(initial.runtime) : '')
      : customEpisodes.trim() !== (initial.totalEpisodes != null ? String(initial.totalEpisodes) : '')) ||
    customPosterPath.trim() !== (initial.poster ?? '') ||
    customPosterImage !== (initial.customPoster ?? null) ||
    customNote.trim() !== (initial.note ?? '')

  /** X / backdrop / Escape: discard, but confirm first when dirty. */
  const dirtyRef = useRef(false)
  dirtyRef.current = isDirty
  const requestDismiss = useCallback(() => {
    if (dirtyRef.current) setConfirmDiscard(true)
    else dismiss()
  }, [dismiss])

  const save = useCallback((confirmedReset = false) => {
    if (posterProcessing) return
    if (draftStatus === 'watched' && draftWatchedAt == null) {
      toast('Watch date required', 'error')
      return
    }
    const patch: Partial<Entry> = {}
    if (draftRating !== initial.rating) patch.rating = draftRating
    if (draftFavorite !== initial.favorite) patch.favorite = draftFavorite
    const priorCompletion = draftWatchedAt !== entry.watchedAt
      ? draftWatchedAt
      : entry.status === 'watched'
        ? originalCompletionAt(entry)
        : draftWatchedAt
    const transition = statusTransition(entry.status, draftStatus, priorCompletion)
    if (!confirmedReset && type === 'tv' && transition.clearEpisodes && (watchedCount(entry) > 0 || Object.keys(entry.rewatchEpisodes).length > 0)) {
      setConfirmResetProgress(true)
      return
    }
    if (draftStatus !== entry.status) {
      patch.status = transition.status
      if (transition.watchedAt !== entry.watchedAt) patch.watchedAt = transition.watchedAt
    } else if (draftWatchedAt !== entry.watchedAt) {
      patch.watchedAt = draftWatchedAt
    }
    if (type === 'tv' && (draftRewatching !== entry.rewatching || draftStatus !== entry.status)) {
      patch.rewatching = entry.status === 'watched' && draftStatus === 'watched' && draftRewatching
    }
    const t = customTitle.trim()
    if (t && t !== initial.title) patch.title = t
    if (customYear.trim() !== initial.year) patch.year = customYear.trim()
    if (type === 'movie') {
      const r = customRuntime.trim() ? parseInt(customRuntime.trim(), 10) : null
      if (r !== null && Number.isFinite(r) && r !== initial.runtime) patch.runtime = r
      else if (customRuntime.trim() === '' && initial.runtime !== null) patch.runtime = null
    } else {
      const ep = customEpisodes.trim() ? parseInt(customEpisodes.trim(), 10) : null
      if (ep !== null && Number.isFinite(ep) && ep !== initial.totalEpisodes) patch.totalEpisodes = ep
      else if (customEpisodes.trim() === '' && initial.totalEpisodes !== null) patch.totalEpisodes = null
    }
    const p = customPosterPath.trim()
    if (p !== (initial.poster ?? '')) patch.poster = p || null
    if (customPosterImage !== (initial.customPoster ?? null)) patch.customPoster = customPosterImage
    const n = customNote.trim()
    if (n !== (initial.note ?? '')) patch.note = n || undefined
    // Mirror the status picker's episode side-effects for shows: marking
    // watched fills every real season, while moving to Planned clears progress
    // except when resuming from Dropped, which preserves the viewing history.
    if (type === 'tv' && draftStatus !== entry.status) {
      if (draftStatus === 'watched' && seasons) {
        const at = draftWatchedAt ?? Date.now()
        patch.episodes = markAllEpisodes(seasons, at, entry.episodes)
      } else if (transition.clearEpisodes) {
        patch.episodes = {}
        patch.rewatching = false
        patch.rewatchEpisodes = {}
      }
    }

    if (Object.keys(patch).length > 0) {
      onUpsert(patch)
      toast('Changes saved', 'success')
    }
    dismiss()
  }, [
    dismiss,
    draftRating,
    draftFavorite,
    draftWatchedAt,
    draftStatus,
    draftRewatching,
    customTitle,
    customYear,
    customRuntime,
    customEpisodes,
    customPosterPath,
    customPosterImage,
    posterProcessing,
    customNote,
    entry,
    initial,
    seasons,
    onUpsert,
    toast,
    type,
  ])

  const close = requestDismiss

  // While one of this modal's own confirm dialogs is open, Escape belongs to
  // that dialog alone: the window-level listeners fire in registration order,
  // so without this guard one keystroke would also dismiss the editor (or
  // open the discard prompt) underneath the confirm.
  const confirmOpenRef = useRef(false)
  confirmOpenRef.current = confirmDiscard || confirmResetProgress

  const resetToTmdb = () => {
    if (!source) return
    const defTitle = titleOf(source)
    const defYear = yearOf(source)
    const detail = source as Detail
    const defRuntime = type === 'movie' ? (detail.runtime ?? null) : null
    const defEpisodes = type === 'tv' ? (detail.number_of_episodes ?? null) : null
    const defPoster = source.poster_path ?? null

    posterTaskRef.current++
    setPosterProcessing(false)
    setCustomTitle(defTitle)
    setCustomYear(defYear)
    setCustomRuntime(defRuntime != null ? String(defRuntime) : '')
    setCustomEpisodes(defEpisodes != null ? String(defEpisodes) : '')
    setCustomPosterPath(defPoster ?? '')
    setCustomPosterImage(null)
    setPosterError(null)
  }

  useEffect(() => {
    // Double rAF so the browser paints the initial (hidden) state before the
    // class flips — without this the enter transition frequently doesn't fire.
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShown(true))
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (!confirmOpenRef.current) close()
      }
    }
    // Capture so Escape closes the modal before the drawer's own handler runs.
    window.addEventListener('keydown', onKey, true)
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [close])

  // See StatusModal: only unmount may cancel a pending close timer.
  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    },
    [],
  )

  return createPortal((
    <div
      className={`modal-backdrop fixed inset-0 z-[60] flex items-center justify-center bg-[var(--scrim)] p-3 sm:p-4 ${shown ? '' : 'pointer-events-none'}`}
      data-open={shown}
      onClick={close}
    >
      <form
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Edit metadata — ${title}`}
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
        className="modal-sheet flex h-[min(82vh,520px)] w-full max-w-[420px] flex-col border border-border bg-background shadow-[var(--shadow-sheet)]"
        data-open={shown}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4.5 py-3">
          <div className="min-w-0 pr-2">
            <span className="rule-label block text-[var(--primary)] text-[10px]">Edit metadata</span>
            <span className="mt-0.5 block truncate font-display text-[18px] leading-tight">{customTitle || title}</span>
          </div>
          <CloseButton onClick={close} label="Close editor" />
        </header>

        <div className="quiet-scroll min-h-0 flex-1 space-y-4 overflow-y-auto px-4.5 py-3.5">
          <Field label={`Your rating${draftRating ? ` · ${draftRating}/10` : ' · Unrated'}`}>
            <div className="flex gap-1" role="radiogroup" aria-label="Your rating" onKeyDown={handleRadioGroupKeyDown}>
              <button
                type="button"
                role="radio"
                aria-checked={draftRating === null}
                tabIndex={draftRating === null ? 0 : -1}
                onClick={() => setDraftRating(null)}
                aria-label="Set as unrated"
                title="Set as unrated"
                className={`group relative press aspect-square flex-1 border font-sans text-[11px] font-medium transition-colors ${
                  draftRating === null
                    ? 'border-[var(--foreground)] bg-foreground text-background'
                    : 'border-border text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground'
                }`}
              >
                —
                <span className="pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap border border-border bg-foreground px-2 py-0.5 font-sans text-[10px] font-medium tracking-[0.04em] text-background opacity-0 transition-opacity duration-150 group-hover:opacity-100 z-30 shadow-xs select-none">
                  Unrated
                </span>
              </button>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={draftRating === n}
                  tabIndex={draftRating === n ? 0 : -1}
                  onClick={() => setDraftRating(n)}
                  aria-label={`Rate ${n}`}
                  className={`press aspect-square flex-1 border font-sans text-[11px] font-medium tabular-nums ${
                    draftRating && n <= draftRating
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-accent-foreground'
                      : 'border-border text-muted-foreground hover:border-[var(--foreground)]'
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Status">
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Title status" onKeyDown={handleRadioGroupKeyDown}>
              {statusOptions.map((status) => {
                const active = draftStatus === status
                return (
                  <button
                    key={status}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    tabIndex={active ? 0 : -1}
                    onClick={() => {
                      setDraftStatus(status)
                      if (status !== 'watched') setDraftRewatching(false)
                    }}
                    className={`press flex h-8 min-w-[92px] flex-1 items-center justify-center gap-2 border px-2 font-sans text-[10px] font-medium uppercase tracking-[0.12em] ${
                      active ? STATUS_STYLE[status] : STATUS_INACTIVE[status]
                    }`}
                  >
                    <span className="flex h-3.5 w-3.5 items-center justify-center">{STATUS_BADGE[status].icon}</span>
                    {STATUS_BADGE[status].label}
                  </button>
                )
              })}
            </div>
          </Field>

          {type === 'tv' && entry.status === 'watched' && draftStatus === 'watched' && (
            <Field label="Rewatching">
              <button
                type="button"
                aria-pressed={draftRewatching}
                onClick={() => setDraftRewatching((active) => !active)}
                className={`press flex w-full items-center justify-between border px-3 py-2 text-left ${
                  draftRewatching
                    ? 'border-[var(--primary)] bg-[var(--primary)]/[0.08] text-[var(--primary)]'
                    : 'border-border hover:border-[var(--primary)]'
                }`}
              >
                <span>
                  <span className="block font-sans text-[10px] font-medium uppercase tracking-[0.12em]">
                    {draftRewatching ? 'Pause rewatch' : Object.keys(entry.rewatchEpisodes).length ? 'Resume rewatch' : 'Start rewatch'}
                  </span>
                  <span className="mt-0.5 block font-sans text-[11px] text-muted-foreground">
                    {Object.keys(entry.rewatchEpisodes).length} of {entry.totalEpisodes ?? '?'} episodes saved separately
                  </span>
                </span>
                <RewatchIcon />
              </button>
            </Field>
          )}

          <div className="space-y-3">
            <Field label="Favourite">
              <button
                type="button"
                onClick={() => setDraftFavorite(!draftFavorite)}
                aria-pressed={draftFavorite}
                className={`press flex h-8 w-full items-center justify-center gap-1.5 border px-2.5 font-sans text-[10px] font-medium uppercase tracking-[0.12em] ${
                  draftFavorite
                    ? 'border-[var(--primary)] text-[var(--primary)]'
                    : 'border-border text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground'
                }`}
              >
                <HeartIcon filled={draftFavorite} />
                <span>{draftFavorite ? 'Favourited' : 'Favourite'}</span>
              </button>
            </Field>

            <Field label="Date watched">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (draftWatchedAt != null || draftStatus === 'watched') {
                      setDraftWatchedAt(null)
                      if (draftStatus !== 'dropped') setDraftStatus('planned')
                    } else {
                      setDraftWatchedAt(prefillToday ? Date.now() : null)
                      setDraftStatus('watched')
                    }
                  }}
                  className={`press flex h-8 shrink-0 items-center gap-1.5 border px-3 font-sans text-[10px] font-medium uppercase tracking-[0.12em] ${
                    draftWatchedAt != null || draftStatus === 'watched'
                      ? 'border-[var(--primary)] text-[var(--primary)]'
                      : 'border-border text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground'
                  }`}
                >
                  {draftWatchedAt != null || draftStatus === 'watched' ? <CheckIcon /> : null}
                  <span>{draftWatchedAt != null || draftStatus === 'watched' ? 'Watched' : 'Mark watched'}</span>
                </button>
                {(draftWatchedAt != null || draftStatus === 'watched') && (
                  <input
                    type="date"
                    aria-label="Date watched"
                    max={todayInput()}
                    value={draftWatchedAt != null ? toDateInput(draftWatchedAt) : ''}
                    onChange={(ev) => {
                      if (!ev.target.value) return
                      const at = fromDateInput(ev.target.value)
                      if (at == null) return
                      setDraftWatchedAt(at)
                      // Recording a watch date means watched.
                      if (draftStatus !== 'watched') setDraftStatus('watched')
                    }}
                    className="h-8 flex-1 border border-border bg-background px-2 font-sans text-[11px] outline-none focus:border-[var(--primary)]"
                  />
                )}
                {draftStatus === 'watched' && draftWatchedAt == null && (
                  <button
                    type="button"
                    onClick={() => setDraftWatchedAt(Date.now())}
                    className="press flex h-8 shrink-0 items-center border border-border px-3 font-sans text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground"
                  >
                    Today
                  </button>
                )}
              </div>
            </Field>
          </div>

          <div className="border-t border-border pt-3.5">
            <div className="mb-3 flex items-center justify-between">
              <span className="rule-label text-[var(--primary)] text-[10px]">Title & Metadata</span>
              {source && (
                <button
                  type="button"
                  onClick={resetToTmdb}
                  className="press font-sans text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-[var(--primary)]"
                >
                  Reset to TMDb
                </button>
              )}
            </div>

            <div className="space-y-3">
              <Field label="Title">
                <input
                  type="text"
                  aria-label="Title"
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="Title"
                  className="h-8 w-full border border-border bg-background px-2.5 font-sans text-[11px] text-foreground outline-none transition-colors focus:border-[var(--primary)]"
                />
              </Field>

              <div className="grid grid-cols-2 gap-2.5">
                <Field label="Release year">
                  <input
                    type="text"
                    aria-label="Release year"
                    inputMode="numeric"
                    pattern="[0-9]{4}"
                    value={customYear}
                    onChange={(e) => setCustomYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
                    placeholder="YYYY"
                    maxLength={4}
                    className="h-8 w-full border border-border bg-background px-2.5 font-sans text-[11px] text-foreground outline-none transition-colors focus:border-[var(--primary)]"
                  />
                </Field>

                <Field label={type === 'movie' ? 'Runtime (minutes)' : 'Total episodes'}>
                  {type === 'movie' ? (
                    <input
                      type="number"
                      aria-label="Runtime in minutes"
                      min="0"
                      value={customRuntime}
                      onChange={(e) => setCustomRuntime(e.target.value)}
                      placeholder="e.g. 150"
                      className="h-8 w-full border border-border bg-background px-2.5 font-sans text-[11px] text-foreground outline-none transition-colors focus:border-[var(--primary)]"
                    />
                  ) : (
                    <input
                      type="number"
                      aria-label="Total episodes"
                      min="0"
                      value={customEpisodes}
                      onChange={(e) => setCustomEpisodes(e.target.value)}
                      placeholder="e.g. 10"
className="h-8 w-full border border-border bg-background px-2.5 font-sans text-[11px] text-foreground outline-none transition-colors focus:border-[var(--primary)]"
                    />
                  )}
                </Field>

              <Field label="Custom poster">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => posterFileRef.current?.click()}
                    disabled={posterProcessing}
                    className="press h-8 border border-border bg-card px-3 font-sans text-[10px] font-medium uppercase tracking-[0.12em] text-foreground transition-colors hover:border-[var(--foreground)] disabled:cursor-wait disabled:opacity-50"
                  >
                    {posterProcessing ? 'Preparing…' : 'Upload Image'}
                  </button>
                  <button
                    type="button"
                    onClick={resetPoster}
                    disabled={!posterProcessing && !customPosterImage && customPosterPath.trim() === (defaultPosterPath ?? '')}
                    className="press h-8 border border-border px-3 font-sans text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:border-[var(--foreground)] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Reset
                  </button>
                  <input
                    ref={posterFileRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    aria-label="Upload a custom poster image"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      event.currentTarget.value = ''
                      void selectPoster(file)
                    }}
                  />
                </div>
                <div className="mt-2.5 flex items-center gap-3">
                  {(customPosterImage ?? img(customPosterPath || defaultPosterPath, 'w185')) ? (
                    <img
                      src={customPosterImage ?? img(customPosterPath || defaultPosterPath, 'w185')!}
                      alt="Poster preview"
                      width={48}
                      height={72}
                      className="h-[72px] w-12 shrink-0 object-cover"
                    />
                  ) : (
                    <div className="flex h-[72px] w-12 shrink-0 items-center justify-center border border-border bg-card font-sans text-[8px] uppercase tracking-[0.1em] text-muted-foreground">No poster</div>
                  )}
                  <p className="max-w-[34ch] font-sans text-[10px] leading-relaxed text-muted-foreground">
                    JPEG, PNG, or WebP · up to {MAX_CUSTOM_POSTER_FILE_BYTES / 1024 / 1024} MB. Saved posters are resized for the library.
                  </p>
                </div>
                {posterProcessing && <p className="mt-2 font-sans text-[10px] text-muted-foreground" aria-live="polite">Preparing poster…</p>}
                {posterError && <p className="mt-2 font-sans text-[10px] text-[var(--destructive)]" role="alert">{posterError}</p>}
              </Field>

              <Field label="TMDb poster path">
                <input
                  type="text"
                  aria-label="TMDb poster path"
                  value={customPosterPath}
                  onChange={(e) => setCustomPosterPath(e.target.value)}
                  placeholder="/path.jpg (TMDb image path)"
                  className="h-8 w-full border border-border bg-background px-2.5 font-sans text-[11px] text-foreground outline-none transition-colors focus:border-[var(--primary)]"
                />
              </Field>

              <Field label="Personal notes / review">
                <textarea
                  rows={2}
                  aria-label="Personal notes or review"
                  value={customNote}
                  onChange={(e) => setCustomNote(e.target.value)}
                  placeholder="Screening thoughts, personal review, or context..."
                  className="w-full resize-none border border-border bg-background p-2.5 font-sans text-[11px] text-foreground outline-none transition-colors focus:border-[var(--primary)]"
                />
              </Field>
            </div>
          </div>
        </div>
        </div>

        <footer className="flex shrink-0 items-center justify-end border-t border-border px-4.5 py-3">
          <button
            type="submit"
            title="Save (Enter)"
            disabled={posterProcessing}
            className="press inline-flex h-8 items-center gap-2 bg-[var(--primary)] px-4 font-sans text-[10px] font-medium uppercase tracking-[0.14em] text-primary-foreground hover:opacity-85 disabled:cursor-wait disabled:opacity-50"
          >
            <span>Save</span>
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="shrink-0"
            >
              <polyline points="9 10 4 15 9 20" />
              <path d="M20 4v7a4 4 0 0 1-4 4H4" />
            </svg>
          </button>
        </footer>
      </form>

      <ConfirmDialog
        open={confirmResetProgress}
        title="Start Over"
        message={<>Setting <strong className="text-foreground">{customTitle || title}</strong> to Planned will clear original and rewatch episode progress. This cannot be undone.</>}
        confirmLabel="Clear episodes"
        onCancel={() => setConfirmResetProgress(false)}
        onConfirm={() => {
          setConfirmResetProgress(false)
          save(true)
        }}
      />

      <ConfirmDialog
        open={confirmDiscard}
        title="Discard Changes"
        message="You have unsaved edits. Close without saving them?"
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        tone="neutral"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false)
          dismiss()
        }}
      />
    </div>
  ), document.body)
}

/* ---------- rewatch log ---------- */

function RewatchModal({
  title,
  entry,
  onClose,
  onAddRewatch,
  onSetRewatchDate,
  onRemoveRewatch,
}: {
  title: string
  entry: Entry
  onClose: () => void
  onAddRewatch: (at: number) => void
  onSetRewatchDate: (index: number, at: number) => void
  onRemoveRewatch: (index: number) => void
}) {
  const [rewatchDate, setRewatchDate] = useState(todayInput())
  const [shown, setShown] = useState(false)
  const [confirmIndex, setConfirmIndex] = useState<number | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  useFocusTrap(boxRef)
  const closeTimer = useRef<number | null>(null)
  const { toast } = useToast()
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Subscribe directly: the list must reflect every commit even if a parent
  // re-render were ever swallowed, so never rely solely on the entry prop.
  const { get } = useLibrary()
  const live = get(entry.mediaType, entry.id) ?? entry
  const canManuallyLog = canLogRewatch(live)
  const lockedReason = rewatchLockedReason(live)

  const close = useCallback(() => {
    setShown(false)
    if (closeTimer.current) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => onCloseRef.current(), 200) // matches the exit transition duration
  }, [])

  // Escape while the remove-rewatch confirm is open must cancel that confirm
  // only — the window-level handlers fire in registration order, so without
  // this guard the same keystroke would close the whole rewatch log too.
  const confirmOpenRef = useRef(false)
  confirmOpenRef.current = confirmIndex !== null

  useEffect(() => {
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShown(true))
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (!confirmOpenRef.current) close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [close])

  // See StatusModal: only unmount may cancel a pending close timer.
  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    },
    [],
  )

  return createPortal((
    <div
      className={`modal-backdrop fixed inset-0 z-[60] flex items-center justify-center bg-[var(--scrim)] p-3 sm:p-4 ${shown ? '' : 'pointer-events-none'}`}
      data-open={shown}
      onClick={close}
    >
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Rewatch log — ${title}`}
        className="modal-sheet flex h-[min(80vh,500px)] w-full max-w-[420px] flex-col border border-border bg-background shadow-[var(--shadow-sheet)]"
        data-open={shown}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4.5 py-3">
          <div className="min-w-0 pr-2">
            <span className="rule-label block text-[var(--primary)] text-[10px]">
              Rewatch log{live.rewatches.length ? ` · ${live.rewatches.length}` : ''}
            </span>
            <span className="mt-0.5 block truncate font-display text-[18px] leading-tight">{title}</span>
          </div>
          <CloseButton onClick={close} label="Close rewatch log" />
        </header>

        <div className="quiet-scroll min-h-0 flex-1 overflow-y-auto px-4.5 py-3.5">
          {live.rewatches?.length ? (
            <ul className="space-y-1.5">
              {live.rewatches.map((ts, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="rule-label w-6 text-[10px]">{String(i + 1).padStart(2, '0')}</span>
                  {/* Uncontrolled + commit on blur: saving (and re-sorting) on every
                      keystroke remounted the input mid-typing and dropped focus. */}
                  <input
                    key={ts}
                    type="date"
                    aria-label={`Rewatch ${i + 1} date`}
                    max={todayInput()}
                    defaultValue={toDateInput(ts)}
                    onBlur={(ev) => {
                      const at = fromDateInput(ev.target.value)
                      if (at == null) ev.target.value = toDateInput(ts)
                      else if (at !== ts) onSetRewatchDate(i, at)
                    }}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') ev.currentTarget.blur()
                    }}
                    className="h-8 flex-1 border border-[var(--input)] bg-background px-2 font-sans text-[13px] outline-none focus:border-[var(--foreground)]"
                  />
                  <button
                    type="button"
                    onClick={() => setConfirmIndex(i)}
                    aria-label={`Delete rewatch ${i + 1} on ${toDateInput(ts)}`}
                    className="press flex h-8 w-8 shrink-0 items-center justify-center border border-border text-muted-foreground hover:border-[var(--destructive)] hover:text-[var(--destructive)]"
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2.5 border border-dashed border-border py-8 text-center">
              <span className="text-muted-foreground">
                <RewatchIcon />
              </span>
              <p className="rule-label text-[10px]">No rewatches logged yet</p>
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-border px-4.5 py-3">
          {canManuallyLog ? (
            <>
              <input
                type="date"
                aria-label="Date of the new rewatch"
                max={todayInput()}
                value={rewatchDate}
                onChange={(e) => e.target.value && setRewatchDate(e.target.value)}
                className="h-8 flex-1 border border-[var(--input)] bg-background px-2 font-sans text-[13px] outline-none focus:border-[var(--foreground)]"
              />
              <button
                type="button"
                onClick={() => {
                  const at = fromDateInput(rewatchDate)
                  if (at == null) return
                  onAddRewatch(at)
                  toast('Rewatch logged', 'success')
                }}
                className="press h-8 bg-[var(--primary)] px-4 font-sans text-[10px] font-medium uppercase tracking-[0.14em] text-primary-foreground hover:opacity-85"
              >
                + Log rewatch
              </button>
            </>
          ) : (
            <p className="rule-label w-full text-center text-[10px] text-muted-foreground">{lockedReason}</p>
          )}
        </footer>

        <ConfirmDialog
          open={confirmIndex !== null}
          title="Remove Rewatch"
          message="Are you sure you want to delete this logged rewatch date from your archive?"
          confirmLabel="Remove"
          onCancel={() => setConfirmIndex(null)}
          onConfirm={() => {
            if (confirmIndex !== null) {
              onRemoveRewatch(confirmIndex)
              setConfirmIndex(null)
              toast('Rewatch removed', 'info')
            }
          }}
        />
      </div>
    </div>
  ), document.body)
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="rule-label mb-2">{label}</div>
      {children}
    </div>
  )
}

/* ---------- seasons ---------- */

function Seasons({
  showId,
  seasons,
  watched,
  tracked,
  completed,
  rewatching,
  continueFromProgress,
  panelSettled,
  onAdd,
  onToggle,
  onBulk,
}: {
  showId: number
  seasons: { id: number; season_number: number; name: string; episode_count: number; air_date: string | null }[]
  watched: Record<string, number>
  tracked: boolean
  completed: boolean
  rewatching: boolean
  continueFromProgress: boolean
  panelSettled: boolean
  onAdd: () => void
  onToggle: (s: number, e: number) => void
  onBulk: (s: number, nums: number[], watched: boolean) => void
}) {
  const { settings } = useSettings()
  const ordered = useMemo(
    () => [...seasons].sort((a, b) =>
      a.season_number === 0 ? 1 : b.season_number === 0 ? -1 : a.season_number - b.season_number,
    ).filter((season) => settings.showSpecials || season.season_number !== 0),
    [seasons, settings.showSpecials],
  )
  const lastMarkedEpisode = Object.entries(watched).reduce<{ season: number; episode: number; at: number } | null>((latest, [key, at]) => {
    const [seasonText, episodeText] = key.split('-')
    const season = Number(seasonText)
    const episode = Number(episodeText)
    if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode) || !Number.isFinite(at)) return latest
    return !latest || at >= latest.at ? { season, episode, at } : latest
  }, null)
  const lastMarkedSeason = lastMarkedEpisode?.season
  const lastMarkedKey = lastMarkedEpisode ? epKey(lastMarkedEpisode.season, lastMarkedEpisode.episode) : null
  const [open, setOpen] = useState<number>(
    continueFromProgress && lastMarkedSeason != null && ordered.some((s) => s.season_number === lastMarkedSeason)
      ? lastMarkedSeason
      : ordered[0]?.season_number ?? 1,
  )
  const [episodes, setEpisodes] = useState<Record<number, Episode[]>>({})
  const [loading, setLoading] = useState(false)
  const [seasonError, setSeasonError] = useState<string | null>(null)
  const [seasonAttempt, setSeasonAttempt] = useState(0)
  const [confirmClear, setConfirmClear] = useState<number | null>(null)
  const fetchedRef = useRef<Set<number>>(new Set())
  const didSelectProgressSeasonRef = useRef(false)
  const progressEpisodeRef = useRef<HTMLDivElement | null>(null)
  const didRestoreProgressRef = useRef(false)
  const hideDescriptions = settings.hideSpoilers
  const { toast } = useToast()

  // Reset fetched set when show changes
  useEffect(() => {
    fetchedRef.current.clear()
  }, [showId])

  const visibleOpen = ordered.some((s) => s.season_number === open)
    ? open
    : ordered[0]?.season_number ?? null
  const current = ordered.find((s) => s.season_number === visibleOpen) ?? ordered[0]

  useEffect(() => {
    if (!continueFromProgress) {
      didSelectProgressSeasonRef.current = false
      didRestoreProgressRef.current = false
      return
    }
    if (
      didSelectProgressSeasonRef.current ||
      lastMarkedSeason == null ||
      !ordered.some((s) => s.season_number === lastMarkedSeason)
    ) return
    didSelectProgressSeasonRef.current = true
    setOpen(lastMarkedSeason)
  }, [continueFromProgress, lastMarkedSeason, ordered])

  useEffect(() => {
    if (visibleOpen == null) {
      setLoading(false)
      return
    }
    if (fetchedRef.current.has(visibleOpen)) return
    const controller = new AbortController()
    let live = true
    setLoading(true)
    setSeasonError(null)
    fetchSeason(showId, visibleOpen, { signal: controller.signal })
      .then((s) => {
        if (live) {
          fetchedRef.current.add(visibleOpen)
          setEpisodes((prev) => ({ ...prev, [visibleOpen]: s.episodes }))
        }
      })
      .catch((e) => {
        if (live) {
          setSeasonError(e instanceof Error ? e.message : 'Failed to load episodes')
        }
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
      controller.abort()
    }
  }, [visibleOpen, showId, seasonAttempt])

  useEffect(() => {
    if (!continueFromProgress || !panelSettled || didRestoreProgressRef.current || !lastMarkedEpisode) return
    if (visibleOpen == null || visibleOpen !== lastMarkedEpisode.season) return
    const seasonEpisodes = episodes[lastMarkedEpisode.season]
    if (!seasonEpisodes?.some((episode) => episode.episode_number === lastMarkedEpisode.episode)) return

    const target = progressEpisodeRef.current
    if (!target) return
    const scrollArea = target.closest<HTMLElement>('.quiet-scroll')
    if (!scrollArea) return
    const targetRect = target.getBoundingClientRect()
    const scrollAreaRect = scrollArea.getBoundingClientRect()
    const top = scrollArea.scrollTop + targetRect.top - scrollAreaRect.top - (scrollArea.clientHeight - targetRect.height) / 2
    didRestoreProgressRef.current = true
    scrollArea.scrollTo({
      top,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    })
    // Keyed on the episode's coordinates, not the object rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [continueFromProgress, panelSettled, episodes, lastMarkedEpisode?.season, lastMarkedEpisode?.episode, visibleOpen])

  const seenIn = (s: { season_number: number; episode_count: number }) => {
    const eps = episodes[s.season_number]
    return eps
      ? eps.filter((e) => Object.prototype.hasOwnProperty.call(watched, epKey(s.season_number, e.episode_number))).length
      : Object.keys(watched).filter((k) => k.startsWith(`${s.season_number}-`)).length
  }

  return (
    <div>
      {!tracked && !completed && (
        <div className="mb-4">
          <button
            onClick={onAdd}
            className="press font-sans text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--primary)] underline underline-offset-4"
          >
            Add to library to track
          </button>
        </div>
      )}

      <div className="quiet-scroll -mx-1 mb-5 flex gap-2 overflow-x-auto px-1 pb-2">
        {ordered.map((s) => {
          const seen = seenIn(s)
          const active = s.season_number === visibleOpen
          return (
            <button
              key={s.id}
              onClick={() => {
                setOpen(s.season_number)
                setConfirmClear(null)
              }}
              aria-pressed={active}
              className={`press shrink-0 border px-3 py-2 text-left transition-colors ${
                active ? 'border-[var(--primary)] bg-card' : 'border-border hover:border-[var(--foreground)]'
              }`}
            >
              <span
                className={`block font-sans text-[11px] font-medium uppercase tracking-[0.14em] ${
                  active ? 'text-[var(--primary)]' : 'text-muted-foreground'
                }`}
              >
                {s.season_number === 0 ? 'Specials' : `Season ${s.season_number}`}
              </span>
              <span className="mt-1.5 block h-[2px] w-full bg-secondary">
                <span
                  className="block h-full bg-[var(--primary)] transition-[width] duration-500 ease-out"
                  style={{ width: `${s.episode_count ? Math.min(100, (seen / s.episode_count) * 100) : 0}%` }}
                />
              </span>
            </button>
          )
        })}
      </div>

      <div className="border border-border">
        {[current].filter(Boolean).map((s) => {
          const eps = episodes[s.season_number]
          const seen = seenIn(s)
          return (
            <div key={s.id} className="animate-fade">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card px-4 py-3">
<span className="flex flex-1 items-baseline gap-4">
                    <span className="font-sans text-[11px] tabular-nums text-[var(--accent)]">
                      {String(s.season_number).padStart(2, '0')}
                    </span>
                  <span className="font-sans font-medium text-[16px] tracking-tight">{s.name}</span>
                  <span className="rule-label">{(s.air_date ?? '').slice(0, 4)}</span>
                </span>
                <span className="font-sans text-[11px] tabular-nums text-muted-foreground">
                  <span className={seen >= s.episode_count ? 'font-medium text-[var(--primary)]' : 'text-foreground'}>
                    {seen}
                  </span>
                  /{s.episode_count}
                </span>
                <span className="hidden h-[3px] w-24 bg-secondary sm:block">
                  <span
                    className="block h-full bg-[var(--primary)] transition-[width] duration-500 ease-out"
                    style={{ width: `${s.episode_count ? Math.min(100, (seen / s.episode_count) * 100) : 0}%` }}
                  />
                </span>
                {tracked && (
                  <button
                    disabled={loading && !eps}
                    title={completed && !rewatching ? 'Start a rewatch to track new episode progress' : undefined}
                    onClick={() => {
                      const numbers =
                        eps?.map((e) => e.episode_number) ??
                        Array.from({ length: s.episode_count }, (_, i) => i + 1)
                      const complete = seen >= s.episode_count
                      if (!complete) {
                        onBulk(s.season_number, numbers, true)
                        toast(`S${s.season_number === 0 ? 'P' : s.season_number} completed`, 'success')
                        return
                      }
                      // Unmarking a whole season is destructive — confirm first.
                      if (confirmClear === s.season_number) {
                        onBulk(s.season_number, numbers, false)
                        setConfirmClear(null)
                        toast('Season cleared', 'info')
                      } else {
                        setConfirmClear(s.season_number)
                      }
                    }}
                    className={`press border px-2.5 py-1 font-sans text-[11px] font-medium uppercase tracking-[0.12em] disabled:cursor-wait disabled:opacity-50 ${
                      confirmClear === s.season_number
                        ? 'border-[var(--destructive)] bg-[var(--destructive)] text-[var(--destructive-foreground)]'
                        : seen >= s.episode_count
                          ? 'border-[var(--primary)] bg-[var(--primary)] text-primary-foreground'
                          : 'border-border hover:border-[var(--primary)] hover:text-[var(--primary)]'
                    }`}
                  >
                    {confirmClear === s.season_number
                      ? 'Select again to unmark'
                      : seen >= s.episode_count
                        ? rewatching ? '✓ Season rewatched' : '✓ Season watched'
                        : rewatching ? 'Mark season rewatched' : 'Mark season watched'}
                  </button>
                )}
              </div>

              <div>
                {loading && !eps && !seasonError && <p className="rule-label px-4 py-4">Loading episodes…</p>}
                {seasonError && !eps && (
                  <ErrorNotice
                    className="m-4"
                    title="Episodes couldn’t load"
                    message={seasonError}
                    onRetry={() => setSeasonAttempt((a) => a + 1)}
                  />
                )}
                {eps?.map((e) => {
                  const loggedAt = watched[epKey(s.season_number, e.episode_number)]
                  const done = loggedAt != null
                  const episodeLabel = `E${String(e.episode_number).padStart(2, '0')}`
                  const descriptionHidden = hideDescriptions
                  return (
                    <div
                      key={e.id}
                      ref={lastMarkedKey === epKey(s.season_number, e.episode_number) ? progressEpisodeRef : undefined}
                      className={`group/ep flex w-full items-center border-b border-border transition-colors duration-300 last:border-b-0 ${
                        done ? 'bg-secondary/40' : ''
                      }`}
                    >
                      <button
                        type="button"
                        aria-disabled={!tracked || undefined}
                        title={
                          !tracked
                            ? completed && !rewatching
                              ? 'Start a rewatch to track new episode progress'
                              : 'Add to library to track episodes'
                            : done
                              ? `Watched${loggedAt ? ` · ${new Date(loggedAt).toLocaleDateString()}` : ''} · select again to unmark`
                              : `Mark ${episodeLabel} watched`
                        }
                        // Name the episode itself; aria-pressed carries the watched state.
                        aria-label={`${s.season_number === 0 ? 'Special' : `Season ${s.season_number}`}, episode ${e.episode_number}: ${e.name}${
                          !tracked ? (completed && !rewatching ? ' (start a rewatch to track)' : ' (add to library to track)') : ''
                        }`}
                        aria-pressed={done}
                        onClick={() => {
                          if (tracked) onToggle(s.season_number, e.episode_number)
                        }}
                        className={`press flex min-w-0 flex-1 items-center gap-4 px-4 py-3 text-left transition-colors ${
                          tracked ? 'hover:bg-secondary/60' : 'cursor-default'
                        }`}
                      >
                        {!settings.hideEpisodeCovers && (
                          <span className="relative hidden aspect-video w-[124px] shrink-0 overflow-hidden border border-border bg-muted sm:block">
                            {img(e.still_path, 'w185') ? (
                              <img
                                src={img(e.still_path, 'w185')!}
                                alt={`Still from ${e.name}`}
                                loading="lazy"
                                decoding="async"
                                width={185}
                                height={104}
                                className={`h-full w-full object-cover transition-all duration-300 ${
                                  done ? 'opacity-60 saturate-[0.7]' : 'opacity-100'
                                }`}
                              />
                            ) : (
                              <span className="flex h-full items-center justify-center font-sans text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
                                No still
                              </span>
                            )}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block font-sans text-[15px] uppercase tracking-[0.08em] transition-colors sm:text-[16px] ${
                              done ? 'text-muted-foreground' : 'text-foreground'
                            }`}
                          >
                            {s.season_number === 0
                              ? `SP-${String(e.episode_number).padStart(2, '0')}`
                              : `EP-${String(e.episode_number).padStart(2, '0')}`}
                          </span>
                          <span
                            className={`mt-1 block text-[13px] leading-snug transition-colors ${
                              done ? 'text-muted-foreground line-through' : 'text-muted-foreground'
                            }`}
                          >
                            {e.name}
                          </span>
                          {e.overview && !descriptionHidden && (
                            <span className="mt-1 line-clamp-2 block text-[12px] leading-relaxed text-muted-foreground">
                              {e.overview}
                            </span>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center gap-4">
                          <span className="hidden text-right font-sans text-[10px] tabular-nums text-muted-foreground sm:block">
                            <span className="block">{formatEpisodeDate(e.air_date)}</span>
                            {e.runtime ? <span className="block">{e.runtime} min</span> : null}
                          </span>
                          <span
                            className={`relative inline-flex h-11 w-11 shrink-0 items-center justify-center border transition-all duration-200 ${
                              done
                                ? 'animate-stamp border-[var(--status-watched)] bg-[var(--status-watched)] text-[var(--status-watched-foreground)]'
                                : `border-border bg-card text-muted-foreground ${
                                    tracked
                                      ? 'group-hover/ep:border-[var(--primary)] group-hover/ep:bg-[var(--primary)]/[0.06] group-hover/ep:text-[var(--primary)]'
                                      : 'opacity-70'
                                  }`
                            }`}

                          >
                            {done ? (
                              <svg
                                width="20"
                                height="20"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="shrink-0"
                                aria-hidden
                              >
                                <path d="M4 12l5 5L20 6" className="animate-check-draw" />
                              </svg>
                            ) : tracked ? (
                              <svg
                                width="20"
                                height="20"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                aria-hidden
                                className="shrink-0"
                              >
                                <path d="M12 5v14M5 12h14" />
                              </svg>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <p className="rule-label mt-3">
        {Object.keys(watched).length} episodes logged {rewatching ? 'in this rewatch' : 'across this series'}
      </p>
    </div>
  )
}
