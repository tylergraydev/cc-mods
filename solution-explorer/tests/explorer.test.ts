import { expect, test } from 'claude-code/testing'

import type { ExEntry, ExGit, ExListing } from '../types'
import {
  buildRules,
  findSolution,
  fileRef,
  fitName,
  flatten,
  gitMarkOf,
  isHidden,
  keyOf,
  parseCommand,
  parsePorcelain,
  parseSln,
  parseSlnx,
  toRel,
} from '../hooks/explorer'
import type { FlattenInput, Io } from '../hooks/explorer'

const file = (name: string): ExEntry => ({ name, kind: 'file', isLink: false })
const dir = (name: string): ExEntry => ({ name, kind: 'dir', isLink: false })
const listing = (...entries: ExEntry[]): ExListing => ({ entries, at: 0 })
const NO_GIT: Pick<ExGit, 'byPath' | 'untrackedDirs'> = { byPath: {}, untrackedDirs: [] }

const input = (over: Partial<FlattenInput> = {}): FlattenInput => ({
  solution: null,
  listings: {},
  expanded: new Set<string>(),
  git: NO_GIT,
  touched: [],
  flags: { showHidden: false, changesOnly: false },
  filterText: '',
  rules: buildRules(undefined, ''),
  maxEntries: 400,
  ...over,
})

const ids = (rows: { id: string }[]) => rows.map(r => r.id)

test('paths: relative to the root, case-insensitive, never outside it', () => {
  expect(toRel('C:/Code/App', 'c:\\code\\app\\src\\A.cs')).toBe('src/A.cs')
  expect(toRel('C:/Code/App', 'C:/Code/Other/x.cs')).toBeNull()
  expect(toRel('C:/Code/App', '..\\x')).toBeNull()
  expect(toRel('C:/Code/App', './src/../b.ts')).toBe('b.ts')
  expect(toRel('C:/Code/App', 'C:\\Code\\App')).toBe('')
  expect(keyOf('C:\\Code\\App\\')).toBe('c:/code/app')
})

test('ignore rules: defaults, a .gitignore subset and the hide config', () => {
  const rules = buildRules(undefined, '')
  for (const name of ['bin', 'obj', 'node_modules', '.vs']) expect(isHidden(name, name, 'dir', rules)).toBe(true)
  expect(isHidden('.claude-plugin/types', 'types', 'dir', rules)).toBe(true)
  expect(isHidden('src', 'src', 'dir', rules)).toBe(false)

  const text = '*.user\n/TestResults/\n# c\n!keep\nlogs/\n**/packages\nfoo/*.tmp\nsrc/gen'
  const r = buildRules(text, '')
  expect(r.exts).toEqual(['.user'])
  expect(r.paths).toContain('testresults')
  expect(r.paths).toContain('src/gen')
  expect(r.dirNames).toEqual(['logs'])
  expect(r.names).toContain('packages')
  expect(r.unsupported).toBe(2)
  expect(isHidden('logs', 'logs', 'file', r)).toBe(false)
  expect(isHidden('Logs', 'Logs', 'dir', r)).toBe(true)
  expect(isHidden('a/B.USER', 'B.USER', 'file', r)).toBe(true)

  const merged = buildRules(undefined, 'TestResults, *.log')
  expect(merged.names).toContain('testresults')
  expect(merged.exts).toEqual(['.log'])
})

test('.sln: projects, solution folders and outside paths', () => {
  const text =
    '\uFEFF\r\nMicrosoft Visual Studio Solution File, Format Version 12.00\r\n' +
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Web", "src\\Web\\Web.csproj", "{11111111-1111-1111-1111-111111111111}"\r\nEndProject\r\n' +
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Lib", "..\\shared\\Lib.csproj", "{22222222-2222-2222-2222-222222222222}"\r\nEndProject\r\n' +
    'Project("{2150E333-8FDD-42A3-9474-1A3956D46DE8}") = "Items", "Items", "{33333333-3333-3333-3333-333333333333}"\r\nEndProject\r\n' +
    'Project("{E24C65DC-7377-472B-9ABA-BC803B73C61A}") = "Site", "http://localhost/site/", "{44444444-4444-4444-4444-444444444444}"\r\nEndProject\r\n'
  const projects = parseSln(text, '')
  expect(projects.map(p => p.name)).toEqual(['Lib', 'Web'])
  expect(projects.find(p => p.name === 'Web')?.dir).toBe('src/Web')
  expect(projects.find(p => p.name === 'Lib')?.file).toBeNull()
  const inSrc = parseSln(
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Web", "Web\\Web.csproj", "{11111111-1111-1111-1111-111111111111}"',
    'src',
  )
  expect(inSrc[0]?.file).toBe('src/Web/Web.csproj')
  expect(inSrc.length).toBe(1)
})

