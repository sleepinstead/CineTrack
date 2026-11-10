import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { img, trending, type MediaType, type TmdbTitle } from '../lib/tmdb'
import { useLibrary } from '../lib/library'
import { monotoneSegments } from '../lib/curve'
import type { Page } from '../lib/route'
import { Poster, PosterSkeleton } from './ui'
import { ErrorNotice } from './Errors'
import { TiltedGridHero } from './TiltedGridHero'

const SOURCE_URL = 'https://github.com/halfbaked35/Cinetrack'

type Feed = { state: 'loading' } | { state: 'ready'; items: TmdbTitle[] } | { state: 'error'; message: string }

/** Trending titles with artwork: the "footage" the credits play over. */
function useTrending(attempt: number): Feed {
  const [feed, setFeed] = useState<Feed>({ state: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    let live = true
    setFeed({ state: 'loading' })
    trending('all', 'week', 1, { signal: controller.signal })
      .then((page) => {
        if (!live) return
        const items = page.results.filter((item) => item.poster_path && (item.media_type === 'movie' || item.media_type === 'tv'))
        setFeed({ state: 'ready', items })
      })
      .catch((error: unknown) => {
        if (live) setFeed({ state: 'error', message: error instanceof Error ? error.message : 'TMDb did not respond' })
      })
    return () => {
      live = false
      controller.abort()
    }
  }, [attempt])
  return feed
}

/**
 * The landing page, set as a film's opening titles: a main title card, three
 * credits that each prove one capability with a working fragment, and an
 * end-credit roll. Everything is drawn from the app's own tokens and parts.
 */
export default function Landing({
  onOpen,
  onNavigate,
}: {
  onOpen: (type: MediaType, id: number, seed?: TmdbTitle) => void
  onNavigate: (page: Page) => void
}) {
  const [attempt, setAttempt] = useState(0)
  const feed = useTrending(attempt)
  const footage = feed.state === 'ready' ? feed.items.slice(5, 20) : []
  const featured = feed.state === 'ready' ? feed.items.slice(0, 5) : []

  return (
    <div className="-mx-4 -mb-12 -mt-6 lg:-mx-6 lg:-mb-16 lg:-mt-8">
      <TitleCard footage={footage} loading={feed.state === 'loading'} onNavigate={onNavigate} />

      <Credit
        line={<>Every episode,</>}
        accent={<>accounted for.</>}
        note="Tick single episodes or whole seasons. Rewatches are kept separately, so a second run never overwrites the first."
      >
        <SampleSeason />
      </Credit>

      <Credit
        line={<>Something new,</>}
        accent={<>every night.</>}
        note="Search all of TMDb, browse what's trending, or let For You suggest titles from the ones you've rated. These are this week's trending titles; open any of them."
      >
        {feed.state === 'error' ? (
          <ErrorNotice
            className="w-full max-w-3xl text-left"
            title="Trending titles couldn’t load"
            message={feed.message}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        ) : (
          <Featured items={featured} loading={feed.state === 'loading'} onOpen={onOpen} />
        )}
      </Credit>

      <Credit
        line={<>A year,</>}
        accent={<>in film.</>}
        note="Home keeps the ledger: what you finished each month, the hours you spent, and everything you marked along the way."
      >
        <SampleYear />
      </Credit>

      <EndCredits onNavigate={onNavigate} />
    </div>
  )
}

/* ------------------------------------------------------------------ */

function TitleCard({ footage, loading, onNavigate }: { footage: TmdbTitle[]; loading: boolean; onNavigate: (page: Page) => void }) {
  return (
    <section className="relative flex flex-col items-center justify-center overflow-x-clip px-4 pt-16 text-center sm:min-h-[calc(100svh-57px)] sm:justify-between sm:pt-[8vh] lg:px-6">
      <div className="flex flex-col items-center">
        <h1 className="animate-rise font-display leading-[0.86] tracking-[-0.03em] text-foreground text-[clamp(76px,13.5vw,212px)]">
          <em className="text-[var(--primary)]">Cine</em>Track
        </h1>
        <p className="animate-rise mt-6 [animation-delay:90ms] max-w-[34ch] text-[17px] leading-relaxed text-muted-foreground sm:text-[19px]">
          A quiet ledger for every film, every episode and every rewatch you sit through.
        </p>
        <div className="animate-rise mt-9 flex [animation-delay:160ms] flex-wrap items-center justify-center gap-3">
          <PrimaryAction onClick={() => onNavigate('library')}>Open your library</PrimaryAction>
          <SecondaryAction onClick={() => onNavigate('discover')}>Discover something</SecondaryAction>
        </div>
      </div>

      <div className="w-[calc(100%+2rem)] pb-8 lg:w-[calc(100%+3rem)]">
        <Footage items={footage} loading={loading} />
        <button
          type="button"
          onClick={(event) => {
            const next = event.currentTarget.closest('section')?.nextElementSibling
            next?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
          }}
          className="mx-auto mt-7 flex w-fit items-center gap-2 font-sans text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:text-foreground"
        >
          Roll the credits
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M6 13l6 6 6-6" />
          </svg>
        </button>
      </div>
    </section>
  )
}

