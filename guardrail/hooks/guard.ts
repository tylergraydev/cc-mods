import type { GuardBlock, GuardDryRun, GuardKind, GuardSession } from '../types'

export type Dialect = 'bash' | 'pwsh'

/** One word of a command: quotes removed, `low` its lowercase copy for matching. */
export type Tok = { text: string; low: string; quoted: boolean }

export type Seg = {
  /** Command word (lowercase basename, no .exe) and its arguments, wrappers and env stripped. */
  toks: Tok[]
  /** Every token as written, for the residual check. */
  all: Tok[]
  word: string
  env: Record<string, string>
  /** `$env:NAME = value` or `export NAME=value`: sets env for later segments. */
  assigns: Record<string, string>
  /** The segment's tokens, lowercased and joined. */
  text: string
  /** True when its text was re-parsed as inner segments (bash -c, iex, ...). */
  isWrapper: boolean
}

export type Config = {
  blockNoVerify: boolean
  blockLive: boolean
  scope: 'tool' | 'session'
  extraLive?: RegExp
  extraDry?: RegExp
  disabled: Set<string>
  allowMinutes: number
  requireTypedAllow: boolean
  announce: boolean
  /** Option names whose regex did not compile. */
  invalid: string[]
}

export type Hit = { rule: string; key: string; label: string; mode: 'live' | 'dry'; hint: string }

export type Verdict =
  | { kind: 'pass' }
  | { kind: 'deny'; block: GuardBlock; message: string }
  | { kind: 'allow-once'; what: GuardKind; label: string; block: GuardBlock; message: string }
  | { kind: 'record'; dry: Hit[]; live: Hit[]; command: string }

export type Parsed =
  | { kind: 'status' }
  | { kind: 'allow'; what: GuardKind }
  | { kind: 'reset' }
  | { kind: 'usage' }

const MAX_DRY_RUNS = 50

// ---------------------------------------------------------------- options

const flag = (v: unknown, fallback: boolean) => (v === undefined ? fallback : v === true || v === 'true')

function regexOf(v: unknown, name: string, invalid: string[]): RegExp | undefined {
  if (typeof v !== 'string' || v.trim() === '') return undefined
  try {
    return new RegExp(v, 'i')
  } catch {
    invalid.push(name)
    return undefined
  }
}

