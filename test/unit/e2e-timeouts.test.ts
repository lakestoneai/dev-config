// 0.7.0 "nothing hangs": every wait has a bound, and each bound is proven against the real tool.
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, playwright, project, setupSpec } from './e2e-harness'

setDefaultTimeout(120_000)
afterAll(cleanup)

const MIN = 60_000
const cfg = (
  opts = ''
) => `import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
export default defineE2EConfig({ ${opts} })
`

// The resolved config without a browser run: evaluate defineE2EConfig in a Bun subprocess, with the given env and CLI args.
const evalDir = project({
  'eval.ts': `for (const a of JSON.parse(process.env.EVAL_ARGV ?? '[]')) process.argv.push(a)
const { defineE2EConfig } = await import('@lakestoneai/dev-config/playwright')
const c = defineE2EConfig(eval('({' + (process.env.EVAL_OPTS ?? '') + '})'))
console.log(JSON.stringify({ globalTimeout: c.globalTimeout, timeout: c.timeout, expect: c.expect, reporter: c.reporter }))
`,
})
function resolved(
  opts = '',
  env: Record<string, string> = {},
  argv: string[] = []
) {
  const clean: Record<string, string | undefined> = { ...process.env }
  for (const k of Object.keys(clean))
    if (/^(E2E_|CI$|GITHUB_ACTIONS$|PWDEBUG$|PLAYWRIGHT_BLOB)/.test(k))
      delete clean[k]
  const r = Bun.spawnSync(['bun', 'eval.ts'], {
    cwd: evalDir,
    env: {
      ...clean,
      EVAL_OPTS: opts,
      EVAL_ARGV: JSON.stringify(argv),
      ...env,
    },
  })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString())
  return JSON.parse(r.stdout.toString())
}
const gt = (opts = '', env = {}, argv: string[] = []) =>
  resolved(opts, env, argv).globalTimeout

// -- whole run
test('globalTimeout applies to every non-interactive run, CI or not, per lane', () => {
  expect(gt('', { E2E_LANE: 'smoke' })).toBe(10 * MIN)
  expect(gt('')).toBe(60 * MIN)
  expect(gt('', { E2E_LANE: 'full' })).toBe(120 * MIN)
  expect(gt('', { E2E_LANE: 'real' })).toBe(120 * MIN)
  expect(gt('', { E2E_LANE: 'manual' })).toBe(60 * MIN)
  expect(gt('', { CI: '1' })).toBe(60 * MIN) // CI changes nothing
})
test('globalTimeout: a repo value wins (value or per lane); 0 is "none"', () => {
  expect(gt('globalTimeout: 5000')).toBe(5000)
  expect(gt('globalTimeout: { gate: 7000 }')).toBe(7000)
  expect(gt('globalTimeout: { gate: 7000 }', { E2E_LANE: 'smoke' })).toBe(
    10 * MIN
  )
  expect(gt('globalTimeout: 0') ?? 0).toBe(0)
})
test('E2E_GLOBAL_TIMEOUT (minutes) beats the lane and the repo; 0 turns it off; junk is refused', () => {
  expect(gt('', { E2E_GLOBAL_TIMEOUT: '90' })).toBe(90 * MIN)
  expect(gt('globalTimeout: 5000', { E2E_GLOBAL_TIMEOUT: '1.5' })).toBe(90_000)
  expect(gt('', { E2E_GLOBAL_TIMEOUT: '0' }) ?? 0).toBe(0)
  expect(() => gt('', { E2E_GLOBAL_TIMEOUT: 'soon' })).toThrow(
    /E2E_GLOBAL_TIMEOUT=soon is not a number of minutes/
  )
})
test('an interactive run (--ui, --debug, --headed, PWDEBUG) has no run limit unless the env sets one', () => {
  for (const flag of ['--ui', '--debug', '--headed'])
    expect(gt('', {}, ['test', flag]) ?? 0).toBe(0)
  expect(gt('', { PWDEBUG: '1' }) ?? 0).toBe(0)
  expect(gt('globalTimeout: 5000', {}, ['--ui']) ?? 0).toBe(0)
  expect(gt('', { E2E_GLOBAL_TIMEOUT: '5' }, ['--ui'])).toBe(5 * MIN)
})

