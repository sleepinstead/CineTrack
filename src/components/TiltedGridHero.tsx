import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'

/* ── the curved row ──────────────────────────────────────────────
 * Adapted from the "Tilted Grid Hero" component. One row of images streams
 * from right to left around the inside of a cylinder: the centre faces you
 * flat, the ends bend toward you, and the ends fade into the page.
 *
 * A CSS box can't bend, so each tile is cut into `slices` vertical facets,
 * each turned its own few degrees round the cylinder's axis; the tile
 * (preserve-3d) is what moves, one rotateY about that axis.
 *
 * Performance: every length is measured once in pixels and each tile is
 * driven by the Web Animations API with plain pixel/degree keyframes. That
 * keeps the motion on the compositor (no per-frame main-thread style work,
 * which keyframes reading CSS variables and container units forced), and
 * needs no injected <style>, which the production CSP forbids. All tiles
 * share one clock, so their spacing never drifts after a resize.
 * ─────────────────────────────────────────────────────────────── */

const CAMERA = 1.6
const MAX_WIDTH = 55

/** Cylinder radius, as a share of width, that puts the frame's edge `bend` radians round the arc. */
function arc(bend: number) {
  return (CAMERA - 1 + Math.cos(bend)) / (2 * CAMERA * Math.sin(bend))
}

type Layout = { width: number; height: number; tile: number; radius: number; columns: number; sweep: number; unit: number }

function measure(width: number, height: number, tilePct: number, aspect: number, gap: number, bend: number): Layout | null {
  const tile = Math.min((tilePct / 100) * height, ((MAX_WIDTH / 100) * width) / aspect)
  const radius = width * arc(bend)
  if (!(tile > 0) || !(radius > 0)) return null
  const deg = (rad: number) => (rad * 180) / Math.PI
  const unit = deg(tile / radius)
  const pitch = (aspect + gap / 100) * unit
  const limit = deg(bend) + (aspect * unit) / 2
  // Capped so a hero squeezed to a sliver can't mount thousands of tiles.
  const columns = Math.min(60, Math.max(2, Math.ceil((2 * limit) / pitch)))
  return { width, height, tile, radius, columns, sweep: (columns * pitch) / 2, unit }
}

export type TiltedGridImage = { src: string; alt?: string }

export type TiltedGridHeroProps = {
  /** Images run along the row in order; a tile takes its next one each time it wraps out of sight. */
  images: TiltedGridImage[]
  /** Seconds for the row to advance by one tile. @default 4 */
  speed?: number
  /** Tile height, as a percentage of the hero's height. @default 26 */
  tileHeight?: number
  /** Tile width divided by tile height. @default 16 / 9 */
  aspectRatio?: number
  /** Space between tiles, as a percentage of a tile's height. @default 6 */
  gap?: number
  /** Vertical centre of the row, as a percentage of the hero's height. @default 56 */
  axis?: number
  /** How far the row bends round by the frame's edge, in degrees (5–85). @default 80 */
  curve?: number
  /** Width of the fade at each end, as a percentage of the hero's width. @default 12 */
  fade?: number
  /** Flat facets per tile: more bends wide tiles more smoothly; each is a 3D layer. @default 6 */
  slices?: number
  children?: ReactNode
  className?: string
}

const round = (n: number) => Math.round(n * 100) / 100

