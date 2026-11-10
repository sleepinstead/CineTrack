/**
 * The home heading: a greeting for the time of day, as two words so the
 * second can carry the accent italic. Late at night it's the late show.
 */
export function greetingFor(date: Date): [string, string] {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return ['Good', 'morning']
  if (hour >= 12 && hour < 17) return ['Good', 'afternoon']
  if (hour >= 17 && hour < 22) return ['Good', 'evening']
  return ['Late', 'show']
}

/** "Friday, 6 November" in the reader's locale. */
export function longDate(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}
