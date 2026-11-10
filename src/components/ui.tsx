import {
  memo,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { img, titleOf, yearOf, type MediaType, type TmdbTitle } from '../lib/tmdb'
import { isLibraryHydrated, progress, useLibrary, type Entry, type Status } from '../lib/library'
import { useSetting } from '../lib/settings'
import { useToast } from './Toast'

/** CineTrack brand marks. */
const PINK = '#D93D87'
const BLUE = '#263C92'

/** DOM id of the settings drawer, so the Alt+, toggle key can recognise its own dialog. */
export const SETTINGS_PANEL_ID = 'settings-panel'

export function Mark({ size = 28, className }: { size?: number; className?: string }) {
  const height = (size * 100) / 170
  return (
    <svg
      width={size}
      height={height}
      viewBox="0 0 170 100"
      fill="none"
      role="img"
      aria-label="CineTrack"
      className={className}
    >
      <circle cx="50" cy="50" r="50" fill={PINK} />
      <circle cx="120" cy="50" r="50" fill={BLUE} />
    </svg>
  )
}

export function ShuffleIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m18 14 4 4-4 4" />
      <path d="m18 2 4 4-4 4" />
      <path d="M2 18h1.973a4 4 0 0 0 3.3-1.7l5.454-8.6a4 4 0 0 1 3.3-1.7H22" />
      <path d="M2 6h1.972a4 4 0 0 1 3.6 2.2" />
      <path d="M22 18h-6.041a4 4 0 0 1-3.3-1.8l-.359-.45" />
    </svg>
  )
}

export function Logo({
  size = 26,
  markSize,
  className,
  wordmark = true,
}: {
  size?: number
  markSize?: number
  className?: string
  wordmark?: boolean
}) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className ?? ''}`}>
      <Mark size={markSize ?? size} />
      {wordmark && (
        <span
          className="font-display italic leading-none tracking-tight text-foreground"
          style={{ fontSize: size * 1.02 }}
        >
          CineTrack
        </span>
      )}
    </span>
  )
}

let scrollLockCount = 0
let previousOverflow: string | null = null
let previousPaddingRight: string | null = null

export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked || typeof document === 'undefined') return
    if (scrollLockCount === 0) {
      previousOverflow = document.body.style.overflow
      previousPaddingRight = document.body.style.paddingRight
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
      document.body.style.overflow = 'hidden'
      if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`
    }
    scrollLockCount++
    return () => {
      scrollLockCount = Math.max(0, scrollLockCount - 1)
      if (scrollLockCount === 0 && typeof document !== 'undefined') {
        document.body.style.overflow = previousOverflow ?? ''
        document.body.style.paddingRight = previousPaddingRight ?? ''
        previousOverflow = null
        previousPaddingRight = null
      }
    }
  }, [locked])
}

/** Fixed semantic status colors — distinct tokens like delete red, via CSS vars. */
export const STATUS_STYLE: Record<Status, string> = {
  planned: 'bg-[var(--status-planned)] text-[var(--status-planned-foreground)] border border-[var(--status-planned)]',
  watching: 'bg-[var(--status-watching)] text-[var(--status-watching-foreground)] border border-[var(--status-watching)]',
  watched: 'bg-[var(--status-watched)] text-[var(--status-watched-foreground)] border border-[var(--status-watched)]',
  dropped: 'bg-muted text-muted-foreground border border-border',
}

export const STATUS_INACTIVE: Record<Status, string> = {
  planned:
    'border border-[var(--status-planned)]/30 bg-[var(--status-planned)]/[0.06] text-[var(--status-planned-ink)] hover:bg-[var(--status-planned)] hover:text-[var(--status-planned-foreground)] hover:border-[var(--status-planned)]',
  watching:
    'border border-[var(--status-watching)]/30 bg-[var(--status-watching)]/[0.06] text-[var(--status-watching-ink)] hover:bg-[var(--status-watching)] hover:text-[var(--status-watching-foreground)] hover:border-[var(--status-watching)]',
  watched:
    'border border-[var(--status-watched)]/30 bg-[var(--status-watched)]/[0.06] text-[var(--status-watched-ink)] hover:bg-[var(--status-watched)] hover:text-[var(--status-watched-foreground)] hover:border-[var(--status-watched)]',
  dropped:
    'border border-border bg-muted/20 text-muted-foreground hover:bg-muted hover:text-foreground',
}

export const STATUS_DOT_CLASS: Record<Status, string> = {
  planned: 'bg-[var(--status-planned)]',
  watching: 'bg-[var(--status-watching)]',
  watched: 'bg-[var(--status-watched)]',
  dropped: 'bg-muted-foreground',
}

