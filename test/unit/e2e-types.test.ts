import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The hand-written .d.ts files must compile for a consumer, and reject a misuse.
setDefaultTimeout(60_000)
const made: string[] = []
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))

const tsc = (code: string) => {
  const dir = mkdtempSync(join(import.meta.dir, 'fixtures/tsc-'))
  made.push(dir)
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      extends: '@lakestoneai/dev-config/tsconfig/strict.json',
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
