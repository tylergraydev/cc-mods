import { expect, test } from 'claude-code/testing'

import {
  authKeys,
  classifyBash,
  evalAuthSecret,
  exitedAgeHours,
  flattenKeys,
  inRepo,
  matchesImage,
  parseCim,
  parseDockerPs,
  parseDotenvKeys,
  parseEnginesNode,
  parseGlobalJson,
  parseNetstat,
  parseNodeVersion,
  parseNodeWant,
  parseRuntimes,
  parseSdks,
  parseSecretsKeys,
  parseTasklistCsv,
  parseUserSecretsId,
  parseWhere,
  parseWorktrees,
  satisfies,
} from '../hooks/parse'

const GIT = 'C:\\Program Files\\Git\\bin\\bash.exe'

test('where: Git bash first passes, WSL or the WindowsApps alias first fails', () => {
  expect(classifyBash(parseWhere(`${GIT}\r\nC:\\Windows\\System32\\bash.exe\r\n`), false).status).toBe('pass')
  expect(classifyBash(parseWhere('C:\\Program Files\\Git\\usr\\bin\\bash.exe'), false).status).toBe('pass')
  const wsl = classifyBash(parseWhere(`C:\\Windows\\System32\\bash.exe\r\n${GIT}`), false)
  expect(wsl.status).toBe('fail')
  expect(wsl.fix).toContain('SetEnvironmentVariable')
  const alias = classifyBash(parseWhere('C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe'), false)
  expect(alias.status).toBe('fail')
  expect(alias.fix).toContain('App execution aliases')
})

test('where: nothing found is [] and a warning', () => {
  expect(parseWhere('INFO: Could not find files for the given pattern(s).\r\n')).toEqual([])
  expect(classifyBash([], true).status).toBe('warn')
})

test('dotnet lists', () => {
  const sdks = parseSdks('8.0.404 [C:\\Program Files\\dotnet\\sdk]\r\n9.0.100-preview.1 [C:\\x]\r\nnoise')
  expect(sdks.map(s => s.version)).toEqual(['8.0.404', '9.0.100-preview.1'])
  const rt = parseRuntimes(
    'Microsoft.NETCore.App 8.0.11 [C:\\Program Files\\dotnet\\shared\\Microsoft.NETCore.App]\r\nMicrosoft.AspNetCore.App 8.0.11 [C:\\p]',
  )
  expect(rt).toEqual([
    { name: 'Microsoft.NETCore.App', version: '8.0.11' },
    { name: 'Microsoft.AspNetCore.App', version: '8.0.11' },
  ])
})

test('global.json: comments, no sdk, malformed', () => {
  const text = '// top\n{\n /* c */ "sdk": { "version": "8.0.100", // pin\n "rollForward": "latestFeature", "allowPrerelease": false }, "url": "http://x//y" }'
  expect(parseGlobalJson(text)).toEqual({ version: '8.0.100', rollForward: 'latestFeature', allowPrerelease: false })
  expect(parseGlobalJson('{ "msbuild-sdks": {} }')).toEqual({})
  expect(parseGlobalJson('{ nope')).toBe(null)
})

test('satisfies: every roll-forward policy', () => {
  const have = ['8.0.404']
  expect(satisfies(have, {})).toBe(true)
  expect(satisfies([], {})).toBe(false)
  // patch (the default): same band, patch at least the requested
  expect(satisfies(have, { version: '8.0.400' })).toBe(true)
  expect(satisfies(have, { version: '8.0.405' })).toBe(false)
  expect(satisfies(have, { version: '8.0.300', rollForward: 'patch' })).toBe(false)
  expect(satisfies(have, { version: '8.0.404', rollForward: 'latestPatch' })).toBe(true)
  // feature: same major.minor, higher band or same band and patch
  expect(satisfies(have, { version: '8.0.300', rollForward: 'feature' })).toBe(true)
  expect(satisfies(have, { version: '8.0.500', rollForward: 'latestFeature' })).toBe(false)
  expect(satisfies(have, { version: '8.1.100', rollForward: 'feature' })).toBe(false)
  // minor: same major, version at least
  expect(satisfies(['8.2.100'], { version: '8.0.400', rollForward: 'minor' })).toBe(true)
  expect(satisfies(have, { version: '8.1.100', rollForward: 'latestMinor' })).toBe(false)
  expect(satisfies(['9.0.100'], { version: '8.0.100', rollForward: 'minor' })).toBe(false)
  // major: anything at least
  expect(satisfies(['9.0.100'], { version: '8.0.100', rollForward: 'latestMajor' })).toBe(true)
  expect(satisfies(have, { version: '9.0.100', rollForward: 'major' })).toBe(false)
  // disable: exact
  expect(satisfies(have, { version: '8.0.404', rollForward: 'disable' })).toBe(true)
  expect(satisfies(have, { version: '8.0.400', rollForward: 'disable' })).toBe(false)
})

