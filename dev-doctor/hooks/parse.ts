import type { DoctorStatus } from '../types'

// Pure parsers for the doctor's checks: text in, plain values out. No `$`,
// no I/O. The secret-bearing ones (dotenv, user-secrets) return key names and
// booleans only, so a value never leaves the function that read it.

const lines = (text: string) => text.split(/\r?\n/)

// ---- bash --------------------------------------------------------------

/** `where.exe` output: the paths found, in PATH order. */
export function parseWhere(text: string): string[] {
  return lines(text)
    .map(line => line.trim())
    .filter(line => line !== '' && !/^INFO:/i.test(line))
}

export type Verdict = { status: DoctorStatus; evidence: string; fix?: string }

const GIT_BASH = /\\Git\\(usr\\)?bin\\bash\.exe$/i

/** Judges which bash.exe a bare `bash` resolves to. */
export function classifyBash(found: string[], isEnvSet: boolean): Verdict {
  const first = found[0]?.replaceAll('/', '\\')
  const note = isEnvSet ? '; CLAUDE_CODE_GIT_BASH_PATH is set' : ''
  if (first === undefined) {
    return { status: 'warn', evidence: `no bash on PATH${note}` }
  }
  const nth = `(1st of ${found.length})`
  if (/\\WindowsApps\\/i.test(first)) {
    return {
      status: 'fail',
      evidence: `${first} is the WindowsApps alias, not Git bash ${nth}${note}`,
      fix: 'Settings > Apps > Advanced app settings > App execution aliases: turn off bash.exe',
    }
  }
  if (/\\Windows\\System32\\bash\.exe$/i.test(first)) {
    return {
      status: 'fail',
      evidence: `${first} is WSL bash, not Git bash ${nth}${note}`,
      fix: [
        '# needs an elevated shell: put Git first on the machine Path',
        "$git='C:\\Program Files\\Git\\bin'; [Environment]::SetEnvironmentVariable('Path', \"$git;\" + [Environment]::GetEnvironmentVariable('Path','Machine'), 'Machine')",
        "# no admin: npm config set script-shell 'C:\\Program Files\\Git\\bin\\bash.exe'",
      ].join('\n'),
    }
  }
  if (GIT_BASH.test(first)) return { status: 'pass', evidence: `${first} ${nth}${note}` }
  return { status: 'warn', evidence: `${first} is not Git bash ${nth}${note}` }
}

// ---- .NET ---------------------------------------------------------------

export type GlobalJson = { version?: string; rollForward?: string; allowPrerelease?: boolean }

/** Removes line and block comments, leaving string contents alone. */
function stripComments(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!
    const n = text[i + 1]
    if (inString) {
      out += c
      if (c === '\\') {
        out += n ?? ''
        i += 1
      } else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      out += '\n'
    } else if (c === '/' && n === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
    } else out += c
  }
  return out
}

/** global.json's `sdk` section; `{}` when it has none, `null` when malformed. */
export function parseGlobalJson(text: string): GlobalJson | null {
  try {
    const json = JSON.parse(stripComments(text)) as { sdk?: Record<string, unknown> } | null
    const sdk = json?.sdk
    if (!sdk || typeof sdk !== 'object') return {}
    const out: GlobalJson = {}
    if (typeof sdk.version === 'string') out.version = sdk.version
    if (typeof sdk.rollForward === 'string') out.rollForward = sdk.rollForward
    if (typeof sdk.allowPrerelease === 'boolean') out.allowPrerelease = sdk.allowPrerelease
    return out
  } catch {
    return null
  }
}

/** `dotnet --list-sdks` rows: `8.0.404 [C:\Program Files\dotnet\sdk]`. */
export function parseSdks(text: string): { version: string; path: string }[] {
  const out: { version: string; path: string }[] = []
  for (const line of lines(text)) {
    const m = /^(\S+)\s+\[(.+)\]\s*$/.exec(line.trim())
    if (m) out.push({ version: m[1]!, path: m[2]! })
  }
  return out
}

/** `dotnet --list-runtimes` rows: `Microsoft.NETCore.App 8.0.11 [path]`. */
export function parseRuntimes(text: string): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = []
  for (const line of lines(text)) {
    const m = /^(\S+)\s+(\S+)\s+\[(.+)\]\s*$/.exec(line.trim())
    if (m) out.push({ name: m[1]!, version: m[2]! })
  }
  return out
}

type Ver = { major: number; minor: number; band: number; pp: number; isPre: boolean }

function parseVer(text: string): Ver | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(text.trim())
  if (!m) return undefined
  const patch = Number(m[3])
  return { major: Number(m[1]), minor: Number(m[2]), band: Math.floor(patch / 100), pp: patch % 100, isPre: m[4] !== undefined }
}

const order = (a: Ver, b: Ver) =>
  a.major - b.major || a.minor - b.minor || a.band - b.band || a.pp - b.pp

