import { expect, test } from 'claude-code/testing'

import { applyHunks, codeChunks, diffLines, diffTexts, isBinary, parseGitDiff, sanitize, splitHunk, splitLines, unified, hunkText } from '../hooks/diff'
import type { Hunk } from '../hooks/diff'

/** diffTexts, plus the proof that its hunks turn the old lines into the new ones. */
function check(before: string, after: string, context = 3) {
  const d = diffTexts(before, after, context)
  expect(applyHunks(splitLines(before).lines, d.hunks)).toEqual(splitLines(after).lines)
  return d
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i + 1}`)

test('empty before: everything is added', async () => {
  const d = check('', 'a\nb\n')
  expect(unified(d.hunks)).toBe('@@ -0,0 +1,2 @@\n+a\n+b')
  expect([d.add, d.del]).toEqual([2, 0])
})

test('identical texts have no hunks', async () => {
  const d = check('a\nb\n', 'a\nb\n')
  expect(d.hunks).toEqual([])
  expect(d.isSame).toBe(true)
  expect([d.add, d.del]).toEqual([0, 0])
})

test('insert-only and delete-only', async () => {
  expect(unified(check('a\nb\nc\n', 'a\nb\nX\nc\n').hunks)).toBe('@@ -1,3 +1,4 @@\n a\n b\n+X\n c')
  expect(unified(check('a\nb\nc\n', 'a\nc\n').hunks)).toBe('@@ -1,3 +1,2 @@\n a\n-b\n c')
})

test('delete to empty', async () => {
  expect(unified(check('a\n', '').hunks)).toBe('@@ -1,1 +0,0 @@\n-a')
})

test('a moved block is two deletions and two additions', async () => {
  const before = lines(10).join('\n') + '\n'
  const moved = lines(10).filter(l => l !== 'l2' && l !== 'l3')
  moved.splice(6, 0, 'l2', 'l3')
  const d = check(before, moved.join('\n') + '\n')
  expect([d.add, d.del]).toEqual([2, 2])
  const text = unified(d.hunks)
  for (const one of ['-l2', '-l3', '+l2', '+l3']) expect(text).toContain(one)
})

test('a replacement lists the deletion before the addition', async () => {
  const d = check('a\nb\nc\n', 'a\nB\nc\n')
  expect(unified(d.hunks)).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c')
})

test('CRLF files diff without carriage returns', async () => {
  const d = check('a\r\nb\r\n', 'a\r\nc\r\n')
  expect(unified(d.hunks)).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+c')
  expect(unified(d.hunks)).not.toContain('\r')
  expect(d.note).toBeUndefined()
})

test('a line-ending flip alone is noted, not diffed', async () => {
  const d = diffTexts('a\r\nb\r\n', 'a\nb\n', 3)
  expect(d.hunks).toEqual([])
  expect(d.isSame).toBe(false)
  expect(d.note).toContain('CRLF → LF')
})

test('a missing final newline is its own change', async () => {
  const d = check('a\nb', 'a\nb\n')
  expect(unified(d.hunks)).toBe('@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b')
})

test('hunks merge when the gap between changes is within twice the context', async () => {
  const before = lines(20)
  const change = (...at: number[]) => {
    const copy = [...before]
    for (const i of at) copy[i - 1] = `X${i}`
    return copy.join('\n') + '\n'
  }
  const b = before.join('\n') + '\n'
  expect(check(b, change(5, 10)).hunks.map(h => hunkText(h).split('\n')[0])).toEqual(['@@ -2,12 +2,12 @@'])
  expect(check(b, change(5, 15)).hunks.map(h => hunkText(h).split('\n')[0])).toEqual(['@@ -2,7 +2,7 @@', '@@ -12,7 +12,7 @@'])
  expect(check(b, change(5), 0).hunks.map(h => hunkText(h).split('\n')[0])).toEqual(['@@ -5,1 +5,1 @@'])
})

test('past the edit budget the diff is a valid block replacement', async () => {
  const a = lines(12)
  const b = [...a]
  b[2] = 'X'
  b[9] = 'Y'
  const { ops, isApprox } = diffLines(a, b, { maxD: 1 })
  expect(isApprox).toBe(true)
  expect(ops.filter(o => o.kind === '+').length).toBeGreaterThan(2)
  const exact = diffLines(a, b)
  expect(exact.isApprox).toBe(false)
  expect(exact.ops.filter(o => o.kind !== ' ').length).toBe(4)
})

test('a NUL byte makes a text binary', async () => {
  expect(isBinary('a\u0000b')).toBe(true)
  const d = diffTexts('a\u0000b', 'a', 3)
  expect(d.isBinary).toBe(true)
  expect(d.hunks).toEqual([])
})

test('sanitize keeps tabs, drops control characters and cuts long lines', async () => {
  const clean = sanitize('\x1b[31mred\x1b[0m\tend')
  expect(/[\x00-\x08\x0B-\x1F\x7F]/.test(clean)).toBe(false)
  expect(clean).toContain('\t')
  expect(sanitize('x'.repeat(1500)).length).toBeLessThanOrEqual(1000)
})

test('splitHunk and codeChunks keep every piece under the limit', async () => {
  const body = Array.from({ length: 300 }, (_, i) => `+${String(i).padStart(3, '0')}${'x'.repeat(46)}`)
  const h: Hunk = { oldStart: 0, oldCount: 0, newStart: 1, newCount: 300, lines: body }
  const pieces = splitHunk(h, 9000)
  expect(pieces.length).toBeGreaterThan(1)
  for (const p of pieces) expect(hunkText(p).length).toBeLessThanOrEqual(9000)
  expect(pieces.reduce((n, p) => n + p.newCount, 0)).toBe(300)
  expect(pieces.reduce((n, p) => n + p.oldCount, 0)).toBe(0)
  for (let i = 1; i < pieces.length; i++) {
    const prev = pieces[i - 1] as Hunk
    expect((pieces[i] as Hunk).newStart).toBe(prev.newStart + prev.newCount)
  }
  const all = codeChunks([h], 9000)
  expect(all.droppedHunks).toBe(0)
  for (const src of all.sources) expect(src.length).toBeLessThanOrEqual(9000)
  const cut = codeChunks([h, h, h], 9000, 5000)
  expect(cut.droppedHunks).toBeGreaterThan(0)
})

test('parseGitDiff reads modified, added, deleted, renamed and binary files', async () => {
  const out = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' keep',
    '-old',
    '--- x',
    '+new1',
    '+new2',
    'diff --git a/b.ts b/b.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/b.ts',
    '@@ -0,0 +1,1 @@',
    '+hi',
    'diff --git a/c.ts b/c.ts',
    'deleted file mode 100644',
    '--- a/c.ts',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-bye',
    'diff --git a/old.ts b/new.ts',
    'similarity index 100%',
    'rename from old.ts',
    'rename to new.ts',
    'diff --git a/img.png b/img.png',
    'Binary files a/img.png and b/img.png differ',
    '',
  ].join('\r\n')
  const files = parseGitDiff(out)
  expect(files.map(f => [f.rel, f.status, f.add, f.del])).toEqual([
    ['src/a.ts', 'modified', 2, 2],
    ['b.ts', 'added', 1, 0],
    ['c.ts', 'deleted', 0, 1],
    ['new.ts', 'renamed', 0, 0],
    ['img.png', 'binary', 0, 0],
  ])
  expect(files[3]?.from).toBe('old.ts')
  for (const f of files) expect(f.hunks).not.toContain('\r')
  expect(parseGitDiff(out, true)[0]?.key).toBe('src/a.ts')
})