test('satisfies: prereleases only when allowed or requested', () => {
  const pre = ['9.0.100-preview.1']
  expect(satisfies(pre, { version: '9.0.100', rollForward: 'latestMajor' })).toBe(false)
  expect(satisfies(pre, { version: '9.0.100', rollForward: 'latestMajor', allowPrerelease: true })).toBe(true)
  expect(satisfies(pre, { version: '9.0.100-preview.1', rollForward: 'disable' })).toBe(true)
})

test('netstat: listening rows only, IPv6 brackets, exact ports', () => {
  const text = [
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       18232',
    '  TCP    [::]:3001              [::]:0                 LISTENING       2210',
    '  TCP    127.0.0.1:3000         127.0.0.1:50000        ESTABLISHED     18232',
    '  TCP    0.0.0.0:30000          0.0.0.0:0              LISTENING       77',
  ].join('\r\n')
  const rows = parseNetstat(text)
  expect(rows).toEqual([
    { port: 3000, pid: 18232 },
    { port: 3001, pid: 2210 },
    { port: 30000, pid: 77 },
  ])
  expect(rows.filter(r => r.port === 3000)).toHaveLength(1)
})

test('tasklist csv: a quoted memory column holds a comma', () => {
  const rows = parseTasklistCsv('"node.exe","18232","Console","1","45,000 K"\r\n"Shop.Worker.exe","900","Console","1","1,200 K"\r\n')
  expect(rows).toEqual([
    { image: 'node.exe', pid: 18232 },
    { image: 'Shop.Worker.exe', pid: 900 },
  ])
})

test('cim: an object, an array, /Date(...)/ and ISO, a null command line', () => {
  const one = parseCim('{"ProcessId":5,"Name":"node.exe","CreationDate":"/Date(1700000000000)/","CommandLine":"node next dev"}')
  expect(one).toEqual([{ pid: 5, name: 'node.exe', created: 1700000000000, cmd: 'node next dev' }])
  const many = parseCim('[{"ProcessId":1,"Name":"a","CreationDate":"2026-10-03T10:00:00Z","CommandLine":null},{"ProcessId":2,"Name":"b"}]')
  expect(many[0]).toEqual({ pid: 1, name: 'a', created: Date.parse('2026-10-03T10:00:00Z'), cmd: null })
  expect(many[1]?.cmd).toBe(null)
  expect(parseCim('')).toEqual([])
  expect(parseCim('garbage')).toEqual([])
})

test('image and repo matching', () => {
  expect(matchesImage('Worker.exe', 'Worker')).toBe(true)
  expect(matchesImage('Shop.Worker.exe', 'worker')).toBe(true)
  expect(matchesImage('Networker.exe', 'Worker')).toBe(false)
  expect(inRepo('node C:\\Code\\Shop\\web\\next dev', 'C:/code/shop')).toBe(true)
  expect(inRepo('node C:\\code\\old-shop\\next dev', 'C:/code/shop')).toBe(false)
})

test('git worktree --porcelain', () => {
  const text = [
    'worktree C:/repo\nHEAD abc\nbranch refs/heads/main',
    'worktree C:/repo-wt\nHEAD def\ndetached\nlocked in use\nprunable gitdir file points to non-existent location',
    'worktree C:/bare\nbare',
  ].join('\n\n')
  const [main, wt, bare] = parseWorktrees(text)
  expect(main?.branch).toBe('refs/heads/main')
  expect(wt?.isDetached).toBe(true)
  expect(wt?.locked).toBe('in use')
  expect(wt?.prunable).toContain('non-existent')
  expect(bare?.isBare).toBe(true)
})