/**
 * This week's trending posters on a curved, endlessly turning row: the
 * opening shot the titles sit over. Placeholder plates hold the shape while
 * the artwork loads; the row is decorative (aria-hidden inside).
 */
function Footage({ items, loading }: { items: TmdbTitle[]; loading: boolean }) {
  // TMDb's landscape cover art (backdrops), which suits a wide, cinematic row.
  const images = useMemo(
    () => items.flatMap((item) => {
      const src = img(item.backdrop_path, 'w780')
      return src ? [{ src }] : []
    }),
    [items],
  )
  if (!loading && images.length === 0) return null
  return (
    <TiltedGridHero
      images={images}
      aspectRatio={16 / 9}
      tileHeight={56}
      axis={57}
      gap={4}
      curve={62}
      fade={10}
      speed={3.5}
      // Wide tiles span enough arc to need a few facets to read as curved.
      slices={6}
      className="h-[clamp(300px,46vh,560px)] w-full"
    />
  )
}

/* ------------------------------------------------------------------ */

/** One credit: a two-line title-card heading, a sentence, and a working fragment. */
function Credit({ line, accent, note, children }: { line: ReactNode; accent: ReactNode; note: string; children: ReactNode }) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="flex min-h-[92svh] scroll-mt-14 flex-col items-center justify-center px-4 py-24 text-center lg:px-6"
    >
      <div className="flex w-full flex-col items-center">
        <h2 id={id} className="credit-reveal font-display leading-[0.96] tracking-[-0.02em] text-foreground text-[clamp(44px,6.6vw,104px)]">
          {line}
          <br />
          <em className="text-[var(--primary)]">{accent}</em>
        </h2>
        <p className="credit-reveal mt-6 max-w-[52ch] text-[15px] leading-relaxed text-muted-foreground sm:text-[16px]">{note}</p>
        <div className="credit-reveal mt-14 flex w-full justify-center">{children}</div>
      </div>
    </section>
  )
}

/** A season to tick, drawn exactly like the title drawer's episode stamps. */
function SampleSeason() {
  const episodes = 10
  const [watched, setWatched] = useState<Set<number>>(() => new Set([1, 2, 3, 4, 5, 6]))
  const count = watched.size
  const toggle = (n: number) =>
    setWatched((current) => {
      const next = new Set(current)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })

  return (
    <div className="w-full max-w-[620px] text-left">
      <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2.5">
        <span className="rule-label">Season 1 · sample</span>
        <span className="font-sans text-[12px] tabular-nums text-muted-foreground" aria-live="polite">
          <span className="text-foreground">{count}</span> of {episodes} watched
        </span>
      </div>
      <div role="group" aria-label="Sample season, ten episodes" className="mt-4 grid grid-cols-5 gap-2 sm:grid-cols-10">
        {Array.from({ length: episodes }, (_, i) => i + 1).map((n) => {
          const done = watched.has(n)
          return (
            <button
              key={n}
              type="button"
              aria-pressed={done}
              aria-label={`Episode ${n}, ${done ? 'watched' : 'not watched'}`}
              onClick={() => toggle(n)}
              className={`press flex aspect-square items-center justify-center border font-sans text-[11px] tabular-nums transition-colors duration-200 ${
                done
                  ? 'animate-stamp border-[var(--status-watched)] bg-[var(--status-watched)] text-[var(--status-watched-foreground)]'
                  : 'border-border bg-card text-muted-foreground hover:border-[var(--primary)] hover:text-[var(--primary)]'
              }`}
            >
              {done ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path className="animate-check-draw" d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              ) : (
                <span aria-hidden="true">E{n}</span>
              )}
            </button>
          )
        })}
      </div>
      <div className="mt-4 h-[3px] w-full bg-border" aria-hidden="true">
        <div className="h-full bg-[var(--status-watched)] transition-[width] duration-500 ease-out" style={{ width: `${(count / episodes) * 100}%` }} />
      </div>
      <p className="mt-3 font-sans text-[12px] text-muted-foreground">Tap an episode to mark it.</p>
    </div>
  )
}

