import { useEffect, useState } from 'react'
import { greetingFor, longDate } from '../lib/greeting'

/** Re-render once a minute so the greeting turns over with the clock. */
function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

/** Home heading: today's date, then "Good evening" on one line with the accent italic. */
export default function Greeting() {
  const now = useNow()
  const [first, second] = greetingFor(now)
  return (
    <>
      <p className="rule-label animate-fade">{longDate(now)}</p>
      <h1 className="mt-3 w-full max-w-full font-display text-[clamp(22px,6.2vw,92px)] leading-[0.95] tracking-tight">
        <span className="inline-block animate-rise [animation-delay:60ms]">{first}</span>{' '}
        <em className="inline-block animate-rise text-[var(--primary)] [animation-delay:180ms]">{second}</em>
      </h1>
    </>
  )
}
