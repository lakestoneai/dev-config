import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The hand-written .d.ts files must compile for a consumer, and reject a misuse.
setDefaultTimeout(60_000)
const made: string[] = []
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))

const tsc = (code: string, compilerOptions: object = {}) => {
  const dir = mkdtempSync(join(import.meta.dir, 'fixtures/tsc-'))
  made.push(dir)
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      extends: '@lakestoneai/dev-config/tsconfig/strict.json',
      compilerOptions,
      include: ['*.ts'],
    })
  )
  writeFileSync(join(dir, 'x.ts'), code)
  const r = Bun.spawnSync(['bunx', 'tsc', '-p', dir], { cwd: import.meta.dir })
  return { code: r.exitCode, out: r.stdout.toString() }
}

test('a consumer using every export compiles', () => {
  const r =
    tsc(`import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
import { preflight, httpOk, custom } from '@lakestoneai/dev-config/playwright/preflight'
import { test, watchConsole } from '@lakestoneai/dev-config/playwright/fixtures'
export default defineE2EConfig({ baseURL: 'http://localhost:1', workers: { default: 1, smoke: 4 }, retries: 1, mobile: true, outputDir: 'o' })
export const setup = preflight([httpOk('http://localhost:1'), custom('x', async () => {})], { timeoutMs: 5000 })
test.use({ auth: { accounts: (i) => ({ email: 'a' + i, password: 'p', storageInit: { k: 'v' } }), login: async (page, a) => { await page.goto(String(a.email)) } }, consoleOptions: { allow: [/x/] } })
test('t', async ({ page, owned }) => { const w = watchConsole(page); w.check(); owned('q').toUpperCase() })
`)
  expect(r.out).toBe('')
  expect(r.code).toBe(0)
})
test('a wrong lane key and a non-string prefix are type errors', () => {
  const r =
    tsc(`import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
import { test } from '@lakestoneai/dev-config/playwright/fixtures'
defineE2EConfig({ workers: { nightly: 2 } })
test('t', async ({ owned }) => { owned(1) })
`)
  expect(r.code).not.toBe(0)
})

test('a repo sets the auth default with test.use and the exported E2EAuth type, no cast', () => {
  const r =
    tsc(`import { test, type E2EAuth } from '@lakestoneai/dev-config/playwright/fixtures'
const auth: E2EAuth = {
  accounts: (i) => ({ email: 'a' + i, password: 'p' }),
  login: async (page) => { await page.goto('/') },
}
test.use({ auth })
`)
  expect(r.out).toBe('')
  expect(r.code).toBe(0)
})

test('config use: { auth } with an E2EAuth variable compiles', () => {
  const r =
    tsc(`import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
import type { E2EAuth } from '@lakestoneai/dev-config/playwright/fixtures'
const auth: E2EAuth = { accounts: (i) => ({ email: 'a' + i, password: 'p' }), login: async () => {} }
export default defineE2EConfig({ use: { auth } })
`)
  expect(r.out).toBe('')
  expect(r.code).toBe(0)
})

test('0.7.0 types: any Playwright video value, globalSetup arrays, per-lane timeout, replace, loginTimeoutMs, httpOk retries', () => {
  const r =
    tsc(`import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
import { httpOk } from '@lakestoneai/dev-config/playwright/preflight'
import { test, type E2EAuth } from '@lakestoneai/dev-config/playwright/fixtures'
import TimeoutReporter from '@lakestoneai/dev-config/playwright/timeout-reporter'
const auth: E2EAuth = { accounts: () => ({ email: 'a', password: 'p' }), login: async () => {}, loginTimeoutMs: 5000 }
export default defineE2EConfig({
  video: { mode: 'on', size: { width: 640, height: 360 } },
  globalSetup: ['./a.ts', './b.ts'],
  timeout: { default: 30_000, real: 90_000 },
  globalTimeout: { smoke: 1 },
  use: { auth, consoleOptions: { allow: [/x/], replace: true } },
})
test.use({ consoleOptions: { allow: [/x/], replace: true } })
httpOk('http://x', { timeoutMs: 1, retries: 1, retryDelayMs: 1 })
new TimeoutReporter({ budgetMs: 1, source: 's' })
`)
  expect(r.out).toBe('')
  expect(r.code).toBe(0)
})
test('0.7.0 types: a non-number timeout, an unknown lane in timeout, and a non-boolean replace are errors', () => {
  for (const bad of [
    `defineE2EConfig({ timeout: 'slow' })`,
    `defineE2EConfig({ timeout: { nightly: 1 } })`,
    `defineE2EConfig({ use: { consoleOptions: { replace: 'yes' } } })`,
  ]) {
    const r = tsc(
      `import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'\n${bad}\n`
    )
    expect(r.code).not.toBe(0)
  }
})
test("video is checked against Playwright's real video type: a bad mode is an error, even with skipLibCheck on", () => {
  // `PlaywrightTestOptions['video']` is not a key (video lives in PlaywrightWorkerOptions); under the house
  // skipLibCheck the lookup silently becomes `any` and accepts anything. The expect-error line fails if it does.
  const r =
    tsc(`import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
// @ts-expect-error not a video mode
defineE2EConfig({ video: 'not-a-mode' })
defineE2EConfig({ video: 'on' })
`)
  expect(r.out).toBe('')
  expect(r.code).toBe(0)
})
test('the package declarations compile with skipLibCheck off (a type that does not exist is an error in them)', () => {
  const r = tsc(
    `import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
export default defineE2EConfig({ video: 'on' })
`,
    { skipLibCheck: false }
  )
  expect(r.out).toBe('')
  expect(r.code).toBe(0)
})
test('./package.json is an export, so tools that read the package version can resolve it', () => {
  const p = require('@lakestoneai/dev-config/package.json')
  expect(p.name).toBe('@lakestoneai/dev-config')
})
