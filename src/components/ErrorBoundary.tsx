import { Component, type ErrorInfo, type ReactNode } from 'react'
import { ErrorState } from './Errors'

/** A lazily loaded chunk failed to download (offline, or the app was rebuilt). */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /dynamically imported module|Importing a module script failed|Failed to fetch|error loading dynamically/i.test(message)
}

type Props = {
  children: ReactNode
  /** Changing this value clears a caught error (e.g. on navigation). */
  resetKey?: unknown
  /** Show the fallback as a dialog over the page (for drawers and overlays). */
  overlay?: boolean
  /** Close the failed overlay; offered as a second action. */
  onDismiss?: () => void
  label?: string
}
type State = { error: Error | null; errorId: string | null; resetKey: unknown }

/**
 * Contains a render failure to one region of the app. A failed code-split
 * download cannot be retried in place (browsers cache the failed import), so
 * "Try again" reloads the page in that case.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, errorId: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<State> {
    const suffix = Math.random().toString(36).slice(2, 8)
    return { error, errorId: `CT-${Date.now().toString(36)}-${suffix}` }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null, errorId: null }
    return null
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[CineTrack] ${this.props.label ?? 'view'} failed (${this.state.errorId ?? 'no id'})`, error, info.componentStack)
  }

  private retry = () => {
    if (isChunkLoadError(this.state.error)) window.location.reload()
    else this.setState({ error: null, errorId: null })
  }

  override render() {
    const { error, errorId } = this.state
    if (!error) return this.props.children
    const chunk = isChunkLoadError(error)
    const fallback = (
      <ErrorState
        size={this.props.overlay ? 'panel' : 'page'}
        title={chunk ? 'This part of CineTrack could not load' : 'Something went wrong'}
        message={
          chunk
            ? 'Check that the CineTrack server is still running, then reload.'
            : import.meta.env.DEV
              ? error.message
              : 'An unexpected error interrupted this view. Your library is safe.'
        }
        details={
          import.meta.env.DEV && !chunk && error.stack ? (
            <pre className="quiet-scroll mt-4 max-h-40 overflow-auto border border-border bg-muted p-3 text-[11px] text-muted-foreground">{error.stack}</pre>
          ) : undefined
        }
        actions={[
          { label: chunk ? 'Reload' : 'Try again', onClick: this.retry },
          this.props.overlay && this.props.onDismiss
            ? { label: 'Close', onClick: this.props.onDismiss }
            : { label: 'Reload page', onClick: () => window.location.reload() },
        ]}
        reference={`Error ID ${errorId} · If this keeps happening, export a backup from Settings.`}
      />
    )
    if (!this.props.overlay) return fallback
    return (
      <div className="fixed inset-0 z-[90] flex items-center justify-center bg-[var(--scrim)] p-4">
        <div role="dialog" aria-modal="true" aria-label="Error" className="w-full max-w-lg border border-border bg-background shadow-[var(--shadow-sheet)]">
          {fallback}
        </div>
      </div>
    )
  }
}