/** This week's trending titles, as the app's own poster cards. */
function Featured({ items, loading, onOpen }: { items: TmdbTitle[]; loading: boolean; onOpen: (type: MediaType, id: number, seed?: TmdbTitle) => void }) {
  const { get } = useLibrary()
  return (
    <div className="grid w-full max-w-5xl grid-cols-2 gap-x-5 gap-y-8 text-left sm:grid-cols-3 lg:grid-cols-5">
      {loading
        ? Array.from({ length: 5 }, (_, i) => <PosterSkeleton key={i} className={i >= 4 ? 'hidden lg:block' : i === 3 ? 'hidden sm:block' : ''} />)
        : items.map((item, i) => (
            <div key={`${item.media_type}-${item.id}`} className={i >= 4 ? 'hidden lg:block' : i === 3 ? 'hidden sm:block' : ''}>
              <Poster item={item} entry={get(item.media_type as MediaType, item.id)} onOpen={onOpen} animate={false} />
            </div>
          ))}
    </div>
  )
}

/** A year of completions, drawn the way Home draws yours. Sample data, and labelled so. */
const SAMPLE_YEAR = [3, 5, 2, 4, 6, 9, 7, 4, 5, 8, 11, 6]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function SampleYear() {
  const gradient = useId().replace(/:/g, '')
  const [active, setActive] = useState<number | null>(null)
  const W = 720
  const H = 220
  const top = 12
  const { line, area, points, peakIndex } = useMemo(() => {
    const max = 12
    const points = SAMPLE_YEAR.map((count, i) => ({ x: (i / (SAMPLE_YEAR.length - 1)) * W, y: 24 + (H - 24) - (count / max) * (H - 24) }))
    const segments = monotoneSegments(points)
    const first = points[0]!
    const last = points[points.length - 1]!
    return {
      points,
      line: `M${first.x},${first.y}${segments.join('')}`,
      area: `M${first.x},${H}L${first.x},${first.y}${segments.join('')}L${last.x},${H}Z`,
      peakIndex: SAMPLE_YEAR.indexOf(Math.max(...SAMPLE_YEAR)),
    }
  }, [])
  const total = SAMPLE_YEAR.reduce((sum, n) => sum + n, 0)
  const peak = points[peakIndex]!
  const tip = active == null ? null : points[active]!

  const pick = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width <= 0) return
    const ratio = (event.clientX - box.left) / box.width
    setActive(Math.min(SAMPLE_YEAR.length - 1, Math.max(0, Math.round(ratio * (SAMPLE_YEAR.length - 1)))))
  }

  return (
    <figure className="w-full max-w-[760px] text-left">
      <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2.5">
        <span className="rule-label">Monthly log · sample year</span>
        <span className="font-sans text-[12px] tabular-nums text-muted-foreground" aria-live="polite">
          {active == null ? (
            <>
              <span className="text-foreground">{total}</span> titles · busiest {MONTHS[peakIndex]}
            </>
          ) : (
            <>
              {MONTHS[active]} · <span className="text-foreground">{SAMPLE_YEAR[active]}</span> {SAMPLE_YEAR[active] === 1 ? 'title' : 'titles'}
            </>
          )}
        </span>
      </div>
      <svg
        viewBox={`0 -${top} ${W} ${H + top}`}
        tabIndex={0}
        role="img"
        aria-label={`Sample year: ${total} titles completed, busiest in ${MONTHS[peakIndex]} with ${SAMPLE_YEAR[peakIndex]}. Use the arrow keys to read each month.`}
        onPointerMove={pick}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
          event.preventDefault()
          const step = event.key === 'ArrowRight' ? 1 : -1
          setActive((i) => Math.min(SAMPLE_YEAR.length - 1, Math.max(0, (i ?? (step > 0 ? -1 : SAMPLE_YEAR.length)) + step)))
        }}
        className="mt-6 block h-auto w-full cursor-crosshair overflow-visible outline-offset-4 touch-pan-y"
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.5, 1].map((f) => (
          <line key={f} x1="0" x2={W} y1={H - (H - 24) * f} y2={H - (H - 24) * f} stroke="var(--border)" strokeDasharray="2 5" />
        ))}
        <line x1="0" x2={W} y1={H} y2={H} stroke="var(--border)" />
        <path d={area} fill={`url(#${gradient})`} />
        <path d={line} fill="none" stroke="var(--primary)" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" pathLength={1} className="chart-scroll-draw" vectorEffect="non-scaling-stroke" />
        {tip ? (
          <g>
            <line x1={tip.x} x2={tip.x} y1={-top} y2={H} stroke="var(--foreground)" strokeOpacity="0.18" />
            <circle cx={tip.x} cy={tip.y} r="5" fill="var(--background)" stroke="var(--primary)" strokeWidth="2.25" />
          </g>
        ) : (
          <g>
            <circle cx={peak.x} cy={peak.y} r="4.5" fill="var(--primary)" stroke="var(--background)" strokeWidth="2" />
            <text x={peak.x} y={peak.y - 14} textAnchor="middle" className="fill-[var(--primary)] font-display text-[22px]">
              {SAMPLE_YEAR[peakIndex]}
            </text>
          </g>
        )}
      </svg>
      <div aria-hidden="true" className="mt-3 flex justify-between font-sans text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        {MONTHS.map((m, i) => (
          <span key={m} className={`transition-colors ${active === i ? 'text-foreground' : ''} ${i % 2 === 1 ? 'max-sm:invisible' : ''}`}>{m}</span>
        ))}
      </div>
      <figcaption className="mt-4 font-sans text-[12px] text-muted-foreground">Sample data. Home draws this from the titles you finish; point at a month to read it.</figcaption>
    </figure>
  )
}