/** Text/icon colour that stays legible on each status fill, in every theme. */
const STATUS_TEXT_ON: Record<Status, string> = {
  planned: 'text-[var(--status-planned-foreground)]',
  watching: 'text-[var(--status-watching-foreground)]',
  watched: 'text-[var(--status-watched-foreground)]',
  dropped: 'text-[var(--background)]',
}

/** Per-status colour so a library reads at a glance with minimalist colored circles. */
export const STATUS_BADGE: Record<Status, { bg: string; dot: string; label: string; icon: ReactNode }> = {
  planned: {
    bg: STATUS_STYLE.planned,
    dot: STATUS_DOT_CLASS.planned,
    label: 'Planned',
    icon: <span className="block h-2.5 w-2.5 rounded-full bg-[var(--status-planned)]" aria-hidden="true" />,
  },
  watching: {
    bg: STATUS_STYLE.watching,
    dot: STATUS_DOT_CLASS.watching,
    label: 'Watching',
    icon: <span className="block h-2.5 w-2.5 rounded-full bg-[var(--status-watching)]" aria-hidden="true" />,
  },
  watched: {
    bg: STATUS_STYLE.watched,
    dot: STATUS_DOT_CLASS.watched,
    label: 'Watched',
    icon: <span className="block h-2.5 w-2.5 rounded-full bg-[var(--status-watched)]" aria-hidden="true" />,
  },
  dropped: {
    bg: STATUS_STYLE.dropped,
    dot: STATUS_DOT_CLASS.dropped,
    label: 'Dropped',
    icon: <span className="block h-2.5 w-2.5 rounded-full bg-muted-foreground" aria-hidden="true" />,
  },
}

const STATUS_GLYPH: Record<Status, ReactNode> = {
  planned: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-full w-full" aria-hidden>
      <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z" />
    </svg>
  ),
  watching: (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-full w-full" aria-hidden>
      <path d="M6 4.5v15a1 1 0 0 0 1.53.85l12-7.5a1 1 0 0 0 0-1.7l-12-7.5A1 1 0 0 0 6 4.5Z" />
    </svg>
  ),
  watched: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-full w-full" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  ),
  dropped: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-full w-full" aria-hidden>
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
}

export function StatusBadge({
  status,
  rewatching = false,
  shape,
  size,
  showIcon,
  shadow,
}: {
  status: Status
  rewatching?: boolean
  shape?: 'circle' | 'square' | 'text'
  size?: 'small' | 'medium' | 'large'
  showIcon?: boolean
  shadow?: boolean
}) {
  const roundPosters = useSetting('roundPosters')
  const s = STATUS_BADGE[status] ?? STATUS_BADGE.planned
  const dotColor = s.dot ?? STATUS_DOT_CLASS[status] ?? STATUS_DOT_CLASS.planned

  // The badge look is fixed (it used to be a setting): a medium circle, no icon, no shadow.
  const currentShape = shape ?? 'circle'
  const currentSize = size ?? 'medium'
  const currentShowIcon = showIcon ?? false
  const currentShadow = shadow ?? false

  const shadowClass = currentShadow ? 'shadow-[0_2px_8px_rgba(0,0,0,0.35)]' : 'shadow-none'

  const labelText = rewatching ? 'Rewatching' : s.label

  if (currentShape === 'text') {
    const textRounding = roundPosters ? 'rounded-[4px]' : 'rounded-none'
    const textSizeClass =
      currentSize === 'small'
        ? 'text-[8px] px-1.5 py-0.5 tracking-[0.08em] gap-1'
        : currentSize === 'medium'
          ? 'text-[9px] px-2 py-0.5 tracking-[0.1em] gap-1.5'
          : 'text-[10px] px-2.5 py-1 tracking-[0.12em] gap-1.5'

    const textIconSizeClass =
      currentSize === 'small'
        ? 'h-2 w-2'
        : currentSize === 'medium'
          ? 'h-2.5 w-2.5'
          : 'h-3 w-3'

    const textBg = rewatching ? 'bg-[var(--primary)] text-primary-foreground' : `${dotColor} ${STATUS_TEXT_ON[status]}`

    return (
      <span
        role="img"
        title={s.label}
        aria-label={`${s.label}${rewatching ? ' · Rewatching' : ''}`}
        className={`relative inline-flex items-center justify-center font-sans font-semibold uppercase shrink-0 select-none ${shadowClass} ${textRounding} ${textSizeClass} ${textBg}`}
      >
        {currentShowIcon && (
          <span className={`flex items-center justify-center shrink-0 ${textIconSizeClass}`} aria-hidden>
            {STATUS_GLYPH[status]}
          </span>
        )}
        <span>{labelText}</span>
      </span>
    )
  }

  const shapeClass = currentShape === 'circle' ? 'rounded-full' : 'rounded-none'

  const sizeClass =
    currentSize === 'small'
      ? 'h-3.5 w-3.5'
      : currentSize === 'medium'
        ? 'h-5 w-5'
        : 'h-6 w-6'

  const iconSizeClass =
    currentSize === 'small'
      ? 'h-2 w-2'
      : currentSize === 'medium'
        ? 'h-3 w-3'
        : 'h-3.5 w-3.5'

  const ringOffsetClass =
    currentSize === 'small' ? 'ring-offset-1' : 'ring-offset-2'

  return (
    <span
      role="img"
      title={s.label}
      aria-label={`${s.label}${rewatching ? ' · Rewatching' : ''}`}
      className={`relative flex items-center justify-center shrink-0 ${STATUS_TEXT_ON[status]} ${shadowClass} ${shapeClass} ${sizeClass} ${dotColor} ${
        rewatching ? `ring-2 ring-[var(--primary)] ${ringOffsetClass} ring-offset-black/50` : ''
      }`}
    >
      {currentShowIcon && (
        <span className={`flex items-center justify-center ${iconSizeClass}`} aria-hidden>
          {STATUS_GLYPH[status]}
        </span>
      )}
    </span>
  )
}