export function TiltedGridHero({
  images,
  speed = 4,
  tileHeight = 26,
  aspectRatio = 16 / 9,
  gap = 6,
  axis = 56,
  curve = 80,
  fade = 12,
  slices = 6,
  children,
  className = '',
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & TiltedGridHeroProps) {
  const ref = useRef<HTMLDivElement>(null)
  const tileRefs = useRef<(HTMLDivElement | null)[]>([])
  const bend = (Math.min(85, Math.max(5, curve)) * Math.PI) / 180
  const facets = Math.max(1, Math.round(slices))

  // Null until measured; the band stays hidden so a wrong first layout never shows.
  const [layout, setLayout] = useState<Layout | null>(null)
  // How many times each tile has wrapped, which picks its image. Changes only out of sight.
  const [laps, setLaps] = useState<number[]>([])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (width: number, height: number) => {
      const next = measure(Math.round(width), Math.round(height), tileHeight, aspectRatio, gap, bend)
      setLayout((prev) =>
        prev && next && prev.width === next.width && prev.height === next.height && prev.columns === next.columns ? prev : next,
      )
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width, entry.contentRect.height)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [tileHeight, aspectRatio, gap, bend])

  const durationMs = (layout?.columns ?? 0) * speed * 1000

  // One compositor animation per tile, all on the document timeline's origin.
  useEffect(() => {
    if (!layout || durationMs <= 0) return
    const { radius, sweep, columns } = layout
    const turn = (deg: number) => `translateZ(${round(radius)}px) rotateY(${round(deg)}deg) translateZ(${round(-radius)}px)`
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const animations: Animation[] = []
    for (let t = 0; t < columns; t++) {
      const tile = tileRefs.current[t]
      if (!tile) continue
      const animation = tile.animate([{ transform: turn(-sweep) }, { transform: turn(sweep) }], {
        duration: durationMs,
        delay: -t * speed * 1000,
        iterations: Infinity,
        easing: 'linear',
      })
      // Reduced motion: hold every tile at its place on the arc, a still row.
      if (reduce) {
        animation.pause()
        animation.currentTime = 0
      } else {
        animation.startTime = 0
      }
      animations.push(animation)
    }
    return () => {
      for (const animation of animations) animation.cancel()
    }
  }, [layout, durationMs, speed])

  // Hand each tile its next image once it has wrapped. Checked a couple of
  // times per tile step (seconds apart), never per frame.
  useEffect(() => {
    if (!layout || durationMs <= 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const tick = () => {
      const now = Number(document.timeline.currentTime ?? 0)
      const next = Array.from({ length: layout.columns }, (_, t) => Math.floor((now + t * speed * 1000) / durationMs))
      setLaps((prev) => (prev.length === next.length && prev.every((v, i) => v === next[i]) ? prev : next))
    }
    tick()
    const timer = window.setInterval(tick, Math.max(500, speed * 500))
    return () => window.clearInterval(timer)
  }, [layout, durationMs, speed])

  // Fetch every image up front: a tile picks up its next one just before it returns.
  useEffect(() => {
    for (const { src } of images) new Image().src = src
  }, [images])

  const geometry = useMemo(() => {
    if (!layout) return null
    const h = layout.tile
    const w = h * aspectRatio
    const share = w / facets
    const radius = layout.radius
    const turn = (deg: number) => `translateZ(${round(radius)}px) rotateY(${round(deg)}deg) translateZ(${round(-radius)}px)`
    return {
      h,
      w,
      share,
      left: round(layout.width / 2 - w / 2),
      top: round((axis / 100) * layout.height - h / 2),
      facetTransform: (k: number) => (facets === 1 ? undefined : turn(((w / 2 - (k + 0.5) * share) / h) * layout.unit)),
      perspective: round(radius * CAMERA),
    }
  }, [layout, aspectRatio, facets, axis])

  const columns = layout?.columns ?? 0

  return (
    <div
      ref={ref}
      className={`relative ${className}`}
      {...props}
      // Clipped on the sides only: tiles near the ends swing toward the camera
      // and grow taller than the band, so a vertical clip would crop them.
      style={{ overflowX: 'clip', overflowY: 'visible', ...props.style }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 transition-opacity duration-500"
        style={{
          opacity: geometry ? 1 : 0,
          perspective: geometry ? `${geometry.perspective}px` : undefined,
          perspectiveOrigin: `50% ${axis}%`,
        }}
      >
        {geometry &&
          Array.from({ length: columns }, (_, t) => {
            // Tile `columns - 1` starts nearest the exit, so this numbers tiles in arrival order.
            const first = columns - 1 - t
            const index = (laps[t] ?? 0) * columns + first
            const img = images.length ? images[index % images.length] : undefined
            return (
              <div
                key={t}
                ref={(node) => {
                  tileRefs.current[t] = node
                }}
                className="absolute"
                style={{
                  left: geometry.left,
                  top: geometry.top,
                  width: round(geometry.w),
                  height: round(geometry.h),
                  transformStyle: 'preserve-3d',
                  willChange: 'transform',
                }}
              >
                {Array.from({ length: facets }, (_, k) => (
                  <div
                    key={k}
                    className={`absolute top-0 bg-muted bg-no-repeat ${k === 0 ? 'rounded-l-[2px]' : ''} ${k === facets - 1 ? 'rounded-r-[2px]' : ''}`}
                    style={{
                      left: round((geometry.w - geometry.share) / 2),
                      // A pixel wider than its share so neighbouring facets overlap without a hairline.
                      width: round(k === facets - 1 ? geometry.share : geometry.share + 1),
                      height: round(geometry.h),
                      transform: geometry.facetTransform(k),
                      // One decoded image shared by every facet, offset to its own share.
                      backgroundImage: img ? `url("${img.src}")` : undefined,
                      backgroundSize: `${round(geometry.w)}px ${round(geometry.h)}px`,
                      backgroundPosition: `${round(-k * geometry.share)}px 0`,
                    }}
                  />
                ))}
              </div>
            )
          })}
      </div>

      {/* The ends fade into the page with two still overlays (a mask over a
          moving 3D subtree would force an offscreen render every frame).
          Taller than the band so they also cover end tiles that grow past it. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-y-1/2 left-0"
        style={{ width: `${fade}%`, background: 'linear-gradient(90deg, var(--background), transparent)' }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-y-1/2 right-0"
        style={{ width: `${fade}%`, background: 'linear-gradient(270deg, var(--background), transparent)' }}
      />

      {children}
    </div>
  )
}

export default TiltedGridHero
