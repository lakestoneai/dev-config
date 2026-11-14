import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import {
  cleanup,
  listed,
  playwright,
  project,
  setupSpec,
  specs,
} from './e2e-harness'

setDefaultTimeout(60_000)
afterAll(cleanup)

const config = (
  opts = ''
) => `import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
export default defineE2EConfig({ mobile: true, ${opts} })
`
const dir = project({
  'playwright.config.ts': config(),
  'a.spec.ts': specs,
  'auth.setup.ts': setupSpec,
})
const rows = (env: Record<string, string>) => listed(dir, env).sort()

// -- lanes: what each lane runs, per project
test('gate (default): everything except @real and @manual', () => {
  expect(rows({})).toEqual([
    'chromium › critical @smoke',
    'chromium › narrow @mobile',
    'chromium › narrow critical @mobile @smoke',
    'chromium › plain journey',
    'mobile › narrow @mobile',
    'mobile › narrow critical @mobile @smoke',
    'setup › auth',
  ])
})
test('smoke: @smoke only (mobile: @mobile and @smoke)', () => {
  expect(rows({ E2E_LANE: 'smoke' })).toEqual([
    'chromium › critical @smoke',
    'chromium › narrow critical @mobile @smoke',
    'mobile › narrow critical @mobile @smoke',
    'setup › auth',
  ])
})
test('full: everything except @manual', () => {
  const r = rows({ E2E_LANE: 'full' })
  expect(r).toContain('chromium › vendor sandbox @real')
  expect(r.some((l) => l.includes('@manual'))).toBe(false)
})
test('real: @real only', () => {
  expect(rows({ E2E_LANE: 'real' })).toEqual([
    'chromium › vendor sandbox @real',
    'setup › auth',
  ])
})
test('an unknown lane is refused', () => {
  const r = playwright(dir, ['--list'], { E2E_LANE: 'nightly' })
  expect(r.code).not.toBe(0)
  expect(r.out).toContain('E2E_LANE=nightly is not a lane')
})
test('no mobile project unless opts.mobile', () => {
  const d = project({
    'playwright.config.ts': `import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
export default defineE2EConfig({})
`,
    'a.spec.ts': specs,
  })
  expect(listed(d).some((l) => l.startsWith('mobile'))).toBe(false)
})

// -- the resolved config, dumped by a globalSetup (runs in the main process, so it sees --shard and the harness's globalSetup passthrough)
const dumpSetup = `import { writeFileSync } from 'node:fs'
export default (config) => writeFileSync('dump.json', JSON.stringify({
  ...config,
  projects: config.projects.map((p) => ({ name: p.name, dependencies: p.dependencies, use: p.use, retries: p.retries })),
}))
`
function resolved(
  opts: string,
  env: Record<string, string> = {},
  args: string[] = []
) {
  const d = project({
    'playwright.config.ts': config(`globalSetup: './dump.setup.ts', ${opts}`),
    'dump.setup.ts': dumpSetup,
    'dump.spec.ts': `import { test } from '@playwright/test'\ntest('ok @smoke', async () => {})\n`,
    'auth.setup.ts': setupSpec,
  })
  const r = playwright(d, ['--project=chromium', ...args], env)
  expect(r.code).toBe(0)
  return JSON.parse(require('node:fs').readFileSync(`${d}/dump.json`, 'utf8'))
}
const proj = (c: any, name: string) =>
  c.projects.find((p: any) => p.name === name)

