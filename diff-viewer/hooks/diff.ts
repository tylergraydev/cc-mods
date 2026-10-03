import type { DvGitFile } from '../types'

// Pure diff logic: no `$`, no engine. Line splitting, a Myers line diff, hunks
// in unified form, the cutting of hunks to fit a Code element, and a parser
// for `git diff` output.

/** One line of a diff; a/b are the 0-based old and new line indexes (-1 when absent). */
export type Op = { kind: ' ' | '-' | '+'; text: string; a: number; b: number }
export type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }
export type FileDiff = {
  hunks: Hunk[]
  add: number
  del: number
  isSame: boolean
  isBinary: boolean
  isApprox: boolean
  note?: string
}
export type Eol = 'lf' | 'crlf' | 'mixed' | 'none'

export const NO_NEWLINE = '\\ No newline at end of file'
/** Per-file hunk text over this many chars is kept as stats only. */
export const MAX_GIT_FILE = 204800

/** Lines without their `\r`, whether the text ended in a newline, and which line ending it uses. */
export function splitLines(text: string): { lines: string[]; finalNewline: boolean; eol: Eol } {
  if (text === '') return { lines: [], finalNewline: true, eol: 'none' }
  const lines = text.split('\n')
  let finalNewline = false
  if (lines[lines.length - 1] === '') {
    lines.pop()
    finalNewline = true
  }
  let terminated = 0
  let crlf = 0
  const count = finalNewline ? lines.length : lines.length - 1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const hasCr = line.endsWith('\r')
    if (i < count && hasCr) crlf += 1
    if (i < count) terminated += 1
    if (hasCr) lines[i] = line.slice(0, -1)
  }
  const eol: Eol = terminated === 0 ? 'none' : crlf === terminated ? 'crlf' : crlf === 0 ? 'lf' : 'mixed'
  return { lines, finalNewline, eol }
}

/** A line safe for Code.source: control characters (tab apart) become `·`, long lines are cut. */
export function sanitize(line: string): string {
  const clean = line.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '·')
  return clean.length > 1000 ? `${clean.slice(0, 999)}…` : clean
}

export const isBinary = (text: string): boolean => text.includes('\u0000')

type DiffOpts = { maxD?: number; noNlA?: boolean; noNlB?: boolean }