/** Whether any installed SDK satisfies global.json under its roll-forward policy. */
export function satisfies(installed: string[], req: GlobalJson): boolean {
  const want = req.version === undefined ? undefined : parseVer(req.version)
  const usable = installed
    .map(parseVer)
    .filter((v): v is Ver => v !== undefined)
    .filter(v => !v.isPre || req.allowPrerelease === true || want?.isPre === true)
  if (req.version === undefined) return usable.length > 0
  if (!want) return false
  const policy = req.rollForward ?? 'patch'
  return usable.some(v => {
    switch (policy) {
      case 'disable':
        return order(v, want) === 0
      case 'feature':
      case 'latestFeature':
        return v.major === want.major && v.minor === want.minor && (v.band > want.band || (v.band === want.band && v.pp >= want.pp))
      case 'minor':
      case 'latestMinor':
        return v.major === want.major && order(v, want) >= 0
      case 'major':
      case 'latestMajor':
        return order(v, want) >= 0
      default:
        return v.major === want.major && v.minor === want.minor && v.band === want.band && v.pp >= want.pp
    }
  })
}

// ---- ports and processes ------------------------------------------------

/** Listening rows of `netstat -ano`: the port after the last `:`, the owner's PID. */
export function parseNetstat(text: string): { port: number; pid: number }[] {
  const out: { port: number; pid: number }[] = []
  for (const line of lines(text)) {
    const f = line.trim().split(/\s+/)
    if (f[0] !== 'TCP' || f[3] !== 'LISTENING') continue
    const local = f[1] ?? ''
    const port = Number(local.slice(local.lastIndexOf(':') + 1))
    const pid = Number(f[4])
    if (Number.isInteger(port) && Number.isInteger(pid)) out.push({ port, pid })
  }
  return out
}

/** One quoted CSV row's fields (`"45,000 K"` has a comma inside). */
function csvFields(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (const c of line) {
    if (c === '"') inQuote = !inQuote
    else if (c === ',' && !inQuote) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

/** `tasklist /FO CSV /NH`: image name and PID per row. */
export function parseTasklistCsv(text: string): { image: string; pid: number }[] {
  const out: { image: string; pid: number }[] = []
  for (const line of lines(text)) {
    if (!line.startsWith('"')) continue
    const f = csvFields(line.trim())
    const pid = Number(f[1])
    if (f[0] && Number.isInteger(pid)) out.push({ image: f[0], pid })
  }
  return out
}

export type CimProc = { pid: number; name: string; created?: number; cmd: string | null }

/** `Get-CimInstance Win32_Process | ConvertTo-Json`: one object or an array. */
export function parseCim(text: string): CimProc[] {
  try {
    const json = JSON.parse(text.trim() || 'null') as unknown
    const list = Array.isArray(json) ? json : json ? [json] : []
    const out: CimProc[] = []
    for (const item of list as Record<string, unknown>[]) {
      const pid = Number(item.ProcessId)
      if (!Number.isInteger(pid)) continue
      const raw = item.CreationDate
      const slash = typeof raw === 'string' ? /\/Date\((-?\d+)\)\//.exec(raw) : null
      const parsed = slash ? Number(slash[1]) : typeof raw === 'string' ? Date.parse(raw) : NaN
      out.push({
        pid,
        name: typeof item.Name === 'string' ? item.Name : '',
        ...(Number.isFinite(parsed) ? { created: parsed } : {}),
        cmd: typeof item.CommandLine === 'string' ? item.CommandLine : null,
      })
    }
    return out
  } catch {
    return []
  }
}

/** Whether an image name is the process called `name` (`Worker`, `Shop.Worker.exe`). */
export function matchesImage(image: string, name: string): boolean {
  const n = name.toLowerCase().replace(/\.exe$/, '')
  const i = image.toLowerCase()
  return n !== '' && (i === n || i === `${n}.exe` || i.endsWith(`.${n}.exe`))
}

/** Whether a command line names the repo's root, slash and case aside. */
export function inRepo(cmd: string, root: string): boolean {
  const norm = (s: string) => s.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '')
  return norm(cmd).includes(norm(root))
}

// ---- git and docker ----------------------------------------------------

export type Worktree = {
  path: string
  head?: string
  branch?: string
  isBare: boolean
  isDetached: boolean
  locked?: string
  prunable?: string
}

/** `git worktree list --porcelain`. */
export function parseWorktrees(text: string): Worktree[] {
  const out: Worktree[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    let one: Worktree | undefined
    for (const line of lines(block)) {
      const [key, ...rest] = line.trim().split(' ')
      const value = rest.join(' ')
      if (key === 'worktree') one = { path: value, isBare: false, isDetached: false }
      else if (!one) continue
      else if (key === 'HEAD') one.head = value
      else if (key === 'branch') one.branch = value
      else if (key === 'bare') one.isBare = true
      else if (key === 'detached') one.isDetached = true
      else if (key === 'locked') one.locked = value
      else if (key === 'prunable') one.prunable = value
    }
    if (one) out.push(one)
  }
  return out
}

export type Exited = { id: string; name: string; image: string; status: string; ageHours: number | null }

const HOURS = { second: 1 / 3600, minute: 1 / 60, hour: 1, day: 24, week: 168, month: 720 } as const

/** The hours since an `Exited (137) 3 days ago` status; null when it does not read. */
export function exitedAgeHours(status: string): number | null {
  const m = /^Exited \(\d+\) (.*) ago/.exec(status.trim())
  if (!m) return null
  if (/^Less than/i.test(m[1]!)) return 0
  const t = /^(?:About )?(an?|\d+) (second|minute|hour|day|week|month)s?$/i.exec(m[1]!)
  if (!t) return null
  const n = /^an?$/i.test(t[1]!) ? 1 : Number(t[1])
  return n * HOURS[t[2]!.toLowerCase() as keyof typeof HOURS]
}

/** `docker ps -a` rows of `ID<TAB>Names<TAB>Image<TAB>Status`. */
export function parseDockerPs(text: string): Exited[] {
  const out: Exited[] = []
  for (const line of lines(text)) {
    const [id, name, image, status] = line.split('\t')
    if (!id || status === undefined) continue
    out.push({ id, name: name ?? '', image: image ?? '', status, ageHours: exitedAgeHours(status) })
  }
  return out
}

// ---- node ----------------------------------------------------------------

/** `node --version` as `v22.11.0`: the major. */
export function parseNodeVersion(text: string): number | undefined {
  const m = /^v(\d+)\.(\d+)\.(\d+)/.exec(text.trim())
  return m ? Number(m[1]) : undefined
}

/** `.nvmrc` / `.node-version`: `22`, `v22.11.0`; an alias like `lts/jod` is unknown. */
export function parseNodeWant(text: string): number | undefined {
  const m = /^v?(\d+)/.exec(text.trim())
  return m ? Number(m[1]) : undefined
}

/** package.json `engines.node`: the first number in the range. */
export function parseEnginesNode(text: string): number | undefined {
  try {
    const range = (JSON.parse(text) as { engines?: { node?: unknown } }).engines?.node
    const m = typeof range === 'string' ? /\d+/.exec(range) : null
    return m ? Number(m[0]) : undefined
  } catch {
    return undefined
  }
}

// ---- AUTH_SECRET: key names and booleans, never values -------------------

/** `.env` text: each key and whether it has a non-empty value. */
export function parseDotenvKeys(text: string): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const raw of lines(text)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.:-]*)\s*=(.*)$/.exec(line)
    if (!m) continue
    const value = m[2]!.trim().replace(/^(["'])(.*)\1$/, '$2')
    out.set(m[1]!, value !== '')
  }
  return out
}

/** A secrets.json tree flattened to `Parameters:auth-secret` keys and non-empty flags. */
export function flattenKeys(json: unknown, prefix = ''): Map<string, boolean> {
  const out = new Map<string, boolean>()
  if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
    for (const [key, value] of Object.entries(json)) {
      const name = prefix === '' ? key : `${prefix}:${key}`
      if (value !== null && typeof value === 'object') {
        for (const [k, v] of flattenKeys(value, name)) out.set(k, v)
      } else out.set(name, value !== null && value !== '')
    }
  }
  return out
}

