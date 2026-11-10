import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { activityByMonth, type Entry } from '../lib/library'
import { monotoneSegments, type Point } from '../lib/curve'
import { Empty, SectionHead } from './ui'

const HEIGHT = 220
const PAD = { top: 30, right: 16, bottom: 12, left: 24 }

type Month = { key: string; label: string; year: number; count: number; current: boolean }

function monthsFrom(entries: Entry[]): Month[] {
  const now = new Date()
  const currentKey = `${now.getFullYear()}-${now.getMonth()}`
  return activityByMonth(entries, 12).map((m) => ({
    key: m.month,
    label: m.label,
    year: Number(m.month.split('-')[0]),
    count: m.count,
    current: m.month === currentKey,
  }))
}

/** A round top for the scale: 15 → 16, 7 → 8, 3 → 4. Always even so the midline is whole. */
function niceMax(max: number): number {
  const step = max <= 4 ? 2 : max <= 10 ? 2 : max <= 20 ? 4 : max <= 50 ? 10 : 20
  return Math.max(step, Math.ceil(max / step) * step)
}

function Figure({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="min-w-0">
      <dt className="rule-label">{label}</dt>
      <dd className="mt-1 font-display text-[26px] leading-none tabular-nums text-foreground">
        {value}
        {unit && <span className="ml-1.5 font-sans text-[11px] text-muted-foreground">{unit}</span>}
      </dd>
    </div>
  )
}