/** Myers' O((N+M)D) line diff over the part left after trimming the common ends. */
export function diffLines(a: string[], b: string[], opts: DiffOpts = {}): { ops: Op[]; isApprox: boolean } {
  const maxD = opts.maxD ?? 2000
  const ids = new Map<string, number>()
  const intern = (text: string) => {
    let id = ids.get(text)
    if (id === undefined) {
      id = ids.size
      ids.set(text, id)
    }
    return id
  }
  const A = a.map((t, i) => intern(opts.noNlA && i === a.length - 1 ? `${t}\u0000` : t))
  const B = b.map((t, i) => intern(opts.noNlB && i === b.length - 1 ? `${t}\u0000` : t))

  let lo = 0
  while (lo < A.length && lo < B.length && A[lo] === B[lo]) lo += 1
  let hiA = A.length
  let hiB = B.length
  while (hiA > lo && hiB > lo && A[hiA - 1] === B[hiB - 1]) {
    hiA -= 1
    hiB -= 1
  }
  const n = hiA - lo
  const m = hiB - lo

  const mid: Op[] = []
  let isApprox = false
  const fallback = () => {
    isApprox = true
    mid.length = 0
    for (let i = 0; i < n; i++) mid.push({ kind: '-', text: a[lo + i] as string, a: lo + i, b: -1 })
    for (let j = 0; j < m; j++) mid.push({ kind: '+', text: b[lo + j] as string, a: -1, b: lo + j })
  }

  if (n === 0 || m === 0) {
    for (let i = 0; i < n; i++) mid.push({ kind: '-', text: a[lo + i] as string, a: lo + i, b: -1 })
    for (let j = 0; j < m; j++) mid.push({ kind: '+', text: b[lo + j] as string, a: -1, b: lo + j })
  } else {
    const limit = Math.min(n + m, maxD)
    const off = limit + 1
    const v = new Int32Array(2 * limit + 3)
    v[off + 1] = 0
    const trace: Int32Array[] = []
    let found = -1
    for (let d = 0; d <= limit && found < 0; d++) {
      // the state this round starts from, for backtracking: k in [-d-1, d+1]
      trace.push(v.slice(off - d - 1, off + d + 2))
      for (let k = -d; k <= d; k += 2) {
        let x: number
        if (k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number))) x = v[off + k + 1] as number
        else x = (v[off + k - 1] as number) + 1
        let y = x - k
        while (x < n && y < m && A[lo + x] === B[lo + y]) {
          x += 1
          y += 1
        }
        v[off + k] = x
        if (x >= n && y >= m) {
          found = d
          break
        }
      }
    }
    if (found < 0) {
      fallback()
    } else {
      const back: Op[] = []
      let x = n
      let y = m
      for (let d = found; d >= 0; d--) {
        const vs = trace[d] as Int32Array
        const at = (k: number) => vs[k + d + 1] as number
        const k = x - y
        let prevX = 0
        let prevY = 0
        if (d > 0) {
          const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
          prevX = at(prevK)
          prevY = prevX - prevK
        }
        while (x > prevX && y > prevY) {
          x -= 1
          y -= 1
          back.push({ kind: ' ', text: a[lo + x] as string, a: lo + x, b: lo + y })
        }
        if (d > 0) {
          if (x === prevX) back.push({ kind: '+', text: b[lo + prevY] as string, a: -1, b: lo + prevY })
          else back.push({ kind: '-', text: a[lo + prevX] as string, a: lo + prevX, b: -1 })
          x = prevX
          y = prevY
        }
      }
      for (let i = back.length - 1; i >= 0; i--) mid.push(back[i] as Op)
    }
  }

  const ops: Op[] = []
  for (let i = 0; i < lo; i++) ops.push({ kind: ' ', text: a[i] as string, a: i, b: i })
  // every run of changes: all `-` before all `+`, as git writes them
  let i = 0
  while (i < mid.length) {
    const op = mid[i] as Op
    if (op.kind === ' ') {
      ops.push(op)
      i += 1
      continue
    }
    const minus: Op[] = []
    const plus: Op[] = []
    while (i < mid.length && (mid[i] as Op).kind !== ' ') {
      const one = mid[i] as Op
      if (one.kind === '-') minus.push(one)
      else plus.push(one)
      i += 1
    }
    ops.push(...minus, ...plus)
  }
  for (let t = 0; t < A.length - hiA; t++) ops.push({ kind: ' ', text: a[hiA + t] as string, a: hiA + t, b: hiB + t })
  return { ops, isApprox }
}

/** The ops cut into hunks with `context` lines around each change. */
export function buildHunks(ops: Op[], context: number, noNl: { old: boolean; new: boolean }): Hunk[] {
  const changes: number[] = []
  ops.forEach((op, i) => {
    if (op.kind !== ' ') changes.push(i)
  })
  if (changes.length === 0) return []
  let lastOld = -1
  let lastNew = -1
  for (const op of ops) {
    if (op.a > lastOld) lastOld = op.a
    if (op.b > lastNew) lastNew = op.b
  }
  const oldBefore: number[] = []
  const newBefore: number[] = []
  let oc = 0
  let nc = 0
  for (const op of ops) {
    oldBefore.push(oc)
    newBefore.push(nc)
    if (op.kind !== '+') oc += 1
    if (op.kind !== '-') nc += 1
  }

  const groups: Array<[number, number]> = []
  for (const idx of changes) {
    const last = groups[groups.length - 1]
    if (last && idx - last[1] - 1 <= 2 * context) last[1] = idx
    else groups.push([idx, idx])
  }

  const hunks: Hunk[] = []
  for (const [first, last] of groups) {
    const start = Math.max(0, first - context)
    const end = Math.min(ops.length - 1, last + context)
    const lines: string[] = []
    let oldCount = 0
    let newCount = 0
    for (let i = start; i <= end; i++) {
      const op = ops[i] as Op
      lines.push(op.kind + sanitize(op.text))
      if (op.kind !== '+') oldCount += 1
      if (op.kind !== '-') newCount += 1
      const endsOld = op.kind !== '+' && noNl.old && op.a === lastOld
      const endsNew = op.kind !== '-' && noNl.new && op.b === lastNew
      if (endsOld || endsNew) lines.push(NO_NEWLINE)
    }
    const ob = oldBefore[start] as number
    const nb = newBefore[start] as number
    hunks.push({
      oldStart: oldCount === 0 ? ob : ob + 1,
      oldCount,
      newStart: newCount === 0 ? nb : nb + 1,
      newCount,
      lines,
    })
  }
  return hunks
}