// -- smart lane budget from E2E_SHARD_TIMINGS
const report = (files: Record<string, number>) => {
  const f = join(mkdtempSync(join(tmpdir(), 'e2e-timings-')), 'results.json')
  writeFileSync(
    f,
    JSON.stringify({
      suites: Object.entries(files).map(([file, ms]) => ({
        file,
        specs: [
          {
            file,
            tests: [{ projectName: 'chromium', results: [{ duration: ms }] }],
          },
        ],
      })),
    })
  )
  return f
}
test('with E2E_SHARD_TIMINGS the limit is expected wall time x 3 (all time over workers x shards)', () => {
  // 4 files x 10 min over 2 workers x 2 shards = 10 min; x3 = 30 min (the gate lane's fixed number is 60)
  const t = report({
    'a.spec.ts': 10 * MIN,
    'b.spec.ts': 10 * MIN,
    'c.spec.ts': 10 * MIN,
    'd.spec.ts': 10 * MIN,
  })
  expect(gt('workers: 2', { E2E_SHARD_TIMINGS: t }, ['--shard=1/2'])).toBe(
    30 * MIN
  )
  // the shard count also comes from E2E_SHARD=i/n and from `--shard i/n`
  expect(gt('workers: 2', { E2E_SHARD_TIMINGS: t, E2E_SHARD: '1/2' })).toBe(
    30 * MIN
  )
  expect(gt('workers: 2', { E2E_SHARD_TIMINGS: t }, ['--shard', '1/2'])).toBe(
    30 * MIN
  )
  // no shard info: the whole suite over the workers: 40 / 2 = 20 min x 3
  expect(gt('workers: 2', { E2E_SHARD_TIMINGS: t })).toBe(60 * MIN)
})
test('the longest single file bounds the estimate (a file never splits across workers)', () => {
  const t = report({
    'slow.spec.ts': 20 * MIN,
    'a.spec.ts': MIN,
    'b.spec.ts': MIN,
    'c.spec.ts': MIN,
  })
  // spread: 23 / (4 workers x 1) = 5.75 min, but one file takes 20 min: 3 x 20
  expect(gt('workers: 4', { E2E_SHARD_TIMINGS: t })).toBe(60 * MIN)
})
test('the derived limit never drops under 5 min; a bad timings file falls back to the lane number; the repo and the env still win', () => {
  const tiny = report({ 'a.spec.ts': 2_000 })
  expect(gt('', { E2E_SHARD_TIMINGS: tiny })).toBe(5 * MIN)
  expect(gt('', { E2E_SHARD_TIMINGS: '/nonexistent.json' })).toBe(60 * MIN)
  const junk = join(mkdtempSync(join(tmpdir(), 'e2e-timings-')), 'x.json')
  writeFileSync(junk, 'not json')
  expect(gt('', { E2E_SHARD_TIMINGS: junk, E2E_LANE: 'smoke' })).toBe(10 * MIN)
  expect(gt('globalTimeout: 9000', { E2E_SHARD_TIMINGS: tiny })).toBe(9000)
  expect(gt('', { E2E_SHARD_TIMINGS: tiny, E2E_GLOBAL_TIMEOUT: '7' })).toBe(
    7 * MIN
  )
})

// -- test timeout and expect
test('timeout: 30 s in every lane, a value or per lane from the repo; expect.toPass keeps its default next to a repo expect.timeout', () => {
  for (const lane of ['smoke', 'gate', 'full', 'real', 'manual'])
    expect(resolved('', { E2E_LANE: lane }).timeout).toBe(30_000)
  expect(resolved('timeout: 45000').timeout).toBe(45_000)
  expect(resolved('timeout: { gate: 1 }', { E2E_LANE: 'smoke' }).timeout).toBe(
    30_000
  )
  expect(resolved('expect: { timeout: 7000 }').expect).toEqual({
    timeout: 7000,
    toPass: { timeout: 20_000 },
  })
})

test('a repo that tunes toPass without a timeout keeps the 20 s bound (defineConfig would drop it); its own timeout wins', () => {
  expect(
    resolved('expect: { toPass: { intervals: [100, 200] } }').expect.toPass
  ).toEqual({ timeout: 20_000, intervals: [100, 200] })
  expect(
    resolved('expect: { toPass: { timeout: 5000 } }').expect.toPass
  ).toEqual({ timeout: 5000 })
})