export default function MonthlyChart({ entries }: { entries: Entry[] }) {
  const months = useMemo(() => monthsFrom(entries), [entries])
  const total = months.reduce((sum, m) => sum + m.count, 0)
  const peak = months.reduce((a, b) => (b.count > a.count ? b : a), months[0]!)
  const average = total / months.length
  const averageLabel = average >= 10 ? Math.round(average).toString() : average.toFixed(1).replace(/\.0$/, '')

  const boxRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [active, setActive] = useState<number | null>(null)
  const gradientId = useId().replace(/:/g, '')

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)))
    observer.observe(el)
    return () => observer.disconnect()
  }, [total])

  const top = niceMax(peak.count)
  const plotW = Math.max(0, width - PAD.left - PAD.right)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const points: Point[] = months.map((m, i) => ({
    x: PAD.left + (months.length > 1 ? (i / (months.length - 1)) * plotW : plotW / 2),
    y: PAD.top + plotH - (m.count / top) * plotH,
  }))
  const segments = monotoneSegments(points)
  const start = points[0]
  const baseline = PAD.top + plotH
  const hasCurrent = months[months.length - 1]?.current === true
  // The month in progress is drawn dashed: it is still filling up.
  const solid = start ? `M${start.x},${start.y}${segments.slice(0, hasCurrent ? -1 : undefined).join('')}` : ''
  const partial = hasCurrent && points.length > 1 ? `M${points[points.length - 2]!.x},${points[points.length - 2]!.y}${segments[segments.length - 1]}` : ''
  const area = start ? `M${start.x},${baseline}L${start.x},${start.y}${segments.join('')}L${points[points.length - 1]!.x},${baseline}Z` : ''
  const peakIndex = months.findIndex((m) => m.key === peak.key)

  // Keep the keyboard cursor valid if the data changes underneath it.
  useEffect(() => {
    if (active != null && active >= months.length) setActive(null)
  }, [active, months.length])

  const pick = (clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect()
    if (!box || plotW <= 0) return
    const ratio = (clientX - box.left - PAD.left) / plotW
    setActive(Math.min(months.length - 1, Math.max(0, Math.round(ratio * (months.length - 1)))))
  }

  const shown = active ?? null
  const tip = shown != null ? points[shown] : null
  const tipMonth = shown != null ? months[shown] : null

  return (
    <section aria-labelledby="monthly-log-summary">
      <SectionHead
        title="Monthly log"
        note="Titles completed in each of the last twelve months."
        rule={false}
        right={
          total > 0 ? (
            <dl className="grid grid-cols-3 gap-6 sm:gap-8 sm:text-right">
              <Figure label="Total" value={total} />
              <Figure label="Monthly avg" value={averageLabel} />
              <Figure label="Busiest" value={peak.label} unit={`${peak.count} titles`} />
            </dl>
          ) : undefined
        }
      />

      {total === 0 ? (
        <Empty>No completions in the last twelve months — finished titles will chart here</Empty>
      ) : (
        <div className="pt-1">
          <div
            ref={boxRef}
            tabIndex={0}
            role="img"
            aria-label={`Area chart of titles completed per month. ${total} in total; busiest ${peak.label} ${peak.year} with ${peak.count}. Use the arrow keys to read each month.`}
            onPointerMove={(e) => pick(e.clientX)}
            onPointerLeave={() => setActive(null)}
            onBlur={() => setActive(null)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault()
                const step = e.key === 'ArrowRight' ? 1 : -1
                setActive((i) => Math.min(months.length - 1, Math.max(0, (i ?? (step > 0 ? -1 : months.length)) + step)))
              } else if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault()
                setActive(e.key === 'Home' ? 0 : months.length - 1)
              } else if (e.key === 'Escape') setActive(null)
            }}
            className="relative cursor-crosshair outline-offset-2 touch-pan-y"
            style={{ height: HEIGHT }}
          >
            {width > 0 && (
              <svg width={width} height={HEIGHT} className="block overflow-visible" aria-hidden="true">
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.24" />
                    <stop offset="70%" stopColor="var(--primary)" stopOpacity="0.06" />
                    <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
                  </linearGradient>
                </defs>

                {/* Scale: baseline, midline and top, labelled at the left. */}
                {[0, top / 2, top].map((tick) => {
                  const y = PAD.top + plotH - (tick / top) * plotH
                  return (
                    <g key={tick}>
                      <line
                        x1={PAD.left}
                        x2={width - PAD.right}
                        y1={y}
                        y2={y}
                        stroke="var(--border)"
                        strokeDasharray={tick === 0 ? undefined : '2 4'}
                      />
                      <text x={0} y={y} dy="0.32em" textAnchor="start" className="fill-[var(--muted-foreground)] font-sans text-[10px] tabular-nums">
                        {tick}
                      </text>
                    </g>
                  )
                })}

                <path d={area} fill={`url(#${gradientId})`} className="animate-fade" />
                <path
                  d={solid}
                  fill="none"
                  stroke="var(--primary)"
                  strokeWidth={2.25}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  pathLength={1}
                  className="chart-draw"
                />
                {partial && (
                  <path d={partial} fill="none" stroke="var(--primary)" strokeWidth={2.25} strokeLinecap="round" strokeDasharray="1 6" className="animate-fade" />
                )}

                {/* The busiest month is called out; the rest show on hover. */}
                {peak.count > 0 && points[peakIndex] && shown !== peakIndex && (
                  <g className="animate-fade">
                    <circle cx={points[peakIndex]!.x} cy={points[peakIndex]!.y} r={4} fill="var(--primary)" stroke="var(--background)" strokeWidth={2} />
                    <text
                      x={points[peakIndex]!.x}
                      y={points[peakIndex]!.y - 12}
                      textAnchor="middle"
                      className="fill-[var(--primary)] font-display text-[18px] tabular-nums"
                    >
                      {peak.count}
                    </text>
                  </g>
                )}

                {tip && (
                  <g>
                    <line x1={tip.x} x2={tip.x} y1={PAD.top - 6} y2={baseline} stroke="var(--foreground)" strokeOpacity={0.18} />
                    <circle cx={tip.x} cy={tip.y} r={5} fill="var(--background)" stroke="var(--primary)" strokeWidth={2.25} />
                  </g>
                )}
              </svg>
            )}

            {tip && tipMonth && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full border border-border bg-background px-3 py-2 shadow-[var(--shadow-pop)]"
                style={{
                  left: Math.min(Math.max(tip.x, 64), width - 64),
                  top: Math.max(tip.y - 14, 56),
                }}
              >
                <div className="font-display text-[24px] leading-none tabular-nums text-foreground">{tipMonth.count}</div>
                <div className="rule-label mt-1 whitespace-nowrap">
                  {tipMonth.label} {tipMonth.year} · {tipMonth.count === 1 ? 'title' : 'titles'}
                  {tipMonth.current ? ' so far' : ''}
                </div>
              </div>
            )}
          </div>

          {/* Month axis, aligned to the points; a year mark where the year turns. */}
          <div aria-hidden="true" className="relative mt-1 h-8">
            {months.map((m, i) => {
              const showYear = i === 0 || m.key.endsWith('-0')
              return (
                <div
                  key={m.key}
                  className="absolute top-0 -translate-x-1/2 text-center leading-tight"
                  style={{ left: points[i]?.x ?? 0 }}
                >
                  <span
                    className={`block font-sans text-[10px] uppercase tracking-[0.1em] transition-colors ${
                      shown === i ? 'text-foreground' : m.current ? 'text-foreground' : 'text-muted-foreground'
                    } ${i % 2 === 1 ? 'max-sm:hidden' : ''}`}
                  >
                    {m.label}
                  </span>
                  <span className="block font-sans text-[9px] tabular-nums text-muted-foreground opacity-70">
                    {m.current ? 'so far' : showYear ? `’${String(m.year).slice(-2)}` : ' '}
                  </span>
                </div>
              )
            })}
          </div>

          <div id="monthly-log-summary" className="sr-only">
            <p>
              Monthly log: {total} titles completed in the last twelve months, an average of {averageLabel} a month. Busiest month: {peak.label} {peak.year}, with {peak.count}.
            </p>
            <ul>
              {months.map((m) => (
                <li key={m.key}>
                  {m.label} {m.year}: {m.count} {m.count === 1 ? 'title' : 'titles'}{m.current ? ' so far' : ''}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  )
}