/** secrets.json text to its keys; empty when it does not parse. */
export function parseSecretsKeys(text: string): Map<string, boolean> {
  try {
    return flattenKeys(JSON.parse(text))
  } catch {
    return new Map()
  }
}

/** The `<UserSecretsId>` of a csproj. */
export function parseUserSecretsId(csproj: string): string | undefined {
  return /<UserSecretsId>\s*([^<\s]+)\s*<\/UserSecretsId>/.exec(csproj)?.[1]
}

const norm = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '')

/** The keys that name the auth secret and hold something. */
export function authKeys(keys: Map<string, boolean>): string[] {
  return [...keys].filter(([k, filled]) => filled && norm(k).endsWith('authsecret')).map(([k]) => k)
}

export type SecretSource = { label: string; keys: Map<string, boolean> }

/** The check's verdict from where the secret is defined and whether AppHost code forwards it. */
export function evalAuthSecret(sources: SecretSource[], isForwarded: boolean, appHost: string): Verdict {
  const found = sources.flatMap(({ label, keys }) => {
    const names = authKeys(keys)
    return names.length > 0 ? [`${label} (${names.join(', ')})`] : []
  })
  if (found.length === 0) {
    return {
      status: 'fail',
      evidence: 'AUTH_SECRET is not defined in user-secrets, the environment or a .env file',
      fix: `$p='${appHost.replaceAll("'", "''")}'; dotnet user-secrets set 'Parameters:auth-secret' (openssl rand -base64 32) --project $p`,
    }
  }
  const where = `found in: ${found.join(', ')}`
  return isForwarded
    ? { status: 'pass', evidence: where }
    : { status: 'warn', evidence: `${where}; no AppHost .cs file mentions AUTH_SECRET or auth-secret (not forwarded?)` }
}
