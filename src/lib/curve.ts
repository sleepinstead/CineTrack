export type Point = { x: number; y: number }

/**
 * Monotone cubic (Fritsch–Carlson) segments: smooth, but never overshooting
 * a data point, so the curve can't suggest a month higher or lower than it was.
 */
export function monotoneSegments(points: Point[]): string[] {
  const n = points.length
  if (n < 2) return []
  const dx: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1]!.x - points[i]!.x
    slope[i] = (points[i + 1]!.y - points[i]!.y) / dx[i]!
  }
  const tangent: number[] = [slope[0]!]
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1]!
    const b = slope[i]!
    tangent[i] = a * b <= 0 ? 0 : (3 * (dx[i - 1]! + dx[i]!)) / ((2 * dx[i]! + dx[i - 1]!) / a + (dx[i]! + 2 * dx[i - 1]!) / b)
  }
  tangent[n - 1] = slope[n - 2]!
  const segments: string[] = []
  for (let i = 0; i < n - 1; i++) {
    const p = points[i]!
    const q = points[i + 1]!
    const h = dx[i]! / 3
    segments.push(`C${p.x + h},${p.y + tangent[i]! * h} ${q.x - h},${q.y - tangent[i + 1]! * h} ${q.x},${q.y}`)
  }
  return segments
}
