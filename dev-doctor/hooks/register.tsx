import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { DoctorCheckId, DoctorResult, DoctorRun } from '../types'
import { makeSh, runCheck } from './checks'
import type { Io } from './checks'
import { CHECK_IDS, VOLATILE_IDS, detectMarkers, isApplicable, parseOpts } from './gates'
import type { DoctorOpts } from './gates'
import { byStatus, composeText, failIds, statusLine, summaryForModel, toastText } from './summary'
import { BENCH, fillSlot, inSlot, slotOf } from './bench'

const PANE = 'dev-doctor'
const TITLE = 'Doctor'
const DEBOUNCE_MS = 3000

// Commands that start or stop apps, containers, worktrees: the checks may be stale after them.
const VOLATILE =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)\b|next\s+(dev|start)|dotnet\s+(run|watch)|aspire\s+run|docker(\s+compose)?\s+(up|down|run|rm|stop|start|kill)|Stop-Process|taskkill|\bkill\b|git\s+(worktree|commit|merge|rebase|checkout|switch|stash)/i

const run = atom({ plugin: 'dev-doctor', key: 'run' } as const, null as DoctorRun | null)
const isRunning = atom({ plugin: 'dev-doctor', key: 'isRunning' } as const, false)
const toastedFails = atom({ plugin: 'dev-doctor', key: 'toastedFails' } as const, [] as DoctorCheckId[])
const expanded = atom({ plugin: 'dev-doctor', key: 'expanded' } as const, null as string | null)

/** What the checks may touch, spelled out here because `$` is not followed across an import. */
const ioOf = ($: EngineInterface): Io => ({
  read: path => $.fs.read(path),
  list: path => $.fs.list(path),
  run: (argv, init) => $.process.run(argv, init),
  now: () => $.clock.now(),
  env: {
    authSecret: () => $.env.get('AUTH_SECRET'),
    appData: () => $.env.get('APPDATA'),
    gitBash: () => $.env.get('CLAUDE_CODE_GIT_BASH_PATH'),
    nvm: () => $.env.get('NVM_HOME'),
    fnm: () => $.env.get('FNM_DIR'),
    volta: () => $.env.get('VOLTA_HOME'),
  },
})

let isBusy = false
let debounce: { cancel: () => void } | undefined

type Reason = DoctorRun['reason']

/** Runs the applicable checks (or just `subset`), stores the run, then sets the status line, toast and prompt text. */
async function runAll($: EngineInterface, opts: DoctorOpts, reason: Reason, subset?: DoctorCheckId[]): Promise<DoctorRun | null> {
  if (isBusy) return read($, run)
  isBusy = true
  await update($, isRunning, () => true)
  try {
    const before = await read($, run)
    if (!before) $.ui.status('doctor: …')
    const startedAt = await $.clock.now()
    const root = await $.session.root()
    const io = ioOf($)
    const markers = await detectMarkers(io, root)
    const ids = CHECK_IDS.filter(id => isApplicable(id, markers, opts) && (!subset || subset.includes(id)))
    const ctx = { io, root, markers, opts, sh: makeSh(io, root) }
    const fresh = await Promise.all(ids.map(id => runCheck(id, ctx)))

    // A partial run merges by id into the last one.
    const isMerge = subset !== undefined && before !== null && before.root === root
    const kept = isMerge ? before.results.filter(r => !subset.includes(r.id)) : []
    const results: DoctorResult[] = [...kept, ...fresh].sort((a, b) => CHECK_IDS.indexOf(a.id) - CHECK_IDS.indexOf(b.id))
    const next: DoctorRun = { root, reason, startedAt, finishedAt: await $.clock.now(), markers, results }
    await update($, run, () => next)

    $.ui.status(statusLine(next))
    const fails = failIds(results)
    const text = toastText(fails, await read($, toastedFails))
    if (text) $.ui.toast(text, { timeoutMs: 8000 })
    await update($, toastedFails, () => fails)
    return next
  } catch (error) {
    $.ui.status(`doctor: ${String(error instanceof Error ? error.message : error).slice(0, 60)}`)
    return read($, run)
  } finally {
    isBusy = false
    await update($, isRunning, () => false)
  }
}

/** After a command that may have started or stopped something: re-check the volatile checks once it settles. */
function rerunLater($: EngineInterface, opts: DoctorOpts, command: string) {
  if (!VOLATILE.test(command)) return
  debounce?.cancel()
  debounce = $.clock.after(DEBOUNCE_MS, () => void runAll($, opts, 'tool', VOLATILE_IDS))
}

