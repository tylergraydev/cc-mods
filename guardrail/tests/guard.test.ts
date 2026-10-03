import { expect, test } from 'claude-code/testing'

import { classify, expand, hookBypass, isHumanOrigin, parseArgs, parseConfig, redact, residualBypass, scan, statusText, tokenize } from '../hooks/guard'
import type { Dialect } from '../hooks/guard'

const NOW = Date.parse('2026-10-03T10:00:00Z')

/** The first bypass rule found in a command, the way `judge` looks: hookBypass per segment, then the residual check. */
const bypass = (command: string, dialect: Dialect = 'bash') => {
  const segs = expand(command, dialect)
  const persisted: Record<string, string> = {}
  for (const seg of segs) {
    const found = seg.isWrapper ? undefined : hookBypass(seg, persisted)
    if (found) return found.rule
    Object.assign(persisted, seg.assigns)
  }
  return residualBypass(segs) ? 'residual' : undefined
}

const hit = (command: string, dialect: Dialect = 'bash', o: Record<string, unknown> = {}) => {
  const cfg = parseConfig(o)
  return expand(command, dialect).map(seg => classify(seg, cfg)).find(Boolean)
}

test('tokenizer and segments', () => {
  expect(scan('a && b; c | d', 'bash').segs).toHaveLength(4)
  expect(scan('echo "x; y"', 'bash').segs).toHaveLength(1)
  expect(tokenize('"--no-""verify"', 'bash').map(t => t.text)).toEqual(['--no-verify'])
  expect(tokenize('echo `"hi`" there', 'pwsh').map(t => t.text)).toEqual(['echo', '"hi"', 'there'])
  expect(scan('a 2>&1 | b', 'bash').segs).toHaveLength(2)
  expect(scan('& ./x.ps1 -a; b', 'pwsh').segs[0]?.[0]?.text).toBe('./x.ps1')
})

test('git hook bypasses are caught', () => {
  expect(bypass('git push --no-verify')).toBe('git-no-verify')
  expect(bypass('git push origin main --no-verify')).toBe('git-no-verify')
  expect(bypass('git -C repo push --no-veri')).toBe('git-no-verify')
  expect(bypass('git commit -nm "x"')).toBe('git-no-verify')
  expect(bypass('git commit -am x --no-verify')).toBe('git-no-verify')
  expect(bypass('git -c core.hooksPath=/dev/null commit -m x')).toBe('git-hooks-path')
  expect(bypass('HUSKY=0 git push')).toBe('husky-off')
  expect(bypass('SKIP=lint git commit -m x')).toBe('husky-off')
  expect(bypass('$env:HUSKY=0; git push', 'pwsh')).toBe('husky-off')
  expect(bypass('bash -c "git push --no-verify"')).toBe('git-no-verify')
  expect(bypass('pwsh -Command "git commit --no-verify -m x"')).toBe('git-no-verify')
  expect(bypass('F=--no-verify; git push $F')).toBe('residual')
  expect(bypass('& "C:\\Program Files\\Git\\cmd\\git.exe" push --no-verify', 'pwsh')).toBe('git-no-verify')
})

test('ordinary git commands pass', () => {
  expect(bypass('git push -n')).toBeUndefined()
  expect(bypass('git commit -m "drop --no-verify from docs"')).toBeUndefined()
  expect(bypass('git commit -m "--no-verify"')).toBeUndefined()
  expect(bypass('git commit -mnew')).toBeUndefined()
  expect(bypass('git push origin main')).toBeUndefined()
  expect(bypass('git commit -m x && echo "--no-verify"')).toBeUndefined()
})