test('projects: setup -> chromium 1440x900 with storageState -> mobile 390', () => {
  const c = resolved(
    `baseURL: 'http://localhost:1234', storageState: 'state.json'`
  )
  const chromium = proj(c, 'chromium')
  expect(chromium.dependencies).toEqual(['setup'])
  expect(chromium.use.viewport).toEqual({ width: 1440, height: 900 })
  expect(chromium.use.storageState).toBe('state.json')
  expect(chromium.use.baseURL).toBe('http://localhost:1234')
  expect(proj(c, 'mobile').use.viewport).toEqual({ width: 390, height: 844 })
  expect(proj(c, 'mobile').dependencies).toEqual(['setup'])
})
test('defaults: 4 workers, fullyParallel, playwrightDefaults kept; opts override', () => {
  const c = resolved('')
  expect(c.workers).toBe(4)
  expect(c.fullyParallel).toBe(true)
  expect(proj(c, 'chromium').use.actionTimeout).toBe(10_000)
  const o = resolved(
    'workers: 2, fullyParallel: false, use: { actionTimeout: 3000 }'
  )
  expect(o.workers).toBe(2)
  expect(o.fullyParallel).toBe(false)
  expect(proj(o, 'chromium').use.actionTimeout).toBe(3000)
})
test('E2E_VIDEO=1: video on + slowMo; opts win', () => {
  const on = proj(resolved('', { E2E_VIDEO: '1' }), 'chromium').use
  expect(on.video).toBe('on')
  expect(on.launchOptions.slowMo).toBe(300)
  const off = proj(
    resolved('video: "off", slowMo: 50', { E2E_VIDEO: '1' }),
    'chromium'
  ).use
  expect(off.video).toBe('off')
  expect(off.launchOptions.slowMo).toBe(50)
  expect(proj(resolved(''), 'chromium').use.video).toBeUndefined()
})
test('failOnFlakyTests: only on CI and the smoke lane', () => {
  expect(resolved('', { CI: '1', E2E_LANE: 'smoke' }).failOnFlakyTests).toBe(
    true
  )
  expect(resolved('', { CI: '1' }).failOnFlakyTests).toBe(false)
  expect(resolved('', { E2E_LANE: 'smoke' }).failOnFlakyTests).toBe(false)
})
test('reporters: list; blob when sharded; html + json when E2E_REPORT_DIR', () => {
  const names = (c: any) => c.reporter.map((r: any[]) => r[0])
  expect(names(resolved(''))).toEqual(['list'])
  expect(names(resolved('', { E2E_SHARD: '1/2' }))).toEqual(['list', 'blob'])
  expect(names(resolved('', {}, ['--shard=1/1']))).toEqual(['list', 'blob'])
  const r = resolved('', { E2E_REPORT_DIR: '/tmp/e2e-rep' }).reporter
  expect(r.map((x: any[]) => x[0])).toEqual(['list', 'html', 'json'])
  expect(r[2][1].outputFile).toBe('/tmp/e2e-rep/results.json')
})
test('a repo reporter wins over the harness reporters', () => {
  expect(
    resolved(`reporter: [['dot']]`).reporter.map((r: any[]) => r[0])
  ).toEqual(['dot'])
})

// -- per-lane values, outputDir
test('workers / retries / fullyParallel can differ per lane', () => {
  const opts = `workers: { default: 1, smoke: 3 }, fullyParallel: { default: false, smoke: true }, retries: { gate: 2 }`
  const gate = resolved(opts)
  expect([
    gate.workers,
    gate.fullyParallel,
    proj(gate, 'chromium').retries,
  ]).toEqual([1, false, 2])
  const smoke = resolved(opts, { E2E_LANE: 'smoke' })
  expect([
    smoke.workers,
    smoke.fullyParallel,
    proj(smoke, 'chromium').retries,
  ]).toEqual([3, true, 0])
})
test('outputDir: repo option, and E2E_OUTPUT_DIR beats it', () => {
  const dumpOut = resolvedOutputDir
  expect(dumpOut(`outputDir: 'mine'`)).toEndWith('/mine')
  expect(
    dumpOut(`outputDir: 'mine'`, { E2E_OUTPUT_DIR: '/tmp/e2e-out-x' })
  ).toBe('/tmp/e2e-out-x')
  expect(dumpOut('', { E2E_OUTPUT_DIR: '/tmp/e2e-out-y' })).toBe(
    '/tmp/e2e-out-y'
  )
})
function resolvedOutputDir(opts: string, env: Record<string, string> = {}) {
  const d = project({
    'playwright.config.ts': config(`globalSetup: './dump.setup.ts', ${opts}`),
    'dump.setup.ts': `import { writeFileSync } from 'node:fs'
export default (c) => writeFileSync('dump.json', JSON.stringify(c.projects[0].outputDir))
`,
    'dump.spec.ts': `import { test } from '@playwright/test'\ntest('ok @smoke', async () => {})\n`,
    'auth.setup.ts': setupSpec,
  })
  expect(playwright(d, ['--project=chromium'], env).code).toBe(0)
  return JSON.parse(require('node:fs').readFileSync(`${d}/dump.json`, 'utf8'))
}