export function SectionHead({ index, title, note, right, rule = true, fullBleed = false, titleClassName, headingLevel = 2 }: { index?: string; title: string; note?: string; right?: ReactNode; rule?: boolean; fullBleed?: boolean; titleClassName?: string; headingLevel?: 1 | 2 | 3 }) {
  const Heading = `h${headingLevel}` as 'h1' | 'h2' | 'h3'
  return (
    <div className={`relative z-30 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-end sm:gap-6 ${rule ? 'mb-6 pb-3' : 'mb-4'}`}>
      {/* The rule beneath the head draws itself in rather than appearing. */}
      {rule && (
        <span
          aria-hidden
          className={fullBleed
            ? 'animate-rule absolute bottom-0 left-1/2 h-px w-screen -translate-x-1/2 bg-border [transform-origin:center]'
            : 'animate-rule absolute inset-x-0 bottom-0 h-px bg-border'}
        />
      )}
      <div className="flex items-baseline gap-4 min-w-0">
        {index && <span className="animate-fade font-sans text-[11px] tracking-[0.2em] text-[var(--accent)]">{index}</span>}
        <div className="min-w-0">
          <Heading className={`font-display text-[34px] sm:text-[38px] italic leading-none tracking-tight ${titleClassName ?? ''}`}>{title}</Heading>
          {note && <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground whitespace-normal md:whitespace-nowrap">{note}</p>}
        </div>
      </div>
      {right}
    </div>
  )
}

/**
 * Counts a number up to its target on mount and whenever it changes, so the
 * figures on a dashboard tally rather than blink. Non-numeric values pass
 * straight through; reduced-motion users get the final value immediately.
 */
function useTally(value: string | number) {
  const target = typeof value === 'number' ? value : Number.NaN
  const [shown, setShown] = useState(target)
  const from = useRef(target)

  useEffect(() => {
    if (Number.isNaN(target)) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const start = from.current
    if (reduced || start === target) {
      from.current = target
      setShown(target)
      return
    }
    const t0 = performance.now()
    const span = 620
    let raf = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / span)
      // easeOutQuart — fast off the mark, long settle.
      const eased = 1 - Math.pow(1 - t, 4)
      setShown(Math.round(start + (target - start) * eased))
      if (t < 1) raf = requestAnimationFrame(step)
      else from.current = target
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target])

  return Number.isNaN(target) ? value : shown
}

export function Stat({
  label,
  value,
  unit,
  onClick,
}: {
  label: string
  value: string | number
  unit?: string
  onClick: () => void
}) {
  const shown = useTally(value)
  return (
    <button
      type="button"
      onClick={onClick}
      className="animate-tick group w-full cursor-pointer border-l border-border py-0.5 pl-5 text-left transition-colors hover:border-[var(--primary)]"
    >
      <div className="rule-label text-[11px] tracking-[0.18em]">{label}</div>
      <div className="mt-2.5 flex items-baseline gap-2">
        <span className="font-display text-[48px] leading-none tracking-tight tabular-nums transition-colors group-hover:text-[var(--primary)] sm:text-[54px]">{shown}</span>
        {unit && <span className="font-sans text-[13px] text-muted-foreground">{unit}</span>}
      </div>
    </button>
  )
}

