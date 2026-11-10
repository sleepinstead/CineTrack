import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type ToastKind = 'info' | 'success' | 'warning' | 'error'
type ToastAction = { label: string; onAction: () => void }
type ToastOptions = { action?: ToastAction; duration?: number }
type Toast = { id: number; message: string; kind: ToastKind; leaving: boolean; action?: ToastAction; duration: number }
type Ctx = { toast: (message: string, kind?: ToastKind, options?: ToastOptions) => void }

const ToastCtx = createContext<Ctx>({ toast: () => {} })

const MAX_VISIBLE = 4
const EXIT_MS = 180
/** Errors and actionable toasts stay longer (WCAG 2.2.1: enough time to read and act). */
function defaultDuration(kind: ToastKind, hasAction: boolean) {
  if (hasAction) return 7000
  return kind === 'error' || kind === 'warning' ? 6000 : 3200
}

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timers = useRef(new Map<number, number>())
  const paused = useRef(false)
  const latest = useRef<Toast[]>([])
  latest.current = toasts

  const clearTimer = useCallback((id: number) => {
    const timer = timers.current.get(id)
    if (timer != null) window.clearTimeout(timer)
    timers.current.delete(id)
  }, [])

  const dismiss = useCallback((id: number) => {
    clearTimer(id)
    setToasts((list) => list.map((item) => (item.id === id ? { ...item, leaving: true } : item)))
    window.setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), EXIT_MS)
  }, [clearTimer])

  const schedule = useCallback((id: number, duration: number) => {
    clearTimer(id)
    timers.current.set(id, window.setTimeout(() => dismiss(id), duration))
  }, [clearTimer, dismiss])

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => window.clearTimeout(timer))
      pending.clear()
    }
  }, [])

  const toast = useCallback((message: string, kind: ToastKind = 'info', options: ToastOptions = {}) => {
    const id = nextId++
    const duration = options.duration ?? defaultDuration(kind, !!options.action)
    // Drop the oldest beyond the cap so a burst can't cover the screen.
    const overflow = latest.current.length + 1 - MAX_VISIBLE
    for (const old of latest.current.slice(0, Math.max(0, overflow))) clearTimer(old.id)
    setToasts((list) => [...list, { id, message, kind, leaving: false, action: options.action, duration }].slice(-MAX_VISIBLE))
    if (!paused.current) schedule(id, duration)
  }, [clearTimer, schedule])

  // Hovering or focusing the stack pauses every timer so nothing vanishes mid-read.
  const pause = useCallback(() => {
    paused.current = true
    timers.current.forEach((timer) => window.clearTimeout(timer))
    timers.current.clear()
  }, [])
  const resume = useCallback(() => {
    paused.current = false
    for (const item of latest.current) if (!item.leaving) schedule(item.id, Math.min(item.duration, 2500))
  }, [schedule])

  const value = useMemo(() => ({ toast }), [toast])
  const visible = toasts.filter((t) => !t.leaving)

  return (
    <ToastCtx.Provider value={value}>
      {children}
      {createPortal(
        <>
          {/* Persistent live regions: screen readers announce text added to an
              existing region far more reliably than a freshly mounted one. */}
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="false">
            {visible.filter((t) => t.kind !== 'error').map((t) => <p key={t.id}>{t.message}</p>)}
          </div>
          <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="false">
            {visible.filter((t) => t.kind === 'error').map((t) => <p key={t.id}>{t.message}</p>)}
          </div>
          <div
            className="pointer-events-none fixed inset-x-0 bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-[110] flex flex-col items-center gap-2 px-4"
            onMouseEnter={pause}
            onMouseLeave={resume}
            onFocus={pause}
            onBlur={resume}
          >
            {toasts.map((t) => (
              <div
                key={t.id}
                data-kind={t.kind}
                data-leaving={t.leaving || undefined}
                className="toast-item pointer-events-auto flex max-w-[min(92vw,560px)] items-center gap-3 py-2 pl-5 pr-2 font-sans text-[12px] font-medium uppercase tracking-[0.14em]"
              >
                <span className="min-w-0 flex-1 py-0.5">{t.message}</span>
                {t.action && (
                  <button
                    type="button"
                    onClick={() => {
                      t.action?.onAction()
                      dismiss(t.id)
                    }}
                    className="press shrink-0 border border-current px-2.5 py-1 text-[11px] font-semibold tracking-[0.14em] hover:opacity-80"
                  >
                    {t.action.label}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss notification"
                  className="press flex h-6 w-6 shrink-0 items-center justify-center opacity-70 hover:opacity-100"
                >
                  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square">
                    <path d="m4 4 8 8M12 4l-8 8" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </>,
        document.body,
      )}
    </ToastCtx.Provider>
  )
}

export function useToast() {
  return useContext(ToastCtx)
}
