import { expect, test } from 'claude-code/testing'
import type { FsEntry } from 'claude-code'

import type { DoctorCheckId } from '../types'
import { CHECK_IDS, detectMarkers, gateText, hasProjectMarker, isApplicable, parseOpts } from '../hooks/gates'

const file = (name: string): FsEntry => ({ name, kind: 'file', size: 1, mtimeMs: 1, isLink: false })
const dir = (name: string): FsEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })

/** A listing over an in-memory tree: path -> entries. */
const tree = (map: Record<string, FsEntry[]>) => ({ list: async (path: string) => map[path] ?? [] })

const applicable = (m: Awaited<ReturnType<typeof detectMarkers>>, options: Record<string, unknown> = {}): DoctorCheckId[] => {
  const opts = parseOpts(options)
  return CHECK_IDS.filter(id => isApplicable(id, m, opts))
}

test('a mods folder: only bash applies and the quiet rule holds', async () => {
  const m = await detectMarkers(
    tree({ 'C:/code/cc-mods': [dir('inbox'), dir('workbench'), file('notes.md')], 'C:/code/cc-mods/inbox': [file('README.md')] }),
    'C:/code/cc-mods',
  )
  expect(applicable(m)).toEqual(['bash'])
  expect(hasProjectMarker(m)).toBe(false)
})

test('an Aspire + Next repo: everything applies', async () => {
  const root = 'C:/code/shop'
  const m = await detectMarkers(
    tree({
      [root]: [dir('.git'), file('global.json'), file('Shop.sln'), file('compose.yaml'), dir('src'), dir('web'), dir('node_modules')],
      [`${root}/src`]: [dir('Shop.AppHost'), dir('Shop.Worker')],
      [`${root}/src/Shop.AppHost`]: [file('Shop.AppHost.csproj'), file('Program.cs')],
      [`${root}/web`]: [file('package.json')],
    }),
    root,
  )
  expect(m.appHostDir).toBe(`${root}/src/Shop.AppHost`)
  expect(m.nodeDir).toBe(`${root}/web`)
  expect(applicable(m)).toEqual(CHECK_IDS)
  expect(gateText('auth-secret', m, root)).toBe('AppHost: src/Shop.AppHost')
  expect(hasProjectMarker(m)).toBe(true)
})

test('a node-only repo: node and ports', async () => {
  const m = await detectMarkers(tree({ 'C:/code/site': [file('package.json')] }), 'C:/code/site')
  expect(applicable(m)).toEqual(['bash', 'ports', 'node'])
})

test('disabledChecks removes ids, and a blank worker name removes worker', async () => {
  const root = 'C:/code/shop'
  const m = await detectMarkers(
    tree({ [root]: [dir('src')], [`${root}/src`]: [dir('Shop.AppHost')], [`${root}/src/Shop.AppHost`]: [file('a.csproj')] }),
    root,
  )
  expect(applicable(m, { disabledChecks: 'Bash, docker' })).not.toContain('bash')
  expect(applicable(m, { disabledChecks: 'bash,docker' })).not.toContain('docker')
  expect(applicable(m)).toContain('worker')
  expect(applicable(m, { workerProcess: '' })).not.toContain('worker')
})

test('a non-Windows root skips the Windows-only checks', async () => {
  const m = await detectMarkers(tree({ '/home/me/site': [file('package.json')] }), '/home/me/site')
  expect(applicable(m)).toEqual(['node'])
})

test('options are read with their defaults, numbers and strings alike', () => {
  const o = parseOpts({ ports: '3000, 4000,x', intervalMinutes: '10', rerunAfterTools: false })
  expect(o.ports).toEqual([3000, 4000])
  expect(o.intervalMinutes).toBe(10)
  expect(o.rerunAfterTools).toBe(false)
  expect(o.nodeMajor).toBe(22)
  expect(parseOpts(undefined).ports).toEqual([3000, 3001])
})
