import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { importSettings, LANGUAGES, settingsForBackup, useSettings } from '../lib/settings'
import { buildBackup, entryKey, loggedEpisodeCount, MAX_LIBRARY_FILE_BYTES, minutesWatched, parseLibraryImport, useLibrary, useLibraryStatus } from '../lib/library'
import { CloseButton, ConfirmDialog, SETTINGS_PANEL_ID, handleRadioGroupKeyDown, useBodyScrollLock, useFocusTrap } from './ui'
import { useToast } from './Toast'
import ThemeToggle from './ThemeToggle'

export default function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings, set } = useSettings()
  const { entries, replaceAll, importEntries, clear } = useLibrary()
  const { hydrated } = useLibraryStatus()
  const { toast } = useToast()
  const [confirmWipe, setConfirmWipe] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const [shown, setShown] = useState(false)
  useFocusTrap(panelRef, open)

  // Because this panel is lazy-mounted the first time it opens, its closed pose
  // (offscreen to the right) must paint before `data-open` flips — otherwise the
  // browser has no starting frame to transition from on that very first open.
  // Two rAFs: the first lets the resting pose be committed on screen, the second
  // latches `shown` so the slide-in runs from a painted start. Exit mirrors via
  // `shown` dropping to false while the sheet stays mounted.
  useEffect(() => {
    if (!open) {
      setShown(false)
      return
    }
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setShown(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [open])


  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  useBodyScrollLock(open)

  useEffect(() => {
    if (!open) setConfirmWipe(false)
  }, [open])

  const exportLibrary = () => {
    try {
      const blob = new Blob([buildBackup(entries, settingsForBackup())], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `cinetrack-backup-${new Date().toISOString().slice(0, 10)}.json`
      try {
        document.body.append(anchor)
        anchor.click()
      } finally {
        anchor.remove()
        // Let the browser start reading the Blob before releasing its URL.
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
      toast(`Backup of ${entries.length} title${entries.length === 1 ? '' : 's'} downloaded`, 'success')
    } catch {
      toast('Export failed — try again', 'error')
    }
  }

  const importLibrary = async (file: File) => {
    if (!hydrated) {
      toast('Your library is still loading — try again in a moment', 'warning')
      return
    }
    if (file.size > MAX_LIBRARY_FILE_BYTES) {
      toast('That file is larger than the 80 MB import limit', 'error')
      return
    }
    try {
      const text = await file.text()
      // Merge against the live library at commit time, not the `entries` this
      // render saw: the library may have changed while the file was read.
      const result = parseLibraryImport(text, [])
      const { imported, combined } = importEntries(result.entries)
      const restoredSettings = result.settings ? importSettings(result.settings) : false
      const parts = [
        `${imported} new title${imported === 1 ? '' : 's'}`,
        combined ? `${combined} merged` : null,
        result.skipped ? `${result.skipped} skipped` : null,
        restoredSettings ? 'settings restored' : null,
      ].filter(Boolean)
      toast(`Imported: ${parts.join(', ')}`, result.skipped ? 'warning' : 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That file could not be read', 'error')
    }
  }

  const eraseLibrary = () => {
    const erased = clear()
    setConfirmWipe(false)
    if (erased.length === 0) return
    toast(`Erased ${erased.length} title${erased.length === 1 ? '' : 's'}`, 'warning', {
      action: {
        label: 'Undo',
        onAction: () => replaceAll(Object.fromEntries(erased.map((entry) => [entryKey(entry.mediaType, entry.id), entry]))),
      },
    })
  }

  const counts = {
    movie: entries.filter((e) => e.mediaType === 'movie').length,
    tv: entries.filter((e) => e.mediaType === 'tv').length,
    total: entries.length,
  }

  const episodes = entries.reduce((s, e) => s + loggedEpisodeCount(e), 0)
  const minutes = minutesWatched(entries)
  const hours = Math.round(minutes / 60)

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={`fixed inset-0 z-50 bg-[var(--scrim-soft)] transition-opacity duration-[var(--dur-quick)] ${
          shown ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
        data-open={shown}
      />
      <aside
        ref={panelRef}
        id={SETTINGS_PANEL_ID}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        inert={!open}
        style={{ scrollPaddingTop: '4rem' }}
        className="drawer-sheet quiet-scroll fixed right-0 top-0 z-50 h-full w-full max-w-[400px] overflow-y-auto border-l border-border bg-background"
        data-open={shown}
      >
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-background/95 px-5 py-3 backdrop-blur">
          <h2 id="settings-title" className="font-display text-[24px] italic leading-none">Settings</h2>
          <CloseButton onClick={onClose} label="Close settings" />
        </header>

        <div className="divide-y divide-border">
          <Section title="Appearance">
            <Row label="Theme" hint={settings.theme === 'system' ? 'Matches your system' : settings.theme === 'noir' ? 'Dark' : 'Light'}>
              <ThemeToggle value={settings.theme} onChange={(theme) => set('theme', theme)} />
            </Row>
            <SwitchRow label="Compact density" value={settings.density === 'compact'} onChange={(v) => set('density', v ? 'compact' : 'comfortable')} />
            <SwitchRow label="Rounded posters" value={settings.roundPosters} onChange={(v) => set('roundPosters', v)} />
            <SwitchRow label="Poster motion" hint="Lift and tilt on hover" value={settings.posterMotion} onChange={(v) => set('posterMotion', v)} />
            <SwitchRow label="Shortcut hints" value={settings.showNavHints} onChange={(v) => set('showNavHints', v)} />
          </Section>

          <Section title="Layout">
            <Row label="Library per row">
              <Stepper label="Library items per row" value={settings.libraryColumns} onChange={(v) => set('libraryColumns', v)} />
            </Row>
            <Row label="Discover per row">
              <Stepper label="Discover items per row" value={settings.discoverColumns} onChange={(v) => set('discoverColumns', v)} />
            </Row>
          </Section>

          <Section title="Tracking">
            <Row label="New titles start as">
              <Segmented
                label="Default status for new titles"
                value={settings.defaultStatus}
                options={[
                  { id: 'planned', label: 'Planned' },
                  { id: 'watching', label: 'Watching' },
                ]}
                onChange={(v) => set('defaultStatus', v)}
              />
            </Row>
            <SwitchRow
              label="Finish series automatically"
              hint="Mark Watched when the last episode is"
              value={settings.autoCompleteSeries}
              onChange={(v) => set('autoCompleteSeries', v)}
            />
            <SwitchRow label="Hide episode descriptions" value={settings.hideSpoilers} onChange={(v) => set('hideSpoilers', v)} />
            <SwitchRow label="Episode covers" value={!settings.hideEpisodeCovers} onChange={(v) => set('hideEpisodeCovers', !v)} />
            <SwitchRow label="Show specials" value={settings.showSpecials} onChange={(v) => set('showSpecials', v)} />
          </Section>

          <Section title="Search">
            <Row label="Metadata language">
              <Select
                label="Metadata language"
                value={settings.metadataLanguage}
                options={LANGUAGES.map((l) => ({ id: l.id, label: l.label }))}
                onChange={(v) => set('metadataLanguage', v)}
              />
            </Row>
            <SwitchRow label="Community scores" hint="IMDb averages beside the year" value={settings.showCommunityScores} onChange={(v) => set('showCommunityScores', v)} />
            <SwitchRow label="Adult titles" hint="In search and Discover" value={settings.includeAdult} onChange={(v) => set('includeAdult', v)} />
          </Section>

          <Section title="Data">
            <p className="pb-3 pt-1 text-[12px] leading-relaxed text-muted-foreground">
              <span className="tabular-nums text-foreground">{counts.total}</span> titles · <span className="tabular-nums">{counts.movie}</span> films ·{' '}
              <span className="tabular-nums">{counts.tv}</span> series · <span className="tabular-nums">{episodes}</span> episodes ·{' '}
              <span className="tabular-nums">{hours}</span> hrs
            </p>
            <div className="grid grid-cols-2 gap-2">
              <ActionButton onClick={exportLibrary}>Export backup</ActionButton>
              <ActionButton disabled={!hydrated} onClick={() => fileRef.current?.click()}>
                Restore backup
              </ActionButton>
              <input
                ref={fileRef}
                type="file"
                tabIndex={-1}
                aria-hidden="true"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void importLibrary(file)
                  event.target.value = ''
                }}
              />
            </div>
            <p className="pt-2 text-[11px] leading-relaxed text-muted-foreground">Restoring merges into your library; nothing is deleted.</p>
            <Row label="Erase library" hint="You can undo right after">
              <ActionButton tone="danger" disabled={!hydrated || entries.length === 0} onClick={() => setConfirmWipe(true)}>
                Erase…
              </ActionButton>
            </Row>
          </Section>
        </div>

        <ConfirmDialog
          open={confirmWipe}
          title="Erase entire library?"
          message={
            <span>
              This deletes all <strong>{entries.length}</strong> titles, ratings and logged episodes from your local database.
              You can undo right afterwards; to keep a copy, export a backup first.
            </span>
          }
          confirmLabel="Erase library"
          onCancel={() => setConfirmWipe(false)}
          onConfirm={eraseLibrary}
        />
      </aside>
    </>
  )
}

/* ------------------------------------------------------------------
   Compact settings controls: one row per setting, label left, control
   right. Every control is keyboard operable and labelled.
   ------------------------------------------------------------------ */

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="px-5 py-4">
      <div className="mb-1.5 flex min-h-6 items-center justify-between gap-3">
        <h3 className="rule-label">{title}</h3>
        {aside}
      </div>
      <div>{children}</div>
    </section>
  )
}

function Label({ label, hint, id }: { label: string; hint?: string; id?: string }) {
  return (
    <span className="min-w-0">
      <span id={id} className="block text-[13px] leading-snug text-foreground">{label}</span>
      {hint && <span className="block text-[11px] leading-snug text-muted-foreground">{hint}</span>}
    </span>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 py-1">
      <Label label={label} hint={hint} />
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** The whole row is the switch, so it is an easy target on touch screens. */
function SwitchRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className="group flex min-h-10 w-full items-center justify-between gap-4 py-1 text-left"
    >
      <Label label={label} hint={hint} />
      <span
        aria-hidden="true"
        className={`relative block h-[18px] w-8 shrink-0 border transition-colors ${
          value ? 'border-[var(--primary)] bg-[var(--primary)]' : 'border-[var(--input)] bg-secondary group-hover:border-foreground'
        }`}
      >
        <span
          className={`absolute left-0 top-[2px] block h-3 w-3 transition-transform duration-200 ${
            value ? 'translate-x-[16px] bg-[var(--primary-foreground)]' : 'translate-x-[2px] bg-[var(--muted-foreground)]'
          }`}
        />
      </span>
    </button>
  )
}

/** A small segmented control for two or three choices. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} onKeyDown={handleRadioGroupKeyDown} className="inline-flex gap-0.5 border border-border bg-muted p-0.5">
      {options.map((o) => {
        const active = value === o.id
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.id)}
            className={`press h-7 min-w-8 px-2.5 font-sans text-[11px] font-medium transition-colors focus-visible:outline-offset-[-2px] ${
              active
                ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-border'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** A compact native select, for choices that would not fit as segments. */
function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { id: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <span className="relative inline-block">
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-8 max-w-[170px] cursor-pointer appearance-none border border-border bg-background pl-2.5 pr-7 text-[12px] text-foreground outline-none hover:border-foreground focus-visible:border-[var(--primary)]"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground">
        <path d="m7 10 5 5 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}

/** − value + for a bounded count. */
function Stepper({
  label,
  value,
  min = 3,
  max = 10,
  onChange,
}: {
  label: string
  value: number
  min?: number
  max?: number
  onChange: (v: number) => void
}) {
  const valueId = useId()
  const step = (delta: number) => onChange(Math.min(max, Math.max(min, value + delta)))
  const button = 'press flex size-8 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35'
  return (
    <div role="group" aria-label={label} className="inline-flex items-center border border-border">
      <button type="button" aria-label={`Fewer: ${label}`} aria-describedby={valueId} disabled={value <= min} onClick={() => step(-1)} className={button}>
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
          <path d="M3.5 8h9" />
        </svg>
      </button>
      <span id={valueId} aria-live="polite" className="w-7 text-center font-sans text-[13px] font-medium tabular-nums text-foreground">
        {value}
      </span>
      <button type="button" aria-label={`More: ${label}`} aria-describedby={valueId} disabled={value >= max} onClick={() => step(1)} className={button}>
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
          <path d="M3.5 8h9M8 3.5v9" />
        </svg>
      </button>
    </div>
  )
}

function ActionButton({
  children,
  onClick,
  disabled,
  tone = 'default',
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  tone?: 'default' | 'danger'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`press h-8 border px-3 font-sans text-[11px] font-medium uppercase tracking-[0.12em] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        tone === 'danger'
          ? 'border-[var(--destructive)] text-[var(--destructive)] hover:bg-[var(--destructive)] hover:text-[var(--destructive-foreground)]'
          : 'border-border text-foreground hover:border-foreground'
      }`}
    >
      {children}
    </button>
  )
}