test('sqlpackage: publish is live, a deploy report is its dry run, the target is part of the key', () => {
  const live = hit('sqlpackage /a:Publish /tsn:stage /tdn:db /sf:x.dacpac')
  expect([live?.rule, live?.mode]).toEqual(['sqlpackage', 'live'])
  expect(live?.key).toMatch(/^sqlpackage:sqlpackage#[0-9a-f]{8}$/)
  const dry = hit('sqlpackage /a:DeployReport /tsn:stage /tdn:db /sf:x.dacpac')
  expect([dry?.mode, dry?.key]).toEqual(['dry', live?.key])
  expect(hit('sqlpackage /a:Extract /tsn:stage')).toBeUndefined()
  expect(hit('sqlpackage /a:Publish /tsn:prod /tdn:db')?.key).not.toBe(live?.key)
})

test('dotnet ef, bcp and sqlcmd', () => {
  const live = hit('dotnet ef database update')
  expect(live?.mode).toBe('live')
  expect(hit('dotnet ef migrations script')).toMatchObject({ mode: 'dry', key: live?.key })
  expect(hit('dotnet ef migrations add X')).toBeUndefined()
  expect(hit('bcp db.dbo.t in f.dat -S srv')?.mode).toBe('live')
  expect(hit('bcp db.dbo.t out f.dat')).toBeUndefined()
  expect(hit('Invoke-Sqlcmd -Query "SELECT 1"', 'pwsh')).toBeUndefined()
  expect(hit('Invoke-Sqlcmd -Query "DELETE FROM t"', 'pwsh')?.mode).toBe('live')
  expect(hit('Invoke-Sqlcmd -Query "BEGIN TRAN; DELETE FROM t; ROLLBACK"', 'pwsh')?.mode).toBe('dry')
})

test('migration tools', () => {
  expect(hit('prisma migrate deploy')?.mode).toBe('live')
  expect(hit('npx prisma migrate diff')?.mode).toBe('dry')
  expect(hit('flyway -url=x migrate')?.mode).toBe('live')
  expect(hit('alembic upgrade head --sql')?.mode).toBe('dry')
  expect(hit('python manage.py migrate')?.mode).toBe('live')
  expect(hit('python manage.py migrate --plan')?.mode).toBe('dry')
})

test('scripts: data folder, sync and migrate names, --live', () => {
  const live = hit('pwsh -File scripts/data/sync-prod.ps1', 'pwsh')
  expect(live?.mode).toBe('live')
  expect(hit('pwsh -File scripts/data/sync-prod.ps1 -WhatIf', 'pwsh')).toMatchObject({ mode: 'dry', key: live?.key })
  expect(hit('pwsh -File scripts/data/sync-prod.ps1 -WhatIf:$false', 'pwsh')?.mode).toBe('live')
  expect(hit('.\\scripts\\data\\fix.ps1', 'pwsh')?.mode).toBe('live')
  expect(hit('./tools/migrate.sh --dry-run')?.mode).toBe('dry')
  expect(hit('npm run migrate')?.mode).toBe('live')
  expect(hit('node app.js --live')?.mode).toBe('live')
  expect(hit('echo --dry-run && ./sync.ps1')?.mode).toBe('live')
  for (const c of ['rsync -a a b', 'git status', 'ls', 'cat scripts/data/x.ps1', 'aws s3 sync a b']) expect(hit(c)).toBeUndefined()
  expect(hit('./seed-prod.sh')).toBeUndefined()
  expect(hit('./seed-prod.sh', 'bash', { extraLivePattern: 'seed-prod|other' })?.rule).toBe('custom')
  expect(hit('./sync.ps1', 'bash', { disabledRules: 'sync-migrate-script' })).toBeUndefined()
})

test('options: a bad regex is reported and ignored, numbers may arrive as strings', () => {
  const cfg = parseConfig({ extraLivePattern: '(', allowMinutes: '5' })
  expect(cfg.invalid).toEqual(['extraLivePattern'])
  expect(cfg.extraLive).toBeUndefined()
  expect(cfg.allowMinutes).toBe(5)
})

test('redact, statusText, parseArgs, isHumanOrigin', () => {
  expect(redact('Server=a;Password=abc;Database=b')).toBe('Server=a;Password=***;Database=b')
  expect(redact('sqlcmd -P hunter2 /p:pw')).toBe('sqlcmd -P *** /p:***')
  expect(redact('x'.repeat(300))).toHaveLength(160)

  const empty = { dryRuns: [], blocked: 0, pending: null, allowance: null, allowed: 0 }
  const run = (label: string) => ({ key: label, label, rule: 'r', command: '', at: NOW })
  expect(statusText(empty, NOW)).toBe('guard: no dry-run yet')
  expect(statusText({ ...empty, dryRuns: [run('a'), run('b'), run('c')], blocked: 2 }, NOW)).toBe('guard: dry-run ✓ c, b +1 · 2 blocked')
  const armed = { kind: 'live' as const, grantedAt: NOW, expiresAt: NOW + 60_000, by: 'command' as const }
  expect(statusText({ ...empty, allowance: armed }, NOW)).toBe('guard: no dry-run yet · allow armed')
  expect(statusText({ ...empty, allowance: armed }, NOW + 120_000)).toBe('guard: no dry-run yet')

  expect(parseArgs('')).toEqual({ kind: 'status' })
  expect(parseArgs('allow')).toEqual({ kind: 'allow', what: 'live' })
  expect(parseArgs('allow no-verify')).toEqual({ kind: 'allow', what: 'no-verify' })
  expect(parseArgs('reset')).toEqual({ kind: 'reset' })
  expect(parseArgs('allow everything').kind).toBe('usage')

  expect(isHumanOrigin({ kind: 'composer' })).toBe(true)
  expect(isHumanOrigin({ kind: 'plugin' })).toBe(false)
  expect(isHumanOrigin({ kind: 'peer' })).toBe(false)
})