export const hunkText = (h: Hunk): string => `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@\n${h.lines.join('\n')}`.replace(/\n$/, '')
export const unified = (hunks: Hunk[]): string => hunks.map(hunkText).join('\n')

const eolLabel = (e: Eol) => (e === 'crlf' ? 'CRLF' : e === 'lf' ? 'LF' : 'mixed')

/** The diff of two texts: hunks, counts and notes. */
export function diffTexts(before: string, after: string, context: number, opts: { maxD?: number } = {}): FileDiff {
  if (isBinary(before) || isBinary(after)) {
    return { hunks: [], add: -1, del: -1, isSame: false, isBinary: true, isApprox: false }
  }
  const a = splitLines(before)
  const b = splitLines(after)
  const { ops, isApprox } = diffLines(a.lines, b.lines, {
    maxD: opts.maxD,
    noNlA: !a.finalNewline && a.lines.length > 0,
    noNlB: !b.finalNewline && b.lines.length > 0,
  })
  const hunks = buildHunks(ops, context, { old: !a.finalNewline && a.lines.length > 0, new: !b.finalNewline && b.lines.length > 0 })
  let add = 0
  let del = 0
  for (const op of ops) {
    if (op.kind === '+') add += 1
    else if (op.kind === '-') del += 1
  }
  const out: FileDiff = { hunks, add, del, isSame: hunks.length === 0 && before === after, isBinary: false, isApprox }
  if (a.eol !== b.eol && a.eol !== 'none' && b.eol !== 'none') out.note = `line endings ${eolLabel(a.eol)} → ${eolLabel(b.eol)}`
  return out
}

/** A hunk cut into consecutive pieces whose text fits in `maxChars`; a no-newline marker stays with its line. */
export function splitHunk(h: Hunk, maxChars: number): Hunk[] {
  if (hunkText(h).length <= maxChars) return [h]
  const budget = Math.max(100, maxChars - 60)
  const pieces: Hunk[] = []
  let oldBase = h.oldCount === 0 ? h.oldStart : h.oldStart - 1
  let newBase = h.newCount === 0 ? h.newStart : h.newStart - 1
  let cur: string[] = []
  let size = 0
  const flush = () => {
    if (cur.length === 0) return
    const oc = cur.filter(l => l[0] === ' ' || l[0] === '-').length
    const nc = cur.filter(l => l[0] === ' ' || l[0] === '+').length
    pieces.push({ oldStart: oc === 0 ? oldBase : oldBase + 1, oldCount: oc, newStart: nc === 0 ? newBase : newBase + 1, newCount: nc, lines: cur })
    oldBase += oc
    newBase += nc
    cur = []
    size = 0
  }
  for (const line of h.lines) {
    const isMarker = line.startsWith('\\')
    if (!isMarker && cur.length > 0 && size + line.length + 1 > budget) flush()
    cur.push(line)
    size += line.length + 1
  }
  flush()
  return pieces
}

/** Hunks packed into sources for Code elements (each under maxChars), stopping past maxTotal chars. */
export function codeChunks(hunks: Hunk[], maxChars = 9000, maxTotal = 120_000): { sources: string[]; droppedHunks: number } {
  const pieces = hunks.flatMap(h => splitHunk(h, maxChars)).map(hunkText)
  const sources: string[] = []
  let cur = ''
  let total = 0
  let used = 0
  for (const text of pieces) {
    if (total > maxTotal) break
    if (cur !== '' && cur.length + 1 + text.length > maxChars) {
      sources.push(cur)
      cur = ''
    }
    cur = cur === '' ? text : `${cur}\n${text}`
    total += text.length + 1
    used += 1
  }
  if (cur !== '') sources.push(cur)
  return { sources, droppedHunks: pieces.length - used }
}