export function parseConfig(o: Readonly<Record<string, unknown>>): Config {
  const invalid: string[] = []
  const minutes = Number(o.allowMinutes ?? 10)
  return {
    blockNoVerify: flag(o.blockNoVerify, true),
    blockLive: flag(o.blockLiveWithoutDryRun, true),
    scope: o.dryRunScope === 'session' ? 'session' : 'tool',
    extraLive: regexOf(o.extraLivePattern, 'extraLivePattern', invalid),
    extraDry: regexOf(o.extraDryRunPattern, 'extraDryRunPattern', invalid),
    disabled: new Set(
      String(o.disabledRules ?? '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean),
    ),
    allowMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 10,
    requireTypedAllow: flag(o.requireTypedAllow, true),
    announce: flag(o.announce, true),
    invalid,
  }
}

// ---------------------------------------------------------------- parsing

const tok = (text: string, quoted: boolean): Tok => ({ text, low: text.toLowerCase(), quoted })

/**
 * Splits a command into tokens (quotes removed) and, when `split`, into segments
 * on unquoted `&&`, `||`, `;`, `|`, `&`, newlines, parentheses and standalone braces.
 */
export function scan(text: string, dialect: Dialect, split = true): { segs: Tok[][]; joins: string[] } {
  const segs: Tok[][] = []
  const joins: string[] = []
  let toks: Tok[] = []
  let cur = ''
  let has = false
  let quoted = false
  let literal = false

  const endTok = () => {
    if (!has) return
    const t = tok(cur, quoted)
    cur = ''
    has = false
    quoted = false
    if (split && !t.quoted && (t.text === '{' || t.text === '}')) return endSeg('{}')
    toks.push(t)
    if (dialect === 'pwsh' && t.text === '--%') literal = true
  }
  const endSeg = (op: string) => {
    endTok()
    if (toks.length > 0) {
      segs.push(toks)
      joins.push(op)
    }
    toks = []
  }
  const add = (c: string) => {
    cur += c
    has = true
  }

  let i = 0
  while (i < text.length) {
    const c = text[i]!
    const next = text[i + 1]
    if (c === '\n') {
      literal = false
      if (split) endSeg('\n')
      else endTok()
      i += 1
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endTok()
      i += 1
    } else if (c === "'") {
      i += 1
      has = true
      quoted = true
      while (i < text.length) {
        if (text[i] === "'") {
          if (dialect === 'pwsh' && text[i + 1] === "'") {
            cur += "'"
            i += 2
            continue
          }
          break
        }
        cur += text[i]
        i += 1
      }
      i += 1
    } else if (c === '$' && next === "'" && dialect === 'bash') {
      i += 2
      has = true
      quoted = true
      while (i < text.length && text[i] !== "'") {
        if (text[i] === '\\' && i + 1 < text.length) i += 1
        cur += text[i]
        i += 1
      }
      i += 1
    } else if (c === '"') {
      i += 1
      has = true
      quoted = true
      const esc = dialect === 'bash' ? '\\' : '`'
      while (i < text.length) {
        const q = text[i]!
        if (q === '"') {
          // pwsh: a doubled quote inside double quotes is one literal quote
          if (dialect === 'pwsh' && text[i + 1] === '"') {
            cur += '"'
            i += 2
            continue
          }
          break
        }
        if (q === esc && i + 1 < text.length) {
          const n = text[i + 1]!
          if (dialect === 'pwsh' || '"\\$`'.includes(n)) {
            cur += n
            i += 2
            continue
          }
        }
        cur += q
        i += 1
      }
      i += 1
    } else if (dialect === 'pwsh' && c === '`' && !literal) {
      i += 1
      if (i < text.length) add(text[i]!)
      i += 1
    } else if (dialect === 'bash' && c === '\\') {
      if (next !== undefined && (' \t"\'\\$;&|()<>*?#'.includes(next) || next === '\n')) {
        if (next !== '\n') add(next)
        i += 2
      } else {
        add(c)
        i += 1
      }
    } else if (split && !literal && (c === ';' || c === '(' || c === ')')) {
      endSeg(c)
      i += 1
    } else if (split && !literal && c === '|') {
      endSeg(next === '|' ? '||' : '|')
      i += next === '|' ? 2 : 1
    } else if (split && !literal && c === '&') {
      if (next === '&') {
        endSeg('&&')
        i += 2
      } else if (dialect === 'bash' && (next === '>' || text[i - 1] === '>')) {
        add(c)
        i += 1
      } else if (dialect === 'pwsh' && toks.length === 0 && !has) {
        i += 1 // the call operator
      } else {
        endSeg('&')
        i += 1
      }
    } else {
      add(c)
      i += 1
    }
  }
  endSeg('')
  return { segs, joins }
}

export const tokenize = (text: string, dialect: Dialect): Tok[] => scan(text, dialect, false).segs.flat()
export const segments = (text: string, dialect: Dialect) => scan(text, dialect)

const WRAPPERS = new Set(['sudo', 'time', 'command', 'exec', 'nohup', 'env', 'then', 'do', 'else', '!', 'npx', 'bunx', 'pnpx'])
const ENV_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s

const slashes = (t: Tok): Tok => (t.text.includes('\\') ? tok(t.text.split('\\').join('/'), t.quoted) : t)

export function basename(path: string): string {
  const p = path.split('\\').join('/')
  return p.slice(p.lastIndexOf('/') + 1).toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
}

/** One tokenised segment as a Seg: env and wrapper words stripped, the command word reduced to its basename. */
export function normalize(tokens: Tok[], dialect: Dialect): Seg {
  const all = tokens
  const env: Record<string, string> = {}
  const assigns: Record<string, string> = {}
  const empty = (): Seg => ({ toks: [], all, word: '', env, assigns, text: '', isWrapper: false })

  if (dialect === 'pwsh') {
    const joined = tokens.map(t => t.text).join('')
    const m = /^\$env:(\w+)\s*=\s*(.*)$/is.exec(joined)
    if (m) return { ...empty(), assigns: { [m[1]!.toUpperCase()]: m[2]!.replace(/^['"]|['"]$/g, '') } }
  }

  let rest = tokens.map(slashes)
  for (;;) {
    const first = rest[0]
    if (!first) break
    const m = !first.quoted || dialect === 'bash' ? ENV_ASSIGN.exec(first.text) : null
    if (m) {
      env[m[1]!.toUpperCase()] = m[2]!
      rest = rest.slice(1)
    } else if (WRAPPERS.has(first.low)) {
      rest = rest.slice(1)
    } else {
      break
    }
  }
  const first = rest[0]
  if (!first) return { ...empty(), env }

  if (first.low === 'export' || first.low === 'set') {
    for (const t of rest.slice(1)) {
      const m = ENV_ASSIGN.exec(t.text)
      if (m) assigns[m[1]!.toUpperCase()] = m[2]!
    }
    return { toks: rest, all, word: first.low, env, assigns, text: rest.map(t => t.low).join(' '), isWrapper: false }
  }
  const word = basename(first.text)
  const toks = [tok(first.text, first.quoted), ...rest.slice(1)]
  return { toks, all, word, env, assigns, text: toks.map(t => t.low).join(' '), isWrapper: false }
}

const args = (seg: Seg) => seg.toks.slice(1)
const valueAfter = (seg: Seg, names: string[]): string | undefined => {
  const i = seg.toks.findIndex((t, n) => n > 0 && names.includes(t.low))
  return i < 0 ? undefined : seg.toks[i + 1]?.text
}
const joinFrom = (list: Tok[]) => list.map(t => t.text).join(' ')

/** The text a wrapper command runs, or undefined when this segment is not a wrapper. */
function inner(seg: Seg): { text: string; dialect: Dialect } | undefined {
  const a = args(seg)
  const w = seg.word
  if (w === 'bash' || w === 'sh' || w === 'zsh' || w === 'dash') {
    const i = a.findIndex(t => /^-[a-z]*c$/.test(t.text))
    const t = i >= 0 ? a[i + 1] : undefined
    return t ? { text: t.text, dialect: 'bash' } : undefined
  }
  if (w === 'pwsh' || w === 'powershell') {
    const i = a.findIndex(t => /^-c(o(m(m(a(nd?)?)?)?)?)?$/.test(t.low))
    return i >= 0 && a[i + 1] ? { text: joinFrom(a.slice(i + 1)), dialect: 'pwsh' } : undefined
  }
  if (w === 'cmd') {
    const i = a.findIndex(t => t.low === '/c' || t.low === '/k')
    return i >= 0 && a[i + 1] ? { text: joinFrom(a.slice(i + 1)), dialect: 'bash' } : undefined
  }
  if (w === 'wsl') return a.length > 0 ? { text: joinFrom(a), dialect: 'bash' } : undefined
  if (w === 'eval') return a.length > 0 ? { text: joinFrom(a), dialect: 'bash' } : undefined
  if (w === 'iex' || w === 'invoke-expression') {
    const list = a[0] && /^-c(ommand)?$/.test(a[0].low) ? a.slice(1) : a
    return list.length > 0 ? { text: joinFrom(list), dialect: 'pwsh' } : undefined
  }
  if (w === 'start-process') {
    const file = a.find(t => !t.text.startsWith('-'))
    const i = a.findIndex(t => /^-a(r(g(u(m(e(n(t(l(i(st?)?)?)?)?)?)?)?)?)?)?$/.test(t.low))
    if (!file || i < 0 || !a[i + 1]) return undefined
    return { text: `${file.text} ${a[i + 1]!.text.split(',').join(' ')}`, dialect: 'pwsh' }
  }
  return undefined
}

/** Every segment of the command, with wrapper contents (bash -c, pwsh -Command, iex, ...) re-parsed as more segments. */
export function expand(text: string, dialect: Dialect, depth = 0): Seg[] {
  const out: Seg[] = []
  for (const toks of scan(text, dialect).segs) {
    const seg = normalize(toks, dialect)
    const wrapped = depth < 3 ? inner(seg) : undefined
    if (wrapped) {
      out.push({ ...seg, isWrapper: true }, ...expand(wrapped.text, wrapped.dialect, depth + 1))
    } else {
      out.push(seg)
    }
  }
  return out
}

// ---------------------------------------------------------------- git hook bypass

const SCRIPT_EXT = /\.(ps1|sh|js|ts|py|cmd|bat|mjs|cjs)$/i
const looksLikeFile = (t: Tok) => !t.text.startsWith('-') && !/\s/.test(t.text) && (t.text.includes('/') || SCRIPT_EXT.test(t.text))
const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'node', 'python', 'python3', 'py', 'deno', 'bun', 'tsx', 'ts-node', 'pwsh', 'powershell'])

type Git = { sub: string; rest: Tok[]; hooksPath: boolean }

function gitOf(seg: Seg): Git | undefined {
  if (seg.word !== 'git') return undefined
  const t = seg.toks
  let hooksPath = false
  let i = 1
  while (i < t.length) {
    const x = t[i]!
    if (x.text === '-C' || x.text === '--namespace' || x.low === '--git-dir' || x.low === '--work-tree') i += 2
    else if (x.text === '-c') {
      if (/^core\.hookspath=/i.test(t[i + 1]?.text ?? '')) hooksPath = true
      i += 2
    } else if (/^-c.+=/.test(x.text)) {
      if (/^-ccore\.hookspath=/i.test(x.text)) hooksPath = true
      i += 1
    } else if (x.text.startsWith('-')) i += 1
    else break
  }
  const sub = t[i]?.low
  return sub ? { sub, rest: t.slice(i + 1), hooksPath } : undefined
}

const VALUE_LETTERS = 'mFCct'
const VALUE_LONG = new Set(['--message', '--file', '--author', '--date', '--template', '--reuse-message', '--reedit-message'])

/** The option tokens of `git commit`, with the values of -m, -F and the like dropped. */
function commitOptions(rest: Tok[]): Tok[] {
  const out: Tok[] = []
  for (let i = 0; i < rest.length; i += 1) {
    const x = rest[i]!
    if (x.text === '--') break
    if (x.text.startsWith('--')) {
      out.push(x)
      if (VALUE_LONG.has(x.low)) i += 1
    } else if (/^-[A-Za-z]/.test(x.text)) {
      out.push(x)
      const letters = [...x.text.slice(1)]
      if (letters.findIndex(l => VALUE_LETTERS.includes(l)) === letters.length - 1) i += 1
    }
  }
  return out
}

/** A short-flag cluster with `n` in it before any letter that takes a value (`-n`, `-nm`, `-anm`, not `-mnew`). */
function hasShortN(options: Tok[]): boolean {
  return options.some(x => {
    if (x.text.startsWith('--') || !x.text.startsWith('-')) return false
    for (const l of x.text.slice(1)) {
      if (l === 'n') return true
      if (VALUE_LETTERS.includes(l)) return false
    }
    return false
  })
}

const skipsHooksEnv = (env: Record<string, string>, sub: string) => {
  if (sub !== 'commit' && sub !== 'push') return undefined
  const h = env.HUSKY
  if (h !== undefined && (h === '0' || h.toLowerCase() === 'false')) return 'HUSKY=0'
  if (env.HUSKY_SKIP_HOOKS !== undefined) return 'HUSKY_SKIP_HOOKS'
  if (sub === 'commit' && env.SKIP !== undefined) return 'SKIP='
  return undefined
}

/** A git command that skips hooks, with the rule that caught it. `persisted` is env set earlier in the same command. */
export function hookBypass(seg: Seg, persisted: Record<string, string> = {}): { rule: string; label: string } | undefined {
  const g = gitOf(seg)
  if (!g) return undefined
  const options = g.sub === 'commit' ? commitOptions(g.rest) : g.rest
  const long = options.find(t => /^--no-veri/.test(t.low))
  if (long && ['commit', 'push', 'merge', 'rebase', 'am', 'cherry-pick'].includes(g.sub)) {
    return { rule: 'git-no-verify', label: `git ${g.sub} ${long.text}` }
  }
  if (g.sub === 'commit' && hasShortN(options)) return { rule: 'git-no-verify', label: 'git commit -n' }
  if (g.hooksPath && ['commit', 'push', 'merge', 'rebase', 'am'].includes(g.sub)) {
    return { rule: 'git-hooks-path', label: `git ${g.sub} with core.hooksPath` }
  }
  const viaEnv = skipsHooksEnv({ ...persisted, ...seg.env }, g.sub)
  if (viaEnv) return { rule: 'husky-off', label: `git ${g.sub} with ${viaEnv}` }
  return undefined
}

const NOISE = new Set(['echo', 'write-host', 'write-output', 'printf'])

/** Safety net for variable tricks (`F=--no-verify; git push $F`): the raw text of a git commit/push command still names a bypass. */
export function residualBypass(segs: Seg[]): boolean {
  if (!segs.some(s => !s.isWrapper && ['commit', 'push'].includes(gitOf(s)?.sub ?? ''))) return false
  const parts: string[] = []
  for (const seg of segs) {
    if (seg.isWrapper || NOISE.has(seg.word) || NOISE.has(seg.all[0]?.low ?? '')) continue
    const kept: string[] = []
    for (let i = 0; i < seg.all.length; i += 1) {
      const x = seg.all[i]!
      if (x.text === '-m' || x.low === '--message' || x.text === '-F') i += 1
      else if (!x.low.startsWith('--message=')) kept.push(x.low)
    }
    parts.push(kept.join(' '))
  }
  return /--no-veri|core\.hookspath|husky(_skip_hooks)?\s*=\s*['"]?(0|1|true)/i.test(parts.join(' '))
}

// ---------------------------------------------------------------- live and dry classification

/** What a segment runs: the `-File` argument, a script after an interpreter, the command itself, or `npm:<script>`. */
export function scriptOf(seg: Seg): { id: string; path: string } | undefined {
  const t = seg.toks
  const mk = (p: string) => ({ id: p.slice(p.lastIndexOf('/') + 1).toLowerCase(), path: p.toLowerCase() })
  const file = valueAfter(seg, ['-file'])
  if (file) return mk(file)
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(seg.word) && t[1]?.low === 'run' && t[2]) return { id: `npm:${t[2].low}`, path: `npm:${t[2].low}` }
  if (seg.word === 'make' && t[1] && !t[1].text.startsWith('-')) return { id: `make:${t[1].low}`, path: `make:${t[1].low}` }
  if (INTERPRETERS.has(seg.word)) {
    const f = t.slice(1).find(looksLikeFile)
    if (f) return mk(f.text)
  }
  if (looksLikeFile(t[0]!)) return mk(t[0]!.text)
  return undefined
}

const DRY_FLAG = /^(--?|\/)(dry-?run|whatif)(=(true|1|yes)|:\$?true)?$/i
const DRY_KV = /^dryrun=(true|1)$/i
const LIVE_FLAG = /^(--?|\/)live(=(true|1|yes)|:\$?true)?$/i

/** A dry-run flag in this segment; `-WhatIf:$false`, `--dry-run=false` and `--no-dry-run` are not one. */
export function dryFlag(seg: Seg, cfg: Pick<Config, 'extraDry'>): boolean {
  return args(seg).some(t => DRY_FLAG.test(t.text) || DRY_KV.test(t.text) || (cfg.extraDry?.test(t.text) ?? false))
}

const READ_ONLY = new Set([
  'cat', 'type', 'ls', 'dir', 'get-content', 'head', 'tail', 'grep', 'rg', 'git', 'code', 'less', 'more', 'wc', 'echo',
  'get-childitem', 'select-string', 'test-path', 'resolve-path', 'cp', 'mv', 'rm', 'del', 'copy', 'move', 'remove-item',
  'notepad', 'vim', 'nano', 'mkdir', 'set-content', 'out-file', 'write-host', 'write-output', 'printf', 'stat', 'find',
])

const WRITE_SQL = /\b(insert|update|delete|merge|truncate|drop|alter|create|exec(ute)?)\b/i

type Raw = { rule: string; identity: string; mode: 'live' | 'dry'; hint: string }

const firstPlain = (list: Tok[]) => list.find(t => !t.text.startsWith('-'))
const colonValue = (seg: Seg, prefixes: string[]) => {
  for (const t of args(seg)) {
    const p = prefixes.find(x => t.low.startsWith(x))
    if (p) return t.low.slice(p.length)
  }
  return undefined
}

function sqlpackage(seg: Seg): Raw | undefined {
  if (seg.word !== 'sqlpackage') return undefined
  const action = colonValue(seg, ['/a:', '/action:', '-a:', '-action:'])
  const hint = 'sqlpackage /Action:DeployReport (or /Action:Script) with the same target'
  if (action === 'publish' || action === 'import') return { rule: 'sqlpackage', identity: 'sqlpackage', mode: 'live', hint }
  if (action === 'script' || action === 'deployreport' || action === 'driftreport') return { rule: 'sqlpackage', identity: 'sqlpackage', mode: 'dry', hint }
  return undefined
}

function dotnetEf(seg: Seg): Raw | undefined {
  let a = args(seg).map(t => t.low)
  if (seg.word === 'dotnet' && a[0] === 'ef') a = a.slice(1)
  else if (seg.word !== 'dotnet-ef') return undefined
  const hint = 'dotnet ef migrations script (or add --dry-run on database drop)'
  const base = { rule: 'dotnet-ef', identity: 'dotnet-ef', hint }
  if (a[0] === 'migrations' && a[1] === 'script') return { ...base, mode: 'dry' }
  if (a[0] === 'database' && a[1] === 'update') return { ...base, mode: 'live' }
  if (a[0] === 'database' && a[1] === 'drop') return { ...base, mode: a.includes('--dry-run') ? 'dry' : 'live' }
  return undefined
}

function bcp(seg: Seg): Raw | undefined {
  if (seg.word !== 'bcp' || args(seg)[1]?.low !== 'in') return undefined
  return { rule: 'bcp', identity: 'bcp', mode: 'live', hint: 'bcp has no dry-run mode: describe the import to the user and ask them; they can type `/guardrail allow`.' }
}

function sqlcmd(seg: Seg): Raw | undefined {
  if (seg.word !== 'sqlcmd' && seg.word !== 'invoke-sqlcmd') return undefined
  const a = args(seg)
  const queries = a.flatMap((t, i) => (['-query', '-q'].includes(t.low) && a[i + 1] ? [a[i + 1]!.text] : []))
  const query = queries.join(' ')
  const hasFile = a.some(t => t.low === '-inputfile' || t.low === '-i')
  const hint = 'wrap the statements in BEGIN TRAN ... ROLLBACK and run that first'
  const base = { rule: 'sqlcmd', identity: 'sqlcmd', hint }
  if (/rollback/i.test(query) && !/commit/i.test(query)) return { ...base, mode: 'dry' }
  if (hasFile || WRITE_SQL.test(query)) return { ...base, mode: 'live' }
  return undefined
}

function migrationCli(seg: Seg): Raw | undefined {
  const a = args(seg)
  const lows = a.map(t => t.low)
  const first = firstPlain(a)?.low ?? ''
  const mk = (tool: string, mode: 'live' | 'dry', hint: string): Raw => ({ rule: 'migration-cli', identity: `migrate:${tool}`, mode, hint })
  const pick = (tool: string, live: RegExp, dry: RegExp | undefined, hint: string, sub = first) =>
    live.test(sub) ? mk(tool, 'live', hint) : dry?.test(sub) ? mk(tool, 'dry', hint) : undefined
  switch (seg.word) {
    case 'prisma': {
      const hint = 'prisma migrate diff (or migrate status)'
      if (lows[0] === 'db' && lows[1] === 'push') return mk('prisma', 'live', hint)
      return lows[0] === 'migrate' ? pick('prisma', /^(deploy|reset|dev)$/, /^(diff|status)$/, hint, lows[1] ?? '') : undefined
    }
    case 'flyway':
      return pick('flyway', /^(migrate|clean|repair|baseline)$/, /^(info|validate)$/, 'flyway info (or validate)')
    case 'liquibase':
      return pick('liquibase', /^(update|rollback|drop-all)$/, /^(update-?sql|rollback-?sql|status)$/, 'liquibase update-sql')
    case 'alembic':
      return /^(upgrade|downgrade)$/.test(first) ? mk('alembic', lows.includes('--sql') ? 'dry' : 'live', 'alembic upgrade ... --sql') : undefined
    case 'rails':
    case 'rake':
      return /^db:(migrate|rollback|seed|reset|drop|setup|schema:load)/.test(first)
        ? mk(seg.word, 'live', 'run it against a copy of the data, or ask the user for a dry run') : undefined
    case 'knex':
      return /^migrate:(?!status|list|currentversion)/.test(first) ? mk('knex', 'live', 'knex migrate:status and a review of the migration') : undefined
    case 'sequelize':
    case 'sequelize-cli':
      return /^db:migrate(?!:status)/.test(first) ? mk('sequelize', 'live', 'sequelize db:migrate:status and a review of the migration') : undefined
    default: {
      const at = seg.toks.findIndex(t => basename(t.text) === 'manage.py')
      if (at < 0) return undefined
      const sub = firstPlain(seg.toks.slice(at + 1))?.low
      if (sub === 'sqlmigrate') return mk('manage.py', 'dry', 'manage.py migrate --plan')
      if (sub === 'migrate') return mk('manage.py', lows.includes('--plan') ? 'dry' : 'live', 'manage.py migrate --plan')
      return undefined
    }
  }
}

const NAMED = /(^|[-_.:])(sync|migrat(e|ion|ions))([-_.:]|$)/i

/** The live-or-dry classification of one segment, or undefined when it touches no data. */
export function classify(seg: Seg, cfg: Pick<Config, 'disabled' | 'extraLive' | 'extraDry'>): Hit | undefined {
  if (!seg.word || seg.isWrapper) return undefined
  const on = (id: string) => !cfg.disabled.has(id)
  const script = scriptOf(seg)
  const generic = (rule: string, identity: string, hint: string): Raw => ({ rule, identity, mode: dryFlag(seg, cfg) ? 'dry' : 'live', hint })
  const GENERIC_HINT = 'add -WhatIf or --dry-run'
  const readOnly = READ_ONLY.has(seg.word)
  const rules: [string, () => Raw | undefined][] = [
    ['sqlpackage', () => sqlpackage(seg)],
    ['dotnet-ef', () => dotnetEf(seg)],
    ['bcp', () => bcp(seg)],
    ['sqlcmd', () => sqlcmd(seg)],
    ['migration-cli', () => migrationCli(seg)],
    [
      'data-script',
      () => {
        const inData = (p: string) => p.includes('/scripts/data/') || p.startsWith('scripts/data/')
        const viaToken = seg.toks.some(t => SCRIPT_EXT.test(t.text) && inData(t.low))
        return !readOnly && (viaToken || (script !== undefined && inData(script.path)))
          ? generic('data-script', script?.id ?? seg.word, GENERIC_HINT) : undefined
      },
    ],
    [
      'sync-migrate-script',
      () => (!readOnly && script && NAMED.test(script.id) ? generic('sync-migrate-script', script.id, GENERIC_HINT) : undefined),
    ],
    [
      'live-flag',
      () => (!readOnly && args(seg).some(t => LIVE_FLAG.test(t.text)) ? generic('live-flag', script?.id ?? seg.word, GENERIC_HINT) : undefined),
    ],
    ['custom', () => (!readOnly && cfg.extraLive?.test(seg.text) ? generic('custom', script?.id ?? seg.word, GENERIC_HINT) : undefined)],
  ]
  for (const [id, run] of rules) {
    if (!on(id)) continue
    const raw = run()
    if (raw) return { rule: raw.rule, key: `${raw.rule}:${raw.identity}${targetSuffix(seg)}`, label: raw.identity, mode: raw.mode, hint: raw.hint }
  }
  return undefined
}

// ---------------------------------------------------------------- fingerprint

const TARGET_OPTS = new Set([
  '--target', '-target', '--env', '-environment', '--server', '-s', '-serverinstance', '--database', '-d', '-database',
  '--connection', '-connectionstring',
])
const TARGET_COLON = ['/targetservername:', '/targetdatabasename:', '/tsn:', '/tdn:', '/targetconnectionstring:', '/tcs:']

export function fnv1a(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const CONN_PART = /(server|data source|database|initial catalog)\s*=\s*([^;]+)/gi

function targetValue(v: string): string[] {
  const parts = [...v.matchAll(CONN_PART)].map(m => `${m[1]!.toLowerCase()}=${m[2]!.trim().toLowerCase()}`)
  return parts.length > 0 ? parts : [v.trim().toLowerCase()]
}

/** `#` plus a hash of the target-like options (server, database, environment), or nothing. The hash keeps secrets out of state. */
export function targetSuffix(seg: Seg): string {
  const values: string[] = []
  const a = args(seg)
  a.forEach((t, i) => {
    if (TARGET_OPTS.has(t.low) && a[i + 1]) values.push(...targetValue(a[i + 1]!.text))
    const eq = t.low.indexOf('=')
    if (eq > 0 && t.low.startsWith('-') && TARGET_OPTS.has(t.low.slice(0, eq))) values.push(...targetValue(t.text.slice(eq + 1)))
    const p = TARGET_COLON.find(x => t.low.startsWith(x))
    if (p) values.push(...targetValue(t.text.slice(p.length)))
  })
  return values.length === 0 ? '' : `#${fnv1a(values.sort().join('|'))}`
}

// ---------------------------------------------------------------- text

/** The command with passwords replaced by `***`, on one line, at most 160 characters. */
export function redact(command: string): string {
  const text = command
    .replace(/\s+/g, ' ')
    .replace(/\b(password|pwd)(\s*=\s*)[^;\s"']+/gi, '$1$2***')
    .replace(/(\s-P\s+)("[^"]*"|'[^']*'|\S+)/g, '$1***')
    .replace(/(\s-Password\s+)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(\/(?:p|targetpassword):)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}

export function denyNoVerify(command: string): string {
  return `guardrail: blocked \`${redact(command)}\`. Skipping git hooks (--no-verify, -n on commit, core.hooksPath, HUSKY=0/SKIP) needs the user's explicit OK, and this session has none. Do not retry with another way of skipping the hooks. Instead tell the user which hook failed and what it reported, and ask whether to fix the failure or skip the hook. If they choose to skip it, they will type \`/guardrail allow no-verify\`; then retry the same command unchanged.`
}

export function denyLive(hit: Hit, chained: boolean): string {
  const how = hit.rule === 'bcp' ? hit.hint : `Run the dry-run form first — ${hit.hint} — in the foreground, show the user what it would change, and wait for their go-ahead. If the user wants to skip the dry run, they will type \`/guardrail allow\`.`
  return `guardrail: blocked a live data operation (\`${hit.label}\`, rule \`${hit.rule}\`): no dry run of it has succeeded in this session. ${how}${chained ? ' This command also contains the dry run; run the dry run as its own command first so its result can be checked before the live run.' : ''} Do not rephrase, wrap or rename the command to get past this check.`
}

export const toastBlocked = (block: GuardBlock) =>
  block.kind === 'live'
    ? `guardrail blocked ${block.label}: no dry run yet · /guardrail allow`
    : `guardrail blocked ${block.label}: skipping hooks needs your OK · /guardrail allow no-verify`

export const toastAllowed = (label: string) => `guardrail: let ${label} through once (allowed by you)`

export const POLICY =
  'guardrail: never skip git hooks (--no-verify and the like) without asking the user.\n' +
  'Before any live data sync or migration run its dry run, show the result and wait for the user.\n' +
  'Check against the real system before stating conclusions about prod.'

export const USAGE = 'usage: /guardrail status | allow [no-verify] | reset'

export function parseArgs(text: string): Parsed {
  const [cmd = '', what = '', ...more] = text.trim().toLowerCase().split(/\s+/)
  if (more.length > 0) return { kind: 'usage' }
  if (cmd === '' || cmd === 'status') return what === '' ? { kind: 'status' } : { kind: 'usage' }
  if (cmd === 'reset') return what === '' ? { kind: 'reset' } : { kind: 'usage' }
  if (cmd === 'allow') {
    if (what === '' || what === 'live') return { kind: 'allow', what: 'live' }
    if (what === 'no-verify' || what === 'noverify') return { kind: 'allow', what: 'no-verify' }
  }
  return { kind: 'usage' }
}

/** Only a person at the composer (or their bridge or SDK) counts; a plugin, peer or scheduled prompt does not. */
export const isHumanOrigin = (origin: { kind?: string } | undefined) => ['composer', 'bridge', 'sdk'].includes(origin?.kind ?? '')

const live = (s: GuardSession, now: number) => (s.allowance && s.allowance.expiresAt > now ? s.allowance : null)

export function statusText(s: GuardSession, now: number): string {
  const labels = [...new Set([...s.dryRuns].reverse().map(d => d.label))]
  const head =
    labels.length === 0 ? 'guard: no dry-run yet'
    : `guard: dry-run ✓ ${labels.slice(0, 2).join(', ')}${labels.length > 2 ? ` +${labels.length - 2}` : ''}`
  return head + (s.blocked > 0 ? ` · ${s.blocked} blocked` : '') + (live(s, now) ? ' · allow armed' : '')
}

export function statusReport(s: GuardSession, now: number, cfg: Config): string {
  const clock = (t: number) => new Date(t).toISOString().slice(11, 19)
  const lines = ['guardrail status']
  lines.push(s.dryRuns.length === 0 ? 'dry runs: none yet' : 'dry runs:')
  for (const d of s.dryRuns) lines.push(`  ${d.key} at ${clock(d.at)}`)
  lines.push(`blocked: ${s.blocked}, one-shot passes used: ${s.allowed}`)
  if (s.pending) lines.push(`pending: ${s.pending.kind} ${s.pending.label} (${s.pending.rule}): ${s.pending.command}`)
  const a = live(s, now)
  lines.push(a ? `allowance: ${a.kind}, ${Math.max(1, Math.ceil((a.expiresAt - now) / 60_000))} min left` : 'allowance: none')
  lines.push(
    `options: blockNoVerify=${cfg.blockNoVerify} blockLive=${cfg.blockLive} scope=${cfg.scope} allowMinutes=${cfg.allowMinutes} typedAllow=${cfg.requireTypedAllow}` +
      (cfg.disabled.size > 0 ? ` disabled=${[...cfg.disabled].join(',')}` : ''),
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------- decision

/** What to do with a Bash, PowerShell or Monitor command, given the session's state. */
export function judge(command: string, dialect: Dialect, cfg: Config, s: GuardSession, now: number): Verdict {
  const segs = expand(command, dialect)
  const shown = redact(command)
  const allowance = live(s, now)

  if (cfg.blockNoVerify) {
    let found: { rule: string; label: string } | undefined
    const persisted: Record<string, string> = {}
    for (const seg of segs) {
      if (!seg.isWrapper) found ??= hookBypass(seg, persisted)
      Object.assign(persisted, seg.assigns)
    }
    if (!found && residualBypass(segs)) found = { rule: 'git-no-verify', label: 'git hook skip (indirect)' }
    if (found) {
      const block: GuardBlock = { kind: 'no-verify', rule: found.rule, label: found.label, command: shown, at: now }
      const message = denyNoVerify(command)
      return allowance?.kind === 'no-verify'
        ? { kind: 'allow-once', what: 'no-verify', label: found.label, block, message }
        : { kind: 'deny', block, message }
    }
  }

  const hits = segs.flatMap(seg => classify(seg, cfg) ?? [])
  if (hits.length === 0) return { kind: 'pass' }
  const dry = hits.filter(h => h.mode === 'dry')
  const lives = hits.filter(h => h.mode === 'live')
  if (!cfg.blockLive) return dry.length > 0 ? { kind: 'record', dry, live: [], command: shown } : { kind: 'pass' }

  const known = new Set(s.dryRuns.map(d => d.key))
  const locked = lives.filter(h => (cfg.scope === 'session' ? s.dryRuns.length === 0 : !known.has(h.key)))
  const first = locked[0]
  if (first) {
    const block: GuardBlock = { kind: 'live', rule: first.rule, key: first.key, label: first.label, command: shown, at: now }
    const message = denyLive(first, dry.some(h => h.key === first.key))
    return allowance?.kind === 'live'
      ? { kind: 'allow-once', what: 'live', label: first.label, block, message }
      : { kind: 'deny', block, message }
  }
  return { kind: 'record', dry, live: lives, command: shown }
}

/** True when a run really finished: not denied, not an error, not backgrounded or interrupted, not a Monitor. */
export function succeeded(tool: string, ran: { deny?: unknown; isError?: unknown; result?: unknown }): boolean {
  const r = (ran.result ?? {}) as { backgroundTaskId?: string; interrupted?: boolean }
  return ran.deny === undefined && ran.isError !== true && tool !== 'Monitor' && !r.backgroundTaskId && !r.interrupted
}

// ---------------------------------------------------------------- state reducers

export const recordBlock = (s: GuardSession, block: GuardBlock): GuardSession => ({ ...s, blocked: s.blocked + 1, pending: block })

export function recordDryRuns(s: GuardSession, v: Extract<Verdict, { kind: 'record' }>, now: number): GuardSession {
  const fresh: GuardDryRun[] = v.dry.map(h => ({ key: h.key, label: h.label, rule: h.rule, command: v.command, at: now }))
  const keys = new Set(fresh.map(d => d.key))
  const dryRuns = [...s.dryRuns.filter(d => !keys.has(d.key)), ...fresh].slice(-MAX_DRY_RUNS)
  const cleared = new Set([...keys, ...v.live.map(h => h.key)])
  return { ...s, dryRuns, pending: s.pending?.key && cleared.has(s.pending.key) ? null : s.pending }
}

export const grant = (s: GuardSession, kind: GuardKind, by: 'command' | 'band', now: number, minutes: number): GuardSession => ({
  ...s,
  allowance: { kind, grantedAt: now, expiresAt: now + minutes * 60_000, by },
  pending: null,
})

/** Uses the allowance if it is unexpired and of this kind; an expired one is dropped. */
export function consume(s: GuardSession, kind: GuardKind, now: number): { state: GuardSession; used: boolean } {
  const a = live(s, now)
  if (!a || a.kind !== kind) return { state: !a && s.allowance ? { ...s, allowance: null } : s, used: false }
  return { state: { ...s, allowance: null, allowed: s.allowed + 1, pending: null }, used: true }
}

export const reset = (s: GuardSession): GuardSession => ({ ...s, dryRuns: [], pending: null, allowance: null })