/* ------------------------------------------------------------------ */

const ROLL: { role: string; credit: ReactNode }[] = [
  { role: 'Tracking', credit: 'Films, series, single episodes and whole seasons' },
  { role: 'Rewatches', credit: 'Logged on their own, beside the first watch' },
  { role: 'Discovery', credit: 'TMDb search, trending, and For You picks' },
  { role: 'History', credit: 'Monthly log, hours watched, and an activity ledger' },
  { role: 'Details', credit: 'Ratings, favourites, notes and custom posters' },
  { role: 'Themes', credit: 'Paper and Noir, or whatever your system prefers' },
  { role: 'Storage', credit: 'One SQLite file on your machine, with JSON backups' },
  { role: 'Data', credit: 'The Movie Database (TMDb)' },
  {
    role: 'Source',
    credit: (
      <a href={SOURCE_URL} target="_blank" rel="noreferrer" className="underline decoration-[var(--border-strong)] underline-offset-4 transition-colors hover:text-[var(--primary)] hover:decoration-[var(--primary)]">
        github.com/halfbaked35/Cinetrack
      </a>
    ),
  },
]

function EndCredits({ onNavigate }: { onNavigate: (page: Page) => void }) {
  return (
    <section id="credits-roll" aria-labelledby="end-credits-title" className="border-t border-border px-4 pb-24 pt-28 lg:px-6">
      <div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
        <h2 id="end-credits-title" className="credit-reveal font-display text-[clamp(40px,5vw,72px)] italic leading-none tracking-[-0.02em]">
          End credits
        </h2>
        <dl className="mt-14 w-full space-y-4 text-left">
          {ROLL.map(({ role, credit }) => (
            <div key={role} className="credit-reveal flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-0">
              <dt className="rule-label shrink-0 sm:w-28 sm:text-right">{role}</dt>
              <span aria-hidden="true" className="mx-4 hidden min-w-8 flex-1 translate-y-[-3px] border-b border-dotted border-[var(--border-strong)] sm:block" />
              <dd className="text-[15px] leading-snug text-foreground sm:max-w-[60%] sm:text-right">{credit}</dd>
            </div>
          ))}
        </dl>

        <p className="credit-reveal mt-24 font-display text-[clamp(44px,6vw,88px)] leading-[0.96] tracking-[-0.02em]">
          Your seat is <em className="text-[var(--primary)]">saved.</em>
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <PrimaryAction onClick={() => onNavigate('library')}>Open your library</PrimaryAction>
          <SecondaryAction onClick={() => onNavigate('home')}>Go to Home</SecondaryAction>
        </div>
        <p className="mt-16 max-w-[52ch] font-sans text-[11px] leading-relaxed text-muted-foreground">
          This product uses the TMDb API but is not endorsed or certified by TMDb. Trending artwork above is TMDb’s, shown as it is this week.
        </p>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */

function PrimaryAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press group inline-flex h-11 items-center justify-center gap-2.5 border border-[var(--primary)] bg-[var(--primary)] px-6 max-sm:w-full max-sm:max-w-[18rem] font-sans text-[11px] font-medium uppercase tracking-[0.16em] text-primary-foreground transition-[filter] hover:brightness-110"
    >
      {children}
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="transition-transform duration-200 ease-out group-hover:translate-x-0.5">
        <path d="M5 12h14M13 6l6 6-6 6" />
      </svg>
    </button>
  )
}

function SecondaryAction({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press inline-flex h-11 items-center justify-center border border-border px-6 max-sm:w-full max-sm:max-w-[18rem] font-sans text-[11px] font-medium uppercase tracking-[0.16em] text-foreground transition-colors hover:border-[var(--foreground)]"
    >
      {children}
    </button>
  )
}