test('docker ps ages', () => {
  expect(exitedAgeHours('Exited (0) About an hour ago')).toBe(1)
  expect(exitedAgeHours('Exited (0) 2 weeks ago')).toBe(336)
  expect(exitedAgeHours('Exited (0) Less than a second ago')).toBe(0)
  expect(exitedAgeHours('Exited (137) 3 days ago')).toBe(72)
  expect(exitedAgeHours('Up 3 hours')).toBe(null)
  const rows = parseDockerPs('a1\tdb\tpostgres\tExited (137) 3 days ago\nb2\tweb\tnginx\tExited (0) About an hour ago\n')
  expect(rows.map(r => [r.name, r.ageHours])).toEqual([
    ['db', 72],
    ['web', 1],
  ])
})

test('node versions', () => {
  expect(parseNodeVersion('v22.11.0\n')).toBe(22)
  expect(parseNodeVersion('nope')).toBe(undefined)
  expect(parseNodeWant('22\n')).toBe(22)
  expect(parseNodeWant('v22.11.0')).toBe(22)
  expect(parseNodeWant('lts/jod')).toBe(undefined)
  expect(parseEnginesNode('{"engines":{"node":">=20.11"}}')).toBe(20)
  expect(parseEnginesNode('{}')).toBe(undefined)
})

test('dotenv keys: export, quotes, empty values, comments', () => {
  const keys = parseDotenvKeys(
    ['# AUTH_SECRET=commented', 'export AUTH_SECRET="SUPERSECRETVALUE"', "OTHER=''", 'EMPTY=', 'PLAIN=x', 'junk line'].join('\n'),
  )
  expect(keys.get('AUTH_SECRET')).toBe(true)
  expect(keys.get('OTHER')).toBe(false)
  expect(keys.get('EMPTY')).toBe(false)
  expect(keys.get('PLAIN')).toBe(true)
  expect(keys.size).toBe(4)
})

test('secrets.json keys flatten, and the csproj id reads', () => {
  const keys = flattenKeys({ Parameters: { 'auth-secret': 'SUPERSECRETVALUE', blank: '' }, 'Other:Key': 'x' })
  expect([...keys]).toEqual([
    ['Parameters:auth-secret', true],
    ['Parameters:blank', false],
    ['Other:Key', true],
  ])
  expect(authKeys(keys)).toEqual(['Parameters:auth-secret'])
  expect(parseSecretsKeys('not json').size).toBe(0)
  expect(parseUserSecretsId('<Project><PropertyGroup><UserSecretsId>abc-123</UserSecretsId></PropertyGroup></Project>')).toBe('abc-123')
  expect(parseUserSecretsId('<Project/>')).toBe(undefined)
})

test('the secret value never reaches a verdict', () => {
  const secret = 'SUPERSECRETVALUE'
  const sources = [
    { label: 'user-secrets', keys: parseSecretsKeys(JSON.stringify({ Parameters: { 'auth-secret': secret } })) },
    { label: '.env.local', keys: parseDotenvKeys(`AUTH_SECRET=${secret}`) },
    { label: 'environment', keys: new Map([['AUTH_SECRET', true]]) },
  ]
  for (const forwarded of [true, false]) {
    const verdict = evalAuthSecret(sources, forwarded, 'C:/repo/src/Shop.AppHost')
    expect(JSON.stringify(verdict)).not.toContain(secret)
    expect(verdict.evidence).toContain('Parameters:auth-secret')
  }
  expect(evalAuthSecret(sources, true, 'x').status).toBe('pass')
  expect(evalAuthSecret(sources, false, 'x').status).toBe('warn')
  const missing = evalAuthSecret([{ label: '.env', keys: parseDotenvKeys('AUTH_SECRET=') }], true, "C:/it's/AppHost")
  expect(missing.status).toBe('fail')
  expect(missing.fix).toContain("'C:/it''s/AppHost'")
})