// -- lanes coexist with fixme, serial describes and per-iteration tags
test('lanes coexist with test.fixme, serial describes and per-iteration tags', () => {
  const d = project({
    'playwright.config.ts': config(),
    'auth.setup.ts': setupSpec,
    'b.spec.ts': `import { test } from '@playwright/test'
test.fixme('known gap @smoke', async () => {})
test.describe('flow', () => {
  test.describe.configure({ mode: 'serial' })
  test('step one', { tag: '@smoke' }, async () => {})
  test('step two', async () => {})
})
for (const role of ['owner', 'member']) {
  test('as ' + role, { tag: role === 'owner' ? '@smoke' : [] }, async () => {})
}
test('sandbox', { tag: ['@real', '@smoke'] }, async () => {})
`,
  })
  const smoke = listed(d, { E2E_LANE: 'smoke' }).filter(
    (l) => !l.startsWith('setup')
  )
  expect(smoke.filter((l) => l.startsWith('chromium')).sort()).toEqual(
    [
      'chromium › known gap @smoke',
      'chromium › flow › step one',
      'chromium › as owner',
      'chromium › sandbox',
    ].sort()
  )
  const gate = listed(d).map((l) => l.replace(/^chromium › /, ''))
  expect(gate).toContain('flow › step two')
  expect(gate).toContain('as member')
  expect(gate.some((l) => l.includes('sandbox'))).toBe(false)
})

// -- lanes match whole tag tokens only
const lookalikes = project({
  'playwright.config.ts': config(),
  'auth.setup.ts': setupSpec,
  'c.spec.ts': `import { test } from '@playwright/test'
test('invites agent@realestate.com.au', async () => {})
test('pings ops@real', async () => {})
test('subscribes', { tag: '@realtime' }, async () => {})
test('almost', { tag: '@smoke-ish' }, async () => {})
test('really real', { tag: '@real' }, async () => {})
test('really smoke', { tag: '@smoke' }, async () => {})
`,
})
const chromiumTitles = (env: Record<string, string>) =>
  listed(lookalikes, env)
    .filter((l) => l.startsWith('chromium'))
    .map((l) => l.replace('chromium › ', ''))
    .sort()
test('gate keeps tags and titles that merely contain @real', () => {
  expect(chromiumTitles({})).toEqual([
    'almost',
    'invites agent@realestate.com.au',
    'pings ops@real',
    'really smoke',
    'subscribes',
  ])
})
test('real runs only the exact @real tag', () => {
  expect(chromiumTitles({ E2E_LANE: 'real' })).toEqual(['really real'])
})
test('smoke runs only the exact @smoke tag', () => {
  expect(chromiumTitles({ E2E_LANE: 'smoke' })).toEqual(['really smoke'])
})

// -- retries default so failOnFlakyTests can see a flaky test
test('CI smoke retries once by default; gate and local do not; opts win', () => {
  const retries = (opts: string, env: Record<string, string>) =>
    proj(resolved(opts, env), 'chromium').retries
  expect(retries('', { CI: '1', E2E_LANE: 'smoke' })).toBe(1)
  expect(retries('', { CI: '1' })).toBe(0)
  expect(retries('', { E2E_LANE: 'smoke' })).toBe(0)
  expect(retries('retries: 0', { CI: '1', E2E_LANE: 'smoke' })).toBe(0)
  // a per-lane object without a smoke key keeps the CI smoke default
  expect(retries('retries: { gate: 2 }', { CI: '1', E2E_LANE: 'smoke' })).toBe(
    1
  )
})

// -- a repo's own projects keep the lane
test("a repo's own project still runs only its lane", () => {
  const d = project({
    'playwright.config.ts': config(`projects: [{ name: 'extra' }]`),
    'a.spec.ts': specs,
  })
  expect(listed(d, { E2E_LANE: 'smoke' }).sort()).toEqual([
    'extra › critical @smoke',
    'extra › narrow critical @mobile @smoke',
  ])
  expect(listed(d).some((l) => /@real|@manual/.test(l))).toBe(false)
})

// -- a repo's own setup project is exempt from the lane too
test("a repo's own setup project (a dependency) runs in every lane", () => {
  const d = project({
    'playwright.config.ts': config(
      `projects: [{ name: 'repo-setup', testMatch: /.*\\.setup\\.ts/ }, { name: 'app', testIgnore: /.*\\.setup\\.ts/, dependencies: ['repo-setup'] }, { name: 'tagged', testIgnore: /.*\\.setup\\.ts/, grep: /@smoke/ }]`
    ),
    'auth.setup.ts': setupSpec,
    'a.spec.ts': specs,
  })
  for (const lane of ['smoke', 'real', 'gate', 'full']) {
    expect(listed(d, { E2E_LANE: lane })).toContain('repo-setup › auth')
  }
  expect(
    listed(d, { E2E_LANE: 'smoke' }).filter((l) => l.startsWith('app'))
  ).toEqual(['app › critical @smoke', 'app › narrow critical @mobile @smoke'])
})

