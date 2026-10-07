# Cache Clock

A Claude Code mod that counts down the prompt cache in the status line and, once the cache has lapsed, offers the cheapest way on: Compact, Handoff, Clear, or Keep going.

```
⚠ cache-clock: 58m left                 (or, folded by status-bar:  … │ cache: 58m left │ …)
⚠ cache-clock: 4:59 left ⚠
⚠ cache-clock: cold 12m · /cache
```

The band above the prompt after a lapse:

```
prompt cache lapsed 12 min ago · the next prompt re-sends ~142k tokens uncached · compact pays that once and shrinks every prompt after
[c: Compact]  [h: Handoff]  [x: Clear]  [k: Keep going]
```

## How it reads the cache

Anthropic's prompt cache keeps a request's prefix for a fixed time after the last request that used it: one hour on this account's plan, five minutes while a session is in usage overage. Every request in a turn refreshes it, so the clock anchors on the end of each main-loop turn (`turn.complete`) and counts down from there. While a turn runs the line reads `warming`. Subagent turns are ignored; they share the prefix but end at odd times.

- **warm**: whole minutes left, rounded up (`58m left`).
- **warn**: under `warnMinutes` (default 5) the line switches to `m:ss left ⚠`.
- **cold**: `cold Nm · /cache`, and the band appears.
- **idle**: nothing, before the first answer and after a compact or a `/clear`: a new prefix has nothing to count down until the next answer lands.

The clock cannot see the server. It is arithmetic on the TTL you tell it, so if the plan's window changes, `/cache ttl <minutes>` corrects it and the choice is kept across sessions.

## Which button is cheapest

After a lapse, every path that sends a request pays the whole context uncached once: continuing, compacting and writing a handoff alike. Only `/clear` pays nothing, and it forgets everything. The difference is what happens after that one payment:

| press | pays the miss | then |
| --- | --- | --- |
| Keep going | once, re-caches the whole context | every later prompt re-sends the same large prefix (cached) |
| Compact | once, for the summary request | later prompts re-send a short summary |
| Handoff | once, for the handoff doc; handoff-watch then clears and resumes | a fresh context that reads the doc |
| Clear | never | a fresh, empty context |

So the band marks **Compact** primary when the context is at least `compactAbove` tokens (default 30k) and **Keep going** when it is smaller: a small miss is not worth losing detail over. Handoff is Compact with a file you can read, offered only when handoff-watch's `/handoff` is registered. The line names the estimated re-send from the status line's own token count.

Compact runs `$.session.compact()`, the same call `/compact` makes. Handoff runs `/handoff`, Clear runs `/clear`, both queued for when the session is idle. Keep going hides the band until the next answer re-arms the clock.

## Commands

`/cache` (or `/cache-clock` where the engine refuses the first name):

- `/cache` reports the phase, the time left or the time since the lapse, the context size and the band setting.
- `/cache ttl <minutes>` sets the window (1 to 1440). `5` for overage, `60` to go back. Kept across sessions.
- `/cache band on|off` draws or skips the band after a lapse. Kept across sessions.
- `/cache reset` drops the anchor; the countdown starts again at the next answer.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `ttlMinutes` | 60 | The cache window, until `/cache ttl` overrides it |
| `warnMinutes` | 5 | Below this the status shows `m:ss` and `⚠` |
| `showBand` | true | Draw the band after a lapse |
| `compactAbove` | 30000 | Context size, in tokens, from which Compact is the primary press |

## Position and status-bar

Any position works. With status-bar loaded the line is folded under the label `cache`. The band calls `next` and stacks whatever draws beneath it, like status-bar's own.

## Limits

- The TTL is assumed, not observed: the API does not report when a cache entry lapses. An overage that starts mid-session shortens the real window to five minutes until you run `/cache ttl 5`.
- The anchor is the end of the turn, not the end of the last request inside it; the two differ by the time the answer took to stream, a few seconds at most.
- Compaction from the band cannot run while a turn is running; the band is hidden then anyway.
- The status line ticks once a second; status-bar debounces it, and the text itself changes once a minute above the warn line.