/** The new lines after applying hunks to the old ones; for tests, to prove a diff round-trips. */
export function applyHunks(beforeLines: string[], hunks: Hunk[]): string[] {
  const out: string[] = []
  let pos = 0
  for (const h of hunks) {
    const base = h.oldCount === 0 ? h.oldStart : h.oldStart - 1
    while (pos < base) out.push(beforeLines[pos++] as string)
    for (const line of h.lines) {
      if (line[0] === ' ' || line[0] === '+') out.push(line.slice(1))
    }
    pos = base + h.oldCount
  }
  while (pos < beforeLines.length) out.push(beforeLines[pos++] as string)
  return out
}

/** Hunks from unified-diff text (the part of a git diff from the first `@@`). */
export function parseHunks(text: string): Hunk[] {
  const hunks: Hunk[] = []
  let cur: Hunk | undefined
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
    if (head) {
      cur = { oldStart: Number(head[1]), oldCount: head[2] === undefined ? 1 : Number(head[2]), newStart: Number(head[3]), newCount: head[4] === undefined ? 1 : Number(head[4]), lines: [] }
      hunks.push(cur)
    } else if (cur) {
      const c = raw[0]
      if (c === ' ' || c === '+' || c === '-') cur.lines.push(c + sanitize(raw.slice(1)))
      else if (c === '\\') cur.lines.push(NO_NEWLINE)
      else if (raw === '') cur.lines.push(' ')
    }
  }
  return hunks
}

const unquote = (p: string): string => {
  let s = p.replace(/\t.*$/, '')
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).replace(/\\(["\\])/g, '$1')
  return s
}

/** `git diff` output as one record per file. Keys are the paths, lowercased when `lowerKeys`. */
export function parseGitDiff(stdout: string, lowerKeys = false): DvGitFile[] {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n')
  const blocks: string[][] = []
  for (const line of lines) {
    if (line.startsWith('diff --git ')) blocks.push([line])
    else blocks[blocks.length - 1]?.push(line)
  }
  const files: DvGitFile[] = []
  for (const block of blocks) {
    const first = block.findIndex(l => l.startsWith('@@'))
    const header = first < 0 ? block : block.slice(0, first)
    let status: DvGitFile['status'] = 'modified'
    let from: string | undefined
    let renameTo: string | undefined
    let oldPath: string | undefined
    let newPath: string | undefined
    for (const l of header.slice(1)) {
      if (l.startsWith('new file mode')) status = 'added'
      else if (l.startsWith('deleted file mode')) status = 'deleted'
      else if (l.startsWith('rename from ')) from = unquote(l.slice(12))
      else if (l.startsWith('rename to ')) renameTo = unquote(l.slice(10))
      else if (l.startsWith('Binary files ')) status = 'binary'
      else if (l.startsWith('--- ')) oldPath = unquote(l.slice(4))
      else if (l.startsWith('+++ ')) newPath = unquote(l.slice(4))
    }
    if (from !== undefined && renameTo !== undefined && status === 'modified') status = 'renamed'
    const strip = (p: string | undefined) => (p === undefined || p === '/dev/null' ? undefined : p.replace(/^[ab]\//, ''))
    let path = renameTo ?? strip(newPath) ?? strip(oldPath)
    if (path === undefined) {
      const rest = (block[0] as string).slice(11)
      const cut = rest.lastIndexOf(' b/')
      path = unquote(cut >= 0 ? rest.slice(cut + 3) : rest)
    }
    const body = first < 0 ? [] : block.slice(first)
    while (body.length > 0 && body[body.length - 1] === '') body.pop()
    let add = 0
    let del = 0
    for (const l of body) {
      if (l[0] === '+') add += 1
      else if (l[0] === '-') del += 1
    }
    const text = body.join('\n')
    const isTooLarge = text.length > MAX_GIT_FILE
    const file: DvGitFile = { key: lowerKeys ? path.toLowerCase() : path, rel: path, status, hunks: isTooLarge ? '' : text, add, del, isTooLarge }
    if (from !== undefined) file.from = from
    files.push(file)
  }
  return files
}
