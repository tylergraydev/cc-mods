import type { ClientModule, JsonValue } from 'claude-code'

// The board's Client: it draws lines of runs it is given and sends every key
// and click back to the hooks module with `post`. The hooks module owns the
// game; this runs on the drawing thread and has no `$`. It imports types only,
// so it needs nothing from the plugin's other files.

type Seg = { text: string; color?: string; bg?: string; bold?: boolean; dim?: boolean; inverse?: boolean; underline?: boolean }
type Entry = { n: number; k: string; ctrl?: true; shift?: true; meta?: true; c?: number; r?: number }
export type BoardProps = { lines: Seg[][]; hint?: string; acks?: Record<string, number> }
type BoardState = { iid: string; n: number; pending: Entry[]; got: boolean }

const newId = (): string => {
  try {
    return crypto.randomUUID()
  } catch {
    return `b${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
  }
}

const Board: ClientModule<BoardProps, BoardState> = (p, surface) => {
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

  const send = (entry: Omit<Entry, 'n'>) => {
    mine.got = true
    mine.n += 1
    mine.pending.push({ ...entry, n: mine.n })
    if (mine.pending.length > 32) mine.pending.splice(0, mine.pending.length - 32)
    surface.post({ iid: mine.iid, keys: mine.pending } as unknown as JsonValue)
  }

  surface.onKey(ev => {
    send({ k: ev.key, ...(ev.ctrl ? { ctrl: true as const } : {}), ...(ev.shift ? { shift: true as const } : {}), ...(ev.meta ? { meta: true as const } : {}) })
  })
  surface.onPointer(ev => {
    if (ev.type === 'down' && ev.button === 'left') send({ k: 'tap', c: ev.x, r: ev.y })
  })

  return (
    <Box flexDirection="column">
      {p.lines.map((segs, i) => {
        const shown = segs.filter(s => s.text !== '')
        return (
          <Box key={`row-${i}`}>
            {shown.length === 0 ? (
              <Text key="seg-0"> </Text>
            ) : (
              shown.map((s, j) => (
                <Text key={`seg-${j}`} color={s.color} backgroundColor={s.bg} bold={s.bold} dimColor={s.dim} inverse={s.inverse} underline={s.underline} wrap="truncate">
                  {s.text}
                </Text>
              ))
            )}
          </Box>
        )
      })}
      <Box key="hint">
        <Text key="hint-text" dimColor wrap="truncate">
          {mine.got ? ' ' : (p.hint ?? ' ')}
        </Text>
      </Box>
    </Box>
  )
}

export default Board