export const register: Register = (on, options) => {
  const opts = parseOpts(options as Record<string, unknown> | undefined)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'dev-doctor',
      description: 'Run environment checks and open the doctor pane',
      argumentHint: '[run|close]',
    })
    // Never block the session on the checks, and never open the pane unasked.
    void runAll($, opts, 'start')
    if (opts.intervalMinutes > 0) {
      $.clock.every(opts.intervalMinutes * 60_000, () => void runAll($, opts, 'timer'))
    }

    return started
  })

  on('command.run', { command: 'dev-doctor' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Doctor pane closed.' }
    }
    if (arg !== '' && arg !== 'run') return { text: 'Usage: /dev-doctor [run|close]' }
    if (arg === '') await $.ui.open({ id: PANE, title: TITLE })
    const finished = await runAll($, opts, 'command')

    return { text: summaryForModel(finished) }
  })

  if (opts.rerunAfterTools) {
    // After a command that may have started or stopped something, re-check the volatile ones.
    on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
      const result = await next(e)
      rerunLater($, opts, e.command)

      return result
    })
    on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
      const result = await next(e)
      rerunLater($, opts, e.command)

      return result
    })
  }

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!opts.composeSection) return result
    const last = await read($, run)
    const text = last ? composeText(last.results) : ''

    return text ? { sections: [...result.sections, { id: 'dev-doctor:env', text, scope: 'session' }] } : result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawPane($, e, opts))

  // Inside the workbench: fill this pane's slot in its frame.
  on('ui.render', { component: 'Pane', requestId: BENCH }, async ($, e, next) => {
    const frame = await next(e)
    const slot = slotOf(frame, PANE)
    return slot ? fillSlot(frame, PANE, await drawPane($, inSlot(e, slot.columns), opts)) : frame
  })
}

const MARK = { fail: '✗ FAIL', warn: '! WARN', pass: '✓ PASS', skip: '· SKIP' } as const
const COLOR = { fail: 'red', warn: 'yellow', pass: 'green', skip: undefined } as const

const clock = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** The pane's drawing, in its own pane or in a workbench slot. */
async function drawPane($: EngineInterface, e: RenderInput<'Pane'>, opts: DoctorOpts) {
  const { Box, Button, Text } = $.ui.resolve(e)
  const last = await read($, run)
  const busy = await read($, isRunning)
  const open = await read($, expanded)

  const rerun = (
    <Button key="rerun" label="Re-run" hotkey="r" onPress={() => void runAll($, opts, 'command')} />
  )
  if (!last) {
    return (
      <Box flexDirection="column">
        <Text key="empty" dimColor>
          {busy ? 'checking…' : 'Not run yet. /dev-doctor run'}
        </Text>
        {rerun}
      </Box>
    )
  }

  const count = (status: DoctorResult['status']) => last.results.filter(r => r.status === status).length
  const ran = last.results.length - count('skip')
  const ok = count('pass') + count('warn')
  const rows = [...last.results].sort(byStatus)

  const row = (r: DoctorResult) => {
    const isOpen = open === r.id
    const fix = r.fix
    return (
      <Box key={`row-${r.id}`} flexDirection="column">
        <Box flexDirection="row">
          <Button
            key={`open-${r.id}`}
            label={isOpen ? '▾' : '▸'}
            plain
            onPress={() => update($, expanded, now => (now === r.id ? null : r.id))}
          />
          <Text color={COLOR[r.status]} dimColor={r.status === 'skip'} bold={r.status !== 'skip'}>
            {` ${MARK[r.status]}  ${r.name.padEnd(15)} `}
          </Text>
          <Text dimColor={r.status === 'skip'} wrap={isOpen ? 'wrap' : 'truncate'}>
            {r.evidence}
          </Text>
        </Box>
        {isOpen && (
          <Text key={`gate-${r.id}`} dimColor wrap="wrap">
            {`         ran because: ${r.gate}`}
          </Text>
        )}
        {fix && (
          <Box key={`fix-${r.id}`} flexDirection="row">
            <Text dimColor wrap={isOpen ? 'wrap' : 'truncate'}>
              {`         fix  ${isOpen ? fix : fix.split('\n')[0]}  `}
            </Text>
            <Button
              key={`copy-${r.id}`}
              label="copy"
              onPress={async () => {
                await $.ui.copy({ text: fix, surface: e.surface })
                $.ui.toast('copied')
              }}
            />
          </Box>
        )}
      </Box>
    )
  }

  const summary = `${ok}/${ran} ok · ${count('fail')} fail · ${count('skip')} skip`
  return (
    <Box flexDirection="column">
      <Text key="head" bold wrap="truncate">
        {busy ? 'DEV DOCTOR  checking…' : `DEV DOCTOR  ${last.root}   ${summary}   checked ${clock(last.finishedAt)} (${last.reason})`}
      </Text>
      {rerun}
      {rows.map(row)}
    </Box>
  )
}
