import type { ClientModule, JsonValue } from 'claude-code'

// The key catcher: one row under the picture. Once clicked it holds the
// focus, so the arrows, Enter and Backspace (which a Button's hotkey cannot
// be) reach it; it posts each key to the hooks module, which owns the game.
// It runs on the drawing thread with no `$` and imports types only.
// Adapted from arcade's board.tsx (the iid / n / pending / acks scheme).

type Entry = { n: number; k: string; ctrl?: true; shift?: true; meta?: true }
export type PadProps = { line: string; color?: string; acks?: Record<string, number> }
type PadState = { iid: string; n: number; pending: Entry[]; got: boolean }

const HINT = ' · click here for arrow keys'

const newId = (): string => {
  try {
    return crypto.randomUUID()
  } catch {
    return `p${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  }
}

const Pad: ClientModule<PadProps, PadState> = (p, surface) => {
  const { Box, Text } = surface.elements
  let st = surface.state
  if (!st) {
    // Set once: a setState on every call would be a render loop.
    st = { iid: newId(), n: 0, pending: [], got: false }
    surface.setState(st)
  }
  const mine = st
  // What the hooks module has applied is dropped; the rest rides along on the next post.
  const acked = p.acks?.[mine.iid] ?? 0
  for (let i = mine.pending.length - 1; i >= 0; i--) if ((mine.pending[i] as Entry).n <= acked) mine.pending.splice(i, 1)

  surface.onKey(ev => {
    mine.got = true
    mine.n += 1
    mine.pending.push({
      n: mine.n,
      k: ev.key,
      ...(ev.ctrl ? { ctrl: true as const } : {}),
      ...(ev.shift ? { shift: true as const } : {}),
      ...(ev.meta ? { meta: true as const } : {}),
    })
    if (mine.pending.length > 32) mine.pending.splice(0, mine.pending.length - 32)
    surface.post({ iid: mine.iid, keys: mine.pending } as unknown as JsonValue)
  })

  return (
    <Box>
      <Text key="line" color={p.color} wrap="truncate">
        {mine.got ? p.line : `${p.line}${HINT}`}
      </Text>
    </Box>
  )
}

export default Pad