// -- the run limit, end to end
const hang = `import { test } from '@playwright/test'
test('hangs forever in node', async () => { await new Promise(() => {}) })
`
test('a hung run ends at the limit and names the budget, its source and the running test', () => {
  const d = project({
    'playwright.config.ts': cfg('globalTimeout: 3000, timeout: 600000'),
    'auth.setup.ts': setupSpec,
    'h.spec.ts': hang,
  })
  const t = Date.now()
  const r = playwright(d, ['--project=chromium'])
  expect(Date.now() - t).toBeLessThan(60_000)
  expect(r.code).not.toBe(0)
  expect(r.out).toContain(
    "the whole run hit its 3 s limit (the repo's globalTimeout)"
  )
  expect(r.out).toContain('Still running:')
  expect(r.out).toContain('chromium › h.spec.ts › hangs forever in node')
  expect(r.out).toContain('E2E_GLOBAL_TIMEOUT=<minutes>')
})
test('the box runs (no CI) are capped: E2E_GLOBAL_TIMEOUT=0.05 ends the same hang with the env as its source', () => {
  const d = project({
    'playwright.config.ts': cfg('timeout: 600000'),
    'auth.setup.ts': setupSpec,
    'h.spec.ts': hang,
  })
  const r = playwright(d, ['--project=chromium'], {
    E2E_GLOBAL_TIMEOUT: '0.05',
  })
  expect(r.code).not.toBe(0)
  expect(r.out).toContain('(E2E_GLOBAL_TIMEOUT=0.05 min)')
})
test('a hung global setup is bounded by the run limit too', () => {
  const d = project({
    'playwright.config.ts': cfg(
      'globalTimeout: 3000, globalSetup: "./hang.setup.ts"'
    ),
    'auth.setup.ts': setupSpec,
    'hang.setup.ts':
      'export default async () => { await new Promise(() => {}) }\n',
    'a.spec.ts': `import { test } from '@playwright/test'\ntest('never runs', async () => {})\n`,
  })
  const t = Date.now()
  const r = playwright(d, ['--project=chromium'])
  expect(Date.now() - t).toBeLessThan(60_000)
  expect(r.code).not.toBe(0)
  expect(r.out).toContain('Timed out waiting 3s for the global setup')
  expect(r.out).toContain('No test was running')
})

// -- blob: one file per run
const two = {
  'a.spec.ts': `import { test } from '@playwright/test'\ntest('in a', async () => {})\n`,
  'b.spec.ts': `import { test } from '@playwright/test'\ntest('in b', async () => {})\n`,
}
const mergeCount = (blobDir: string) => {
  const r = Bun.spawnSync(
    ['bunx', 'playwright', 'merge-reports', '--reporter', 'list', blobDir],
    { cwd: evalDir }
  )
  return r.stdout.toString() + r.stderr.toString()
}
test('two runs with different file lists into one folder each keep their blob (Playwright 1.65 wipes a shared outputDir)', () => {
  const d = project({
    'playwright.config.ts': cfg(),
    'auth.setup.ts': setupSpec,
    ...two,
  })
  const blobs = mkdtempSync(join(tmpdir(), 'e2e-blobs-'))
  for (const file of ['a.spec.ts', 'b.spec.ts']) {
    const r = playwright(d, ['--project=chromium', file], {
      E2E_BLOB: '1',
      E2E_BLOB_DIR: blobs,
    })
    expect(r.code).toBe(0)
  }
  expect(readdirSync(blobs).filter((f) => f.endsWith('.zip'))).toHaveLength(2)
  const merged = mergeCount(blobs)
  expect(merged).toContain('in a')
  expect(merged).toContain('in b')
})
test('E2E_REPORT_DIR alone writes a blob under <dir>/blob, with no env var to remember', () => {
  const d = project({
    'playwright.config.ts': cfg(),
    'auth.setup.ts': setupSpec,
    ...two,
  })
  const rep = mkdtempSync(join(tmpdir(), 'e2e-rep-'))
  const r = playwright(d, ['--project=chromium', 'a.spec.ts'], {
    E2E_REPORT_DIR: rep,
  })
  expect(r.code).toBe(0)
  const files = readdirSync(`${rep}/blob`)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/^report-\d+-\d+\.zip$/)
})
test('a shard writes report-<i>-of-<n>.zip, and a runner-set PLAYWRIGHT_BLOB_OUTPUT_FILE is left alone', () => {
  const d = project({
    'playwright.config.ts': cfg(),
    'auth.setup.ts': setupSpec,
    ...two,
  })
  const blobs = mkdtempSync(join(tmpdir(), 'e2e-blobs-'))
  const r = playwright(d, ['--project=chromium', '--shard=1/2'], {
    E2E_BLOB_DIR: blobs,
  })
  expect(r.code).toBe(0)
  expect(readdirSync(blobs)).toEqual(['report-1-of-2.zip'])
  const own = join(blobs, 'mine.zip')
  playwright(d, ['--project=chromium', 'a.spec.ts'], {
    PLAYWRIGHT_BLOB_OUTPUT_FILE: own,
    E2E_BLOB_DIR: blobs,
  })
  expect(existsSync(own)).toBe(true)
  expect(readdirSync(blobs).sort()).toEqual(['mine.zip', 'report-1-of-2.zip'])
})