export function Chip({
  active,
  children,
  onClick,
  className,
  role,
}: {
  active?: boolean
  children: ReactNode
  onClick?: () => void
  className?: string
  role?: 'radio'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role={role}
      tabIndex={role === 'radio' ? (active ? 0 : -1) : undefined}
      aria-pressed={role ? undefined : active ? 'true' : 'false'}
      aria-checked={role === 'radio' ? active : undefined}
      className={`press shrink-0 whitespace-nowrap border px-3 py-1.5 font-sans text-[11px] font-medium uppercase tracking-[0.14em] ${
        active
          ? 'border-[var(--primary)] bg-[var(--primary)] text-primary-foreground'
          : 'border-border text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground'
      } ${className ?? ''}`}
    >
      {children}
    </button>
  )
}

/** Apply the standard arrow/Home/End interaction to buttons in a radio group. */
export function handleRadioGroupKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'))
  const currentRadio = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="radio"]')
  const current = currentRadio ? radios.indexOf(currentRadio) : -1
  if (!radios.length || current < 0) return
  let next: number
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % radios.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + radios.length) % radios.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = radios.length - 1
  else return
  event.preventDefault()
  radios[next]?.focus()
  radios[next]?.click()
}

export function CarouselNav({
  onPrev,
  onNext,
  prevLabel = 'Scroll back',
  nextLabel = 'Scroll forward',
  className,
}: {
  onPrev: () => void
  onNext: () => void
  prevLabel?: string
  nextLabel?: string
  className?: string
}) {
  return (
    <div className={`flex shrink-0 gap-2 ${className ?? ''}`}>
      <button
        type="button"
        onClick={onPrev}
        aria-label={prevLabel}
        className="press flex h-8 w-8 items-center justify-center border border-border text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onNext}
        aria-label={nextLabel}
        className="press flex h-8 w-8 items-center justify-center border border-border text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M5 12h14M12 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  )
}

/** TMDb results omit media_type on single-type endpoints; titles have `title`, series `name`. */
export function mediaTypeOf(item: Pick<TmdbTitle, 'media_type' | 'title'>): MediaType {
  return item.media_type ?? (item.title ? 'movie' : 'tv')
}

/** Poster art with viewport-aware loading and a smaller-image fallback. */
export function usePosterArt(
  url: string | null,
  srcSet?: string,
  options: { lazy?: boolean; fallbackSrc?: string | null } = {},
) {
  const { lazy = false, fallbackSrc = null } = options
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>(url ? 'loading' : 'failed')
  const [nearViewport, setNearViewport] = useState(!lazy)
  const [usingFallback, setUsingFallback] = useState(false)
  const elRef = useRef<HTMLImageElement | null>(null)
  const targetRef = useRef<HTMLDivElement | null>(null)
  const source = usingFallback ? fallbackSrc : url
  const shouldLoad = Boolean(source && (!lazy || nearViewport))

  useEffect(() => {
    setUsingFallback(false)
    setStatus(url ? 'loading' : 'failed')
  }, [url, srcSet, fallbackSrc])
  // Becoming eager (e.g. a resize moves a poster into the first rows) only
  // ever starts a load; it never resets one that already finished.
  useEffect(() => {
    if (!lazy) setNearViewport(true)
  }, [lazy])

  useEffect(() => {
    if (!lazy || nearViewport || !url) return
    const target = targetRef.current
    if (!target) return
    if (!('IntersectionObserver' in window)) {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true)
          observer.disconnect()
        }
      },
      { rootMargin: '1200px 0px' },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [lazy, nearViewport, url])

  const settle = useCallback(() => {
    const el = elRef.current
    if (el && el.complete && el.naturalWidth > 0) setStatus('ready')
  }, [])

  const failover = useCallback(() => {
    if (usingFallback || !fallbackSrc || fallbackSrc === url) {
      setStatus('failed')
      return
    }
    setUsingFallback(true)
    setStatus('loading')
  }, [fallbackSrc, url, usingFallback])

  // A slow image keeps loading (the shimmer stays up); only a real load error
  // switches to the fallback. A timer-based switch aborted in-flight downloads
  // and left slow connections with permanent "Poster unavailable" plates.
  // Cached images can finish before the state-reset effect above runs. Check
  // the committed element once the browser has applied its new source so that
  // those posters settle immediately instead of showing a stale loader.
  useEffect(() => {
    if (!shouldLoad || !source) return
    const frame = window.requestAnimationFrame(settle)
    return () => window.cancelAnimationFrame(frame)
  }, [shouldLoad, source, settle])

  return {
    src: shouldLoad ? source : null,
    srcSet: shouldLoad && !usingFallback ? srcSet : undefined,
    status,
    hasArt: Boolean(url),
    shouldLoad,
    lazy,
    elRef,
    targetRef,
    onLoad: settle,
    onError: failover,
  }
}

const TILT_DEGREES = 12

