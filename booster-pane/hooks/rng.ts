// A seeded generator over one plain number, so a game's state holds it and a
// saved game, a reload and a test all replay the same way.

/** One draw in [0, 1) and the state to draw from next (mulberry32). */
export function next(state: number): { v: number; s: number } {
  const s = (state + 0x6d2b79f5) | 0
  let t = Math.imul(s ^ (s >>> 15), 1 | s)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return { v: ((t ^ (t >>> 14)) >>> 0) / 4294967296, s }
}

/** An integer in [0, n) and the next state. */
export function int(state: number, n: number): { v: number; s: number } {
  const r = next(state)
  return { v: Math.floor(r.v * n), s: r.s }
}

/** A shuffled copy (Fisher-Yates) and the next state. */
export function shuffle<T>(items: readonly T[], state: number): { items: T[]; s: number } {
  const out = items.slice()
  let s = state
  for (let i = out.length - 1; i > 0; i--) {
    const r = int(s, i + 1)
    s = r.s
    const a = out[i] as T
    out[i] = out[r.v] as T
    out[r.v] = a
  }
  return { items: out, s }
}
