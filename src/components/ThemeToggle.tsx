import type { ReactNode } from 'react'
import type { ThemePreference } from '../lib/theme'
import { handleRadioGroupKeyDown } from './ui'

const OPTIONS: { id: ThemePreference; label: string; icon: ReactNode }[] = [
  {
    id: 'paper',
    label: 'Light',
    icon: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </>
    ),
  },
  {
    id: 'noir',
    label: 'Dark',
    icon: <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />,
  },
  {
    id: 'system',
    label: 'System',
    icon: (
      <>
        <rect x="3" y="4" width="18" height="12" rx="1.5" />
        <path d="M8 20h8M12 16v4" />
      </>
    ),
  },
]

/**
 * Light / Dark / System as a compact icon switcher. The chosen option sits on
 * a raised neutral chip; names show as tooltips and to screen readers.
 */
export default function ThemeToggle({ value, onChange }: { value: ThemePreference; onChange: (value: ThemePreference) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      onKeyDown={handleRadioGroupKeyDown}
      className="inline-flex items-center gap-0.5 border border-border bg-muted p-0.5"
    >
      {OPTIONS.map((option) => {
        const active = value === option.id
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            title={option.label}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(option.id)}
            className={`press flex size-7 items-center justify-center transition-colors focus-visible:outline-offset-[-2px] ${
              active
                ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)] ring-1 ring-border'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {option.icon}
            </svg>
          </button>
        )
      })}
    </div>
  )
}