test('.slnx: projects inside folders or at the top', () => {
  const projects = parseSlnx('<Solution><Folder Name="/src/"><Project Path="src/App/App.csproj" /></Folder><Project Path="tests\\T\\T.csproj"/></Solution>', '')
  expect(projects.map(p => [p.name, p.dir])).toEqual([['App', 'src/App'], ['T', 'tests/T']])
})

test('findSolution: root, one level down, slnx over sln, nothing', async () => {
  const sln = 'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "A", "A\\A.csproj", "{11111111-1111-1111-1111-111111111111}"'
  const world = (dirs: Record<string, ExEntry[]>, files: Record<string, string>): Io => ({
    list: async abs => {
      const found = dirs[abs]
      if (!found) throw new Error('ENOENT')
      return found
    },
    read: async abs => {
      const found = files[abs]
      if (found === undefined) throw new Error('ENOENT')
      return found
    },
  })
  const below = await findSolution(world({ '/r': [dir('src'), file('a.txt')], '/r/src': [file('X.sln')] }, { '/r/src/X.sln': sln }), '/r')
  expect(below?.file).toBe('src/X.sln')
  expect(below?.projects[0]?.file).toBe('src/A/A.csproj')
  const both = await findSolution(world({ '/r': [file('X.sln'), file('X.slnx')] }, { '/r/X.sln': sln, '/r/X.slnx': '<Solution/>' }), '/r')
  expect(both?.file).toBe('X.slnx')
  expect(await findSolution(world({ '/r': [file('a.txt')] }, {}), '/r')).toBeNull()
})

test('porcelain: -z records, renames, the newline form, a prefix and untracked folders', () => {
  const z = parsePorcelain(' M src/a.ts\0?? new/\0R  b2.ts\0b.ts\0D  gone.ts\0UU c.ts\0', '')
  expect(z.byPath['src/a.ts']?.code).toBe('modified')
  expect(z.untrackedDirs).toEqual(['new'])
  expect(z.byPath['b2.ts']).toEqual({ code: 'renamed', rel: 'b2.ts', from: 'b.ts' })
  expect(z.byPath['gone.ts']?.code).toBe('deleted')
  expect(z.byPath['c.ts']?.code).toBe('conflict')
  expect(gitMarkOf('new/deep/f.ts', z)?.code).toBe('untracked')
  expect(gitMarkOf('newer/f.ts', z)).toBeUndefined()

  const nl = parsePorcelain('R  old.ts -> new.ts\n M "odd name.ts"\n', '')
  expect(nl.byPath['new.ts']?.from).toBe('old.ts')
  expect(nl.byPath['odd name.ts']?.code).toBe('modified')

  const sub = parsePorcelain(' M sub/x.ts\0 M other/x.ts\0', 'sub/')
  expect(Object.keys(sub.byPath)).toEqual(['x.ts'])
})

test('flatten: browsing, hidden, unlisted, unreadable, the cap and ghosts', () => {
  const base = input({
    listings: { '': listing(file('b.ts'), dir('src'), dir('bin'), file('A.ts')), src: listing(file('x.ts')) },
    expanded: new Set(['d:src']),
  })
  expect(ids(flatten(base))).toEqual(['d:src', 'f:src/x.ts', 'f:A.ts', 'f:b.ts'])
  const shown = flatten({ ...base, flags: { showHidden: true, changesOnly: false } })
  const bin = shown.find(r => r.id === 'd:bin')
  expect(bin?.isHidden).toBe(true)
  expect(bin?.isDim).toBe(true)

  const closed = flatten(input({ listings: { '': listing(dir('src')) } }))
  expect(ids(closed)).toEqual(['d:src'])
  const unlisted = flatten(input({ listings: { '': listing(dir('src')) }, expanded: new Set(['d:src']) }))
  expect(ids(unlisted)).toEqual(['d:src', 'w:d:src'])
  const bad = flatten(input({ listings: { '': listing(dir('src')), src: { entries: [], error: 'unreadable', at: 0 } }, expanded: new Set(['d:src']) }))
  expect(ids(bad)).toEqual(['d:src', 'u:d:src'])

  const many = flatten(input({ listings: { '': listing(file('1'), file('2'), file('3'), file('4'), file('5')) }, maxEntries: 3 }))
  expect(many.length).toBe(4)
  expect(many[3]?.label).toBe('… +2 more')

  const gone = flatten(input({ listings: { '': listing(file('a.ts')) }, git: { byPath: { 'old.ts': { code: 'deleted', rel: 'old.ts' } }, untrackedDirs: [] } }))
  expect(gone.find(r => r.id === 'f:old.ts')?.isGone).toBe(true)
})

