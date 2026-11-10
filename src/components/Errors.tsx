import type { ReactNode } from 'react'

/**
 * The app's only error and not-found surface: one slim strip with a red left
 * edge, a bold title, the reason, and small actions. Everything uses it.
 *
 *   ErrorNotice  the strip itself; used inline where part of a view failed
 *   ErrorState   a whole page, drawer or overlay failed: the strip, placed
 *   NotFound     the thing asked for does not exist: the strip, placed
 */

export type ErrorAction = { label: string; onClick: () => void; disabled?: boolean }

const ACTION =
  'press shrink-0 border border-border px-3 py-1.5 font-sans text-[10px] font-medium uppercase tracking-[0.14em] text-foreground hover:border-[var(--foreground)] disabled:cursor-wait disabled:opacity-60'

export function ErrorNotice({
  title,
  message,
  onRetry,
  retryLabel = 'Retry',
  busy = false,
  actions,
  role = 'alert',
  bleed = false,
  className = '',
}: {
  title: string
  message?: ReactNode
  onRetry?: () => void
  retryLabel?: string
  busy?: boolean
  /** Buttons to show instead of the single Retry. */
  actions?: ErrorAction[]
  /** `status` for not-found, which is announced politely rather than as an alert. */
  role?: 'alert' | 'status'
  /** Edge to edge, for the app-wide banner under the header. */
  bleed?: boolean
  className?: string
}) {
  const buttons = actions ?? (onRetry ? [{ label: retryLabel, onClick: onRetry, disabled: busy }] : [])
  return (
    <div
      role={role}
      className={`animate-fade flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-card ${
        bleed ? 'border-b border-border px-4 py-2.5 lg:px-6' : 'border border-border px-4 py-3'
      } border-l-2 border-l-[var(--destructive)] ${className}`}
    >
      <p className="min-w-0 flex-1 text-[13px] leading-snug">
        <span className="font-medium text-foreground">{title}</span>
        {message && <span className="text-muted-foreground"> · {message}</span>}
      </p>
      {buttons.length > 0 && (
        <div className="flex shrink-0 flex-wrap gap-2">
          {buttons.map((action) => (
            <button key={action.label} type="button" onClick={action.onClick} disabled={action.disabled} className={ACTION}>
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Spacing around a strip that stands in for a whole page or a drawer's body. */
const PLACEMENT = { page: 'w-full py-4', panel: 'w-full p-4 sm:p-6' } as const

/** A whole page, drawer or overlay could not be shown. */
export function ErrorState({
  title,
  message,
  actions,
  reference,
  details,
  size = 'page',
}: {
  title: string
  message?: ReactNode
  actions: ErrorAction[]
  /** A support reference such as an error id, shown small under the strip. */
  reference?: string
  /** Extra diagnostic content (e.g. a stack trace in development). */
  details?: ReactNode
  /** `page` sits in a main view; `panel` inside a drawer or dialog. */
  size?: 'page' | 'panel'
}) {
  return (
    <div className={PLACEMENT[size]}>
      <ErrorNotice title={title} message={message} actions={actions} />
      {details}
      {reference && <p className="mt-2 font-sans text-[11px] tabular-nums text-muted-foreground">{reference}</p>}
    </div>
  )
}

/** Nothing exists at this address. */
export function NotFound({
  title,
  message,
  actions,
  size = 'page',
}: {
  title: string
  message?: ReactNode
  actions: ErrorAction[]
  size?: 'page' | 'panel'
}) {
  return (
    <div className={PLACEMENT[size]}>
      <ErrorNotice role="status" title={title} message={message} actions={actions} />
    </div>
  )
}
