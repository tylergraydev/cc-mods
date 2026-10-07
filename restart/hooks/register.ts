import type { EngineInterface, Register } from 'claude-code'

const NAMES = ['restart', 'restart-claude'] as const
const DESCRIPTION = 'Exit Claude Code and relaunch it in this terminal (claude -c)'
const HINT = '[fresh | <claude args>]'
/** A restart noted in the store this long ago is still "the one we just did". */
const RECENT_MS = 3 * 60_000
/** Give the exit toast a moment on screen before the command runs. */
const EXIT_DELAY_MS = 300

export type Config = {
  python: string
  /** The command typed into the terminal once Claude has exited. */
  command: string
  /** Milliseconds between Claude's exit and the typing, so the shell has drawn its prompt. */
  settleMs: number
}

export function readConfig(o: Record<string, unknown>): Config {
  const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d)
  const n = typeof o.settleMs === 'number' ? o.settleMs : typeof o.settleMs === 'string' ? Number(o.settleMs) : NaN
  return {
    python: str(o.python, 'python.exe'),
    command: str(o.command, 'claude -c'),
    settleMs: Number.isFinite(n) ? Math.min(10_000, Math.max(0, n)) : 400,
  }
}

/** What to type after the exit: `fresh` drops `-c`; anything else is passed to claude as its arguments. */
export function relaunchCommand(args: string | undefined, cfg: Config): string {
  const a = (args ?? '').trim()
  if (!a) return cfg.command
  if (a.toLowerCase() === 'fresh') return 'claude'
  return `claude ${a}`
}

let cfg: Config = readConfig({})

/** Starts restart.py outside Claude's process tree, attached to this console. Resolves once cmd has handed it off. */
async function startHelper($: EngineInterface, command: string): Promise<string | undefined> {
  const script = `${$.plugin.root}/restart.py`
  const argv = ['cmd.exe', '/c', 'start', '/b', '', cfg.python, script, '--settle', String(cfg.settleMs), '--', ...command.split(/\s+/)]
  const stream = $.process.spawn({ argv, cwd: $.plugin.root })
  let output = ''
  for (;;) {
    const step = await stream.next()
    if (step.done) {
      const code = step.value?.code ?? null
      if (code !== 0 && code !== null) return `cmd exited ${code}${output ? `: ${output.trim()}` : ''}`
      return undefined
    }
    output += step.value.text
  }
}

async function runExit($: EngineInterface) {
  try {
    await $.command.run({ command: 'exit' })
  } catch {
    try {
      await $.prompt.submit({ text: '/exit' })
    } catch (err) {
      $.ui.toast(`restart: could not run /exit (${String(err)}); type it yourself, the relaunch is armed`, { timeoutMs: 10_000 })
    }
  }
}

async function runCommand($: EngineInterface, args: string | undefined): Promise<{ text: string }> {
  const a = (args ?? '').trim().toLowerCase()
  if (a === 'help') return { text: `restart: /restart runs /exit, then types "${cfg.command}" into this terminal. /restart fresh relaunches without -c; /restart <args> relaunches as "claude <args>".` }
  const command = relaunchCommand(args, cfg)
  let failure: string | undefined
  try {
    failure = await startHelper($, command)
  } catch (err) {
    failure = String(err)
  }
  if (failure) return { text: `restart: could not start the relaunch helper (${failure}). Nothing exited. Is ${cfg.python} on PATH?` }
  await $.store.set('last', { at: await $.clock.now(), command })
  $.ui.toast(`restart: exiting; "${command}" is typed here once the prompt is back`, { timeoutMs: 8000 })
  $.clock.after(EXIT_DELAY_MS, () => void runExit($))

  return { text: `restart: helper started; exiting now, then "${command}".` }
}

export const register: Register = (on, options) => {
  cfg = readConfig(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // `restart` may be a built-in's name: the engine refuses it, and /restart-claude stands in.
    try {
      await $.command.register({ name: NAMES[0], description: DESCRIPTION, argumentHint: HINT })
    } catch {
      await $.command.register({ name: NAMES[1], description: DESCRIPTION, argumentHint: HINT })
    }
    const last = (await $.store.get('last')) as { at?: number; command?: string } | undefined
    if (last && typeof last.at === 'number') {
      const now = await $.clock.now()
      if (now - last.at < RECENT_MS) $.ui.toast(`restart: back via "${last.command ?? cfg.command}"`)
      await $.store.delete('last')
    }

    return r
  })

  on('command.run', { command: 'restart' }, async ($, e) => runCommand($, e.args))
  on('command.run', { command: 'restart-claude' }, async ($, e) => runCommand($, e.args))
}