test('flatten with a solution: projects, the root bucket and an outside project', () => {
  const solution = {
    file: 'App.sln', name: 'App', others: 0,
    projects: [
      { name: 'App', file: 'src/App/App.csproj', dir: 'src/App', rawPath: 'src\\App\\App.csproj' },
      { name: 'Lib', file: null, dir: '', rawPath: '..\\Lib\\Lib.csproj' },
    ],
  }
  const rows = flatten(input({
    solution,
    expanded: new Set(['sln', 'p:src/App', 'r', 'd:src']),
    listings: {
      '': listing(dir('src'), file('README.md')),
      src: listing(dir('App'), dir('docs')),
      'src/App': listing(file('A.cs')),
    },
  }))
  expect(ids(rows)).toEqual(['sln', 'p:src/App', 'f:src/App/A.cs', 'p:out:Lib', 'r', 'd:src', 'd:src/docs', 'f:README.md'])
  const out = rows.find(r => r.id === 'p:out:Lib')
  expect(out?.isDim).toBe(true)
  expect(out?.label).toContain('outside root')
})

test('flatten changes-only: only the touched and changed paths, grouped', () => {
  const git = { byPath: { 'docs/x.md': { code: 'modified' as const, rel: 'docs/x.md' } }, untrackedDirs: [] }
  const rows = flatten(input({ git, touched: ['src/a.ts'], flags: { showHidden: false, changesOnly: true } }))
  expect(ids(rows)).toEqual(['d:docs', 'f:docs/x.md', 'd:src', 'f:src/a.ts'])
  expect(rows.every(r => r.kind !== 'dir' || r.isOpen === true)).toBe(true)
  expect(rows.find(r => r.id === 'd:src')?.folderMark).toBe('touched')
  expect(rows.find(r => r.id === 'd:docs')?.folderMark).toBe('git')

  const solution = { file: 'A.sln', name: 'A', others: 0, projects: [{ name: 'App', file: 'src/App/App.csproj', dir: 'src/App', rawPath: '' }] }
  const grouped = flatten(input({ solution, touched: ['src/App/A.cs', 'README.md'], flags: { showHidden: false, changesOnly: true } }))
  expect(ids(grouped)).toEqual(['sln', 'p:src/App', 'f:src/App/A.cs', 'r', 'f:README.md'])

  const empty = flatten(input({ flags: { showHidden: false, changesOnly: true } }))
  expect(empty.map(r => r.label)).toEqual(['No changes yet: nothing touched this session, git clean.'])
})

test('flatten filter: matches with their ancestors, and the intersection with changes', () => {
  const listings = { '': listing(dir('src'), file('note.md')), src: listing(file('Foo.ts'), file('bar.ts')) }
  const rows = flatten(input({ listings, filterText: 'foo' }))
  expect(ids(rows)).toEqual(['d:src', 'f:src/Foo.ts'])
  const both = flatten(input({ listings, filterText: 'ts', touched: ['src/bar.ts'], flags: { showHidden: false, changesOnly: true } }))
  expect(ids(both)).toEqual(['d:src', 'f:src/bar.ts'])
  const none = flatten(input({ listings, filterText: 'zzz' }))
  expect(none[0]?.label).toBe('No names contain "zzz".')
})

test('fitName keeps the extension and the width', () => {
  const cut = fitName('VeryLongComponentName.tsx', 12)
  expect(cut.length).toBe(12)
  expect(cut).toContain('…')
  expect(cut.endsWith('.tsx')).toBe(true)
  expect(fitName('a.ts', 12)).toBe('a.ts')
})

test('/explorer arguments', () => {
  expect(parseCommand('')).toEqual({ kind: 'open' })
  expect(parseCommand('refresh')).toEqual({ kind: 'refresh' })
  expect(parseCommand('root')).toEqual({ kind: 'root', path: null })
  expect(parseCommand('root "C:\\x y"')).toEqual({ kind: 'root', path: 'C:\\x y' })
  expect(parseCommand('FIND Foo')).toEqual({ kind: 'find', text: 'Foo' })
  expect(parseCommand('find')).toEqual({ kind: 'find', text: '' })
  expect(parseCommand('collapse')).toEqual({ kind: 'collapse' })
  expect(parseCommand('show src/a.ts')).toEqual({ kind: 'show', path: 'src/a.ts' })
  expect(parseCommand('show').kind).toBe('error')
  expect(parseCommand('nope').kind).toBe('error')
})

test('a file click becomes an @reference after the draft', () => {
  expect(fileRef('a.ts', '')).toBe('@a.ts ')
  expect(fileRef('a.ts', 'look at')).toBe(' @a.ts ')
  expect(fileRef('a.ts', 'look at ')).toBe('@a.ts ')
  expect(fileRef('my file.ts', '')).toBe('@"my file.ts" ')
})