/**
 * Pointer-driven 3D tilt. The outer element is the hit area and is never
 * transformed; only its inner body moves. Transforming the hit area itself
 * made the card lift out from under the cursor near its edges (hover lost →
 * card drops → hover regained: a flicker loop) and fed its own rotated bounds
 * back into the tilt maths, which jittered.
 */
function usePosterTilt<T extends HTMLElement>(enabled: boolean) {
  const cardRef = useRef<T>(null)
  const frame = useRef(0)
  const pending = useRef<{ x: number; y: number } | null>(null)

  const write = (x: number, y: number) => {
    const el = cardRef.current
    if (!el) return
    el.style.setProperty('--poster-tilt-x', `${(-y * TILT_DEGREES).toFixed(2)}deg`)
    el.style.setProperty('--poster-tilt-y', `${(x * TILT_DEGREES).toFixed(2)}deg`)
  }

  const cancelFrame = () => {
    if (frame.current) window.cancelAnimationFrame(frame.current)
    frame.current = 0
    pending.current = null
  }

  useEffect(() => cancelFrame, [])

  const handlePointerMove = (event: React.PointerEvent<T>) => {
    if (!enabled || event.pointerType !== 'mouse') return
    // The untransformed hit area gives stable bounds for the whole card.
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0) return
    const clamp = (v: number) => Math.min(0.5, Math.max(-0.5, v))
    pending.current = {
      x: clamp((event.clientX - bounds.left) / bounds.width - 0.5),
      y: clamp((event.clientY - bounds.top) / bounds.height - 0.5),
    }
    // Coalesce to one style write per frame.
    if (!frame.current) {
      frame.current = window.requestAnimationFrame(() => {
        frame.current = 0
        const next = pending.current
        pending.current = null
        if (next) write(next.x, next.y)
      })
    }
  }

  const resetPointer = () => {
    cancelFrame()
    write(0, 0)
  }

  return { cardRef, handlePointerMove, resetPointer }
}