// -- 0.4.1: maxFailures, globalTimeout, github reporter
test('maxFailures: CI per lane (smoke 3, gate 10, full/real 20), 0 outside CI; repo wins (value or per lane)', () => {
  const mf = (opts: string, env: Record<string, string>) =>
    resolved(opts, env).maxFailures
  expect(mf('', { CI: '1', E2E_LANE: 'smoke' })).toBe(3)
  expect(mf('', { CI: '1' })).toBe(10)
  expect(mf('', { CI: '1', E2E_LANE: 'full' })).toBe(20)
  expect(mf('', { CI: '1', E2E_LANE: 'real' })).toBe(20)
  for (const lane of ['smoke', 'gate', 'full', 'real'])
    expect(mf('', { E2E_LANE: lane })).toBe(0) // local runs want every failure
  expect(mf('maxFailures: 1', { CI: '1' })).toBe(1)
  expect(mf('maxFailures: 5', {})).toBe(5) // set explicitly, it applies locally too
  expect(mf('maxFailures: { gate: 2 }', { CI: '1' })).toBe(2)
  expect(mf('maxFailures: { default: 7 }', { CI: '1', E2E_LANE: 'full' })).toBe(
    7
  )
  // a per-lane object without this lane keeps the lane default
  expect(mf('maxFailures: { gate: 2 }', { CI: '1', E2E_LANE: 'smoke' })).toBe(3)
})
test('maxFailures stops the run after N failures and skips the rest', () => {
  const d = project({
    'playwright.config.ts': config('workers: 1, fullyParallel: false'),
    'auth.setup.ts': setupSpec,
    'f.spec.ts': `import { test } from '@playwright/test'
for (let i = 1; i <= 6; i++) test('fail ' + i + ' @smoke', async () => { throw new Error('x') })
`,
  })
  const r = playwright(d, ['--project=chromium'], {
    CI: '1',
    E2E_LANE: 'smoke',
  })
  expect(r.out).toContain('3 failed')
  expect(r.out).toContain('did not run')
})
test('globalTimeout per lane: smoke 10 min, gate 60, full/real 120; repo wins', () => {
  const gt = (opts: string, env: Record<string, string> = {}) =>
    resolved(opts, env).globalTimeout
  expect(gt('', { E2E_LANE: 'smoke' })).toBe(10 * 60_000)
  expect(gt('')).toBe(60 * 60_000)
  expect(gt('', { E2E_LANE: 'full' })).toBe(120 * 60_000)
  expect(gt('', { E2E_LANE: 'real' })).toBe(120 * 60_000)
  expect(gt('globalTimeout: 5000')).toBe(5000)
  expect(gt('globalTimeout: { gate: 7000 }')).toBe(7000)
  expect(gt('globalTimeout: { gate: 7000 }', { E2E_LANE: 'smoke' })).toBe(
    10 * 60_000
  )
})
test('a hung run ends at globalTimeout with the tests it finished', () => {
  const d = project({
    'playwright.config.ts': config('globalTimeout: 3000, timeout: 60000'),
    'auth.setup.ts': setupSpec,
    'h.spec.ts': `import { test } from '@playwright/test'
test('hangs', async () => { await new Promise(() => {}) })
`,
  })
  const r = playwright(d, ['--project=chromium'])
  expect(r.code).not.toBe(0)
  expect(r.out).toContain('Timed out waiting 3s for the test suite to run')
})
test('github reporter only when GITHUB_ACTIONS', () => {
  const names = (env: Record<string, string>) =>
    resolved('', env).reporter.map((r: any[]) => r[0])
  expect(names({})).not.toContain('github')
  expect(names({ GITHUB_ACTIONS: 'true' })).toEqual(['list', 'github'])
})

test('blob reporter also on PLAYWRIGHT_BLOB_OUTPUT_FILE or E2E_BLOB=1, not only when sharded', () => {
  const names = (env: Record<string, string>) =>
    resolved('', env).reporter.map((r: any[]) => r[0])
  expect(names({ PLAYWRIGHT_BLOB_OUTPUT_FILE: '/tmp/b/report-1.zip' })).toEqual(
    ['list', 'blob']
  )
  expect(names({ E2E_BLOB: '1' })).toEqual(['list', 'blob'])
  expect(names({ E2E_BLOB: '0' })).toEqual(['list'])
  expect(names({})).toEqual(['list'])
})