export function PosterTilt({
  children,
  className = '',
  style,
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  const motion = useSetting('posterMotion')
  const tilt = usePosterTilt<HTMLDivElement>(motion)

  return (
    <div
      ref={tilt.cardRef}
      style={style}
      data-motion={motion ? undefined : 'off'}
      onPointerMove={tilt.handlePointerMove}
      onPointerLeave={tilt.resetPointer}
      onPointerCancel={tilt.resetPointer}
      className={`poster-card-3d group ${className}`}
    >
      <div className="poster-card-3d__body">{children}</div>
    </div>
  )
}

export function PosterTiltInline({
  children,
  className = '',
  style,
}: {
  children: ReactNode
  className?: string
  style?: CSSProperties
}) {
  const motion = useSetting('posterMotion')
  const tilt = usePosterTilt<HTMLSpanElement>(motion)

  return (
    <span
      ref={tilt.cardRef}
      style={style}
      data-motion={motion ? undefined : 'off'}
      onPointerMove={tilt.handlePointerMove}
      onPointerLeave={tilt.resetPointer}
      onPointerCancel={tilt.resetPointer}
      className={`poster-card-3d group ${className}`}
    >
      <span className="poster-card-3d__body">{children}</span>
    </span>
  )
}

export const Poster = memo(function Poster({
  item,
  entry,
  onOpen,
  style,
  animate = true,
  eager = false,
  movieLabel = 'Film',
}: {
  item: TmdbTitle
  entry?: Entry
  onOpen: (type: MediaType, id: number, seed: TmdbTitle) => void
  /** Optional row entrance delay. */
  style?: CSSProperties
  animate?: boolean
  eager?: boolean
  movieLabel?: string
}) {
  // Per-key subscriptions: a change to an unrelated setting must not
  // re-render every poster.
  const density = useSetting('density')
  const showCommunityScores = useSetting('showCommunityScores')
  const posterMotion = useSetting('posterMotion')
  const defaultStatus = useSetting('defaultStatus')
  // Posters receive their entry from the grid parent. Avoid subscribing each
  // individual card to the whole store; one library-level subscription is enough.
  const { upsert } = useLibrary(false)
  const { toast } = useToast()
  const type: MediaType = mediaTypeOf(item)
  const customPoster = entry?.customPoster ?? null
  const src = customPoster ?? img(item.poster_path, 'w342')
  const srcSet = customPoster
    ? undefined
    : `${img(item.poster_path, 'w185')} 185w, ${img(item.poster_path, 'w342')} 342w, ${img(item.poster_path, 'w500')} 500w`
  const compact = density === 'compact'
  const pct = entry ? progress(entry) : 0
  const community =
    showCommunityScores && item.vote_average > 0 ? item.vote_average.toFixed(1) : null
  const badgePositionClass = 'right-2.5 top-2.5'

  const art = usePosterArt(src, srcSet || undefined, {
    lazy: !eager,
    // Custom posters fall back to the TMDb art; TMDb art to a smaller size.
    fallbackSrc: customPoster ? img(item.poster_path, 'w342') : img(item.poster_path, 'w185'),
  })
  const artPending = art.status === 'loading' && (!art.lazy || art.shouldLoad)
  const [showArtLoader, setShowArtLoader] = useState(false)

  // Skip the shimmer for fast/cache hits. When art is genuinely pending, let
  // the placeholder ease in rather than flashing for a frame.
  useEffect(() => {
    if (!artPending) {
      setShowArtLoader(false)
      return
    }
    const timer = window.setTimeout(() => setShowArtLoader(true), 600)
    return () => window.clearTimeout(timer)
  }, [artPending])

  return (
    <PosterTilt style={style} className={`select-none ${animate ? 'animate-plate-fade' : ''}`}>
      <div
        ref={art.targetRef}
        data-poster-surface
        className="poster-card-3d__art relative aspect-[2/3] w-full overflow-hidden bg-muted"
      >
        {art.hasArt && art.shouldLoad && art.status !== 'failed' && (
          <div
            className={`pointer-events-none absolute inset-0 transition-opacity duration-300 ease-out ${showArtLoader && artPending ? 'shimmer opacity-70' : 'bg-muted opacity-0'}`}
            aria-hidden="true"
          />
        )}
        <button
          type="button"
          onClick={() => onOpen(type, item.id, item)}
          aria-label={`${titleOf(item)}${yearOf(item) ? ` (${yearOf(item)})` : ''}${entry ? `, ${entry.rewatching ? 'rewatching' : STATUS_BADGE[entry.status].label.toLowerCase()}` : ''}`}
          className="absolute inset-0 h-full w-full cursor-pointer press focus-visible:outline-offset-[-3px]"
        >
          {art.hasArt && art.status !== 'failed' ? (
            <img
              ref={art.elRef}
              src={art.src ?? undefined}
              srcSet={art.srcSet}
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 16vw"
              alt={`Poster for ${titleOf(item)}`}
              loading="eager"
              decoding="async"
              width={342}
              height={513}
              onLoad={art.onLoad}
              onError={art.onError}
              className={`h-full w-full object-cover transition-[opacity,transform,filter] duration-300 ease-out ${
                art.status === 'ready' ? 'opacity-100' : 'opacity-0'
              } ${posterMotion ? 'group-hover:scale-[1.03]' : ''} group-hover:brightness-110 group-hover:saturate-110`}
            />
          ) : (
            <div aria-hidden="true" className="flex h-full items-center justify-center p-3 text-center font-sans text-xs text-muted-foreground">
              Poster unavailable
            </div>
          )}
        </button>
        <div className={`absolute z-10 ${badgePositionClass}`}>
          {entry ? (
            <div className="pointer-events-none">
              <StatusBadge status={entry.status} rewatching={entry.rewatching} />
            </div>
          ) : (
            <button
              type="button"
              aria-label={`Add ${titleOf(item)} to library`}
              title="Add to library"
              onClick={(e) => {
                e.stopPropagation()
                if (!isLibraryHydrated()) {
                  toast('Your library is still loading — try again in a moment', 'warning')
                  return
                }
                upsert(type, item.id, { title: titleOf(item), poster: item.poster_path, year: yearOf(item), status: defaultStatus })
                toast(`${titleOf(item)} added to your library`, 'success')
              }}
              className="press flex h-6 w-6 cursor-pointer items-center justify-center bg-[var(--primary)] text-primary-foreground opacity-0 shadow-md transition-all duration-200 hover:scale-110 hover:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
            >
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
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
        </div>
        {pct > 0 && pct < 1 && (
          <span className="absolute inset-x-0 bottom-0 h-[3px] bg-black/25">
            <span
              className="animate-grow block h-full bg-[var(--accent)] transition-[width] duration-500"
              style={{ width: `${pct * 100}%` }}
            />
          </span>
        )}
      </div>
      <div className="poster-card-3d__meta">
        {/* Duplicate of the poster button for pointer users; kept out of the tab
            order and the accessibility tree so each card is one stop. */}
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          onClick={() => onOpen(type, item.id, item)}
          className="mt-2 flex w-full items-baseline justify-between gap-2 text-left"
        >
          <span
            className={`truncate font-sans leading-tight transition-colors duration-200 group-hover:text-[var(--primary)] ${
              compact ? 'text-[13px]' : 'text-[15px]'
            }`}
          >
            {titleOf(item)}
          </span>
          <span className="font-sans text-[10px] tabular-nums text-muted-foreground transition-colors duration-300 group-hover:text-foreground">
            {yearOf(item) || '—'}
            {community && <span className="text-[var(--accent)]"> · ★ {community}</span>}
          </span>
        </button>
        <div className="rule-label mt-0.5 transition-colors duration-300 group-hover:text-foreground">{type === 'movie' ? movieLabel : 'Series'}</div>
      </div>
    </PosterTilt>
  )
})

export function PosterSkeleton({
  compact,
  style,
  className = '',
}: {
  compact?: boolean
  style?: CSSProperties
  className?: string
}) {
  return (
    <div aria-hidden="true" style={style} className={`animate-fade select-none ${className}`}>
      <div className="relative aspect-[2/3] w-full overflow-hidden bg-muted shimmer" />
      <div className="mt-2 flex w-full items-baseline justify-between gap-2">
        <div className={`h-4 w-3/4 bg-muted shimmer ${compact ? 'text-[15px]' : 'text-[17px]'}`} />
        <div className="h-3 w-8 bg-muted shimmer" />
      </div>
      <div className="mt-1 h-2.5 w-12 bg-muted/70 shimmer" />
    </div>
  )
}

export function PosterGrid({
  children,
  columns,
  className = '',
}: {
  children: ReactNode
  columns?: number
  className?: string
}) {
  const density = useSetting('density')
  const cols = columns ?? (density === 'compact' ? 8 : 6)

  return (
    <div
      className={`poster-grid-dynamic grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 md:grid-cols-4 ${className}`}
      style={
        {
          '--grid-desktop-cols': cols,
        } as CSSProperties
      }
    >
      {children}
    </div>
  )
}

/** Minimal search field — editorial, no chrome, ⌘K to focus. */
export function SearchInput({
  value,
  onChange,
  label,
  placeholder = 'Search…',
  className,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  /** Accessible name, e.g. "Search your library". */
  label: string
  placeholder?: string
  className?: string
  autoFocus?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        const target = e.target instanceof HTMLElement ? e.target : null
        if (target?.closest('[role="dialog"]')) return
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
      if (e.key === 'Escape' && document.activeElement === inputRef.current) {
        inputRef.current?.blur()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      className={`group flex h-9 items-center gap-2.5 border bg-background px-3 transition-colors duration-200 ${
        focused ? 'border-[var(--foreground)] ring-1 ring-[var(--foreground)]' : 'border-[var(--input)] hover:border-[var(--foreground)]'
      } ${className ?? ''}`}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-3.5 shrink-0 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        aria-label={label}
        aria-keyshortcuts="Control+K Meta+K"
        style={{ outline: 'none', boxShadow: 'none' }}
        className="min-w-0 flex-1 bg-transparent font-sans text-[16px] tracking-[0.01em] !outline-none focus:!outline-none focus-visible:!outline-none focus:ring-0 focus-visible:ring-0 placeholder:text-muted-foreground sm:text-[13px] [&::-webkit-search-cancel-button]:hidden"
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
          aria-label="Clear search"
          className="press shrink-0 p-1 font-sans text-[12px] leading-none text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      ) : (
        <span className="hidden select-none font-sans text-[10px] tracking-[0.08em] text-muted-foreground/40 sm:block" aria-hidden>
          {typeof navigator !== 'undefined' && /Mac|iPhone|iPad|Macintosh/.test(navigator.userAgent ?? '') ? '⌘K' : 'Ctrl K'}
        </span>
      )}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="animate-fade border border-dashed border-border px-6 py-14 text-center font-sans text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * Trap Tab cycling inside `ref` while mounted, move focus to the first
 * control on open, and restore the trigger's focus on close. Nested traps
 * cooperate: an inner trap that handled the key sets defaultPrevented.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    if (!active) return
    const el = ref.current
    if (!el || typeof document === 'undefined') return
    const prev = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null
    // When the trap opened from nowhere focusable (or the opener is removed),
    // return focus to the nearest enclosing dialog instead of <body>.
    const fallback = el.parentElement?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ?? null
    const isVisible = (n: HTMLElement) => {
      if (n.hasAttribute('disabled')) return false
      if (n.closest('[hidden]')) return false
      // getClientRects is layout-dependent (it can be empty without a layout
      // box) — fall back to computed style so hidden controls are still
      // filtered out.
      if (typeof window !== 'undefined' && typeof n.getClientRects === 'function' && n.getClientRects().length > 0) {
        return true
      }
      try {
        const cs = window.getComputedStyle(n)
        return cs.display !== 'none' && cs.visibility !== 'hidden'
      } catch {
        return true
      }
    }
    const items = () =>
      [
        ...el.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter(isVisible)
    try {
      items()[0]?.focus({ preventScroll: true })
    } catch {
      /* older browsers ignore focus options */
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return
      const list = items()
      if (list.length === 0) {
        e.preventDefault()
        return
      }
      const first = list[0] as HTMLElement
      const last = list[list.length - 1] as HTMLElement
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('keydown', onKey)
      const target = prev?.isConnected ? prev : fallback?.isConnected ? fallback : null
      if (!target) return
      if (target === fallback && !target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
      try {
        target.focus({ preventScroll: true })
      } catch {
        target.focus()
      }
    }
  }, [ref, active])
}

/**
 * Tooltips that show on hover/focus and vanish the moment the pointer
 * leaves (the CSS fade keeps it smooth) or immediately on activation —
 * so they never get stuck open when a click moves focus elsewhere.
 */
export function useTimedTooltip() {
  const [visible, setVisible] = useState(false)
  const show = useCallback(() => setVisible(true), [])
  const hide = useCallback(() => setVisible(false), [])
  // WCAG 1.4.13: a tooltip must be dismissible without moving the pointer.
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVisible(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible])
  return { visible, show, hide }
}

export function Spinner({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      className={`animate-spin text-[var(--primary)] ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Loading"
      role="status"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  )
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  container,
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  container?: HTMLElement | null
  /** danger (default): red ! badge + red confirm. neutral: ink badge + primary confirm. */
  tone?: 'danger' | 'neutral'
  onConfirm: () => void
  onCancel: () => void
}) {
  const [shown, setShown] = useState(false)
  // Start "left" when closed so a closed dialog never mounts a hidden
  // alertdialog that screen readers can still find.
  const [leaving, setLeaving] = useState(!open)
  const boxRef = useRef<HTMLDivElement | null>(null)
  // Two confirms can coexist (e.g. the editor's reset + discard prompts), so
  // ids must be unique per instance rather than hard-coded.
  const titleId = useId()
  const descId = useId()
  useFocusTrap(boxRef, open)
  // Stable identity: onCancel is an inline prop that changes every parent
  // render — chasing it would re-run the effect on every commit.
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel
  const leaveTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    },
    [],
  )

  useEffect(() => {
    if (open) {
      setLeaving(false)
      // Double rAF so the browser paints the hidden state before the sheet
      // develops — without this the enter transition frequently doesn't fire.
      let raf2 = 0
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setShown(true))
      })
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancelRef.current()
        }
      }
      window.addEventListener('keydown', onKey, true)
      return () => {
        cancelAnimationFrame(raf1)
        cancelAnimationFrame(raf2)
        window.removeEventListener('keydown', onKey, true)
      }
    }
    // Closed: play the exit transition, then stop rendering.
    setShown(false)
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => setLeaving(true), 200)
    return undefined
  }, [open])

  if (!open && leaving) return null

  return createPortal(
    <div
      className={`modal-backdrop ${container ? 'absolute' : 'fixed'} inset-0 z-[100] flex items-center justify-center bg-[var(--scrim)] p-4 ${shown ? '' : 'pointer-events-none'}`}
      data-open={shown}
      onClick={onCancel}
      onWheel={(e) => e.stopPropagation()}
      onTouchMove={(e) => e.stopPropagation()}
    >
      <div
        ref={boxRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="modal-sheet w-full max-w-[440px] border border-border bg-background p-6 shadow-[var(--shadow-sheet)]"
        data-open={shown}
        onClick={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border pb-3">
          {tone !== 'danger' && (
            <span
              aria-hidden
              className="flex h-7 w-7 items-center justify-center bg-[var(--foreground)] text-[var(--background)]"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="10" />
                <path d="M12 9v4M12 17h.01" />
              </svg>
            </span>
          )}
          <h3 id={titleId} className="font-display text-[22px] leading-none">
            {title}
          </h3>
        </div>

        <div id={descId} className="my-4 text-[13px] leading-relaxed text-muted-foreground">
          {message}
        </div>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="press border border-border px-4 py-2 font-sans text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground hover:border-[var(--foreground)] hover:text-foreground"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={`press border px-4 py-2 font-sans text-[11px] font-medium uppercase tracking-[0.14em] hover:opacity-90 ${
              tone === 'danger'
                ? 'border-[var(--destructive)] bg-[var(--destructive)] text-[var(--destructive-foreground)]'
                : 'border-[var(--primary)] bg-[var(--primary)] text-primary-foreground'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    container ?? document.body,
  )
}

export function CloseButton({ onClick, label = 'Close' }: { onClick: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-keyshortcuts="Escape"
      className="press inline-flex size-8 shrink-0 items-center justify-center border border-border bg-background text-muted-foreground transition-colors hover:border-[var(--foreground)] hover:text-foreground"
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square">
        <path d="m4 4 8 8M12 4l-8 8" />
      </svg>
    </button>
  )
}
