import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { cleanup, playwright, project } from './e2e-harness'

setDefaultTimeout(90_000)
afterAll(cleanup)

const cfg = (
  extra = ''
) => `import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
export default defineE2EConfig({ workers: 2, ${extra} })
`
const fx = `export { expect } from '@playwright/test'
export { test, watchConsole } from '@lakestoneai/dev-config/playwright/fixtures'
`
const noSetup = {
  'auth.setup.ts': `import { test } from '@playwright/test'\ntest('auth', async () => {})\n`,
}

// -- consoleGuard
const consoleSpec = (use = '') => `import { test, expect } from './fixtures'
${use}
test('clean page', async ({ page }) => {
  await page.setContent('<p>hi</p>')
  await page.evaluate(() => console.log('just a log'))
})
test('page logs an error', async ({ page }) => {
  await page.setContent('<p>hi</p>')
  await page.evaluate(() => console.error('boom from page'))
})
test('page throws', async ({ page }) => {
  await page.setContent('<p>hi</p>')
  await page.evaluate(() => setTimeout(() => { throw new Error('uncaught thing') }, 0))
  await page.waitForTimeout(100)
})
test('second page in the same context', async ({ context }) => {
  const p = await context.newPage()
  await p.setContent('<p>two</p>')
  await p.evaluate(() => console.error('boom from page two'))
})
`
test('consoleGuard: errors fail the test, logs and clean pages do not; extra pages are watched', () => {
  const d = project({
    'playwright.config.ts': cfg(),
    'fixtures.ts': fx,
    ...noSetup,
    'a.spec.ts': consoleSpec(),
  })
  const r = playwright(d, ['--project=chromium'])
  expect(r.out).toContain('3 failed')
  expect(r.out).toContain('2 passed') // setup + the clean page
  expect(r.out).toContain('console.error: boom from page')
  expect(r.out).toContain('pageerror: uncaught thing')
  expect(r.out).toContain('console.error: boom from page two')
})
test('consoleGuard: consoleOptions.allow lets a matching error through', () => {
  const d = project({
    'playwright.config.ts': cfg(),
    'fixtures.ts': fx,
    ...noSetup,
    'a.spec.ts': consoleSpec(
      `test.use({ consoleOptions: { allow: [/boom from page/, /uncaught/] } })`
    ),
  })
  const r = playwright(d, ['--project=chromium'])
  expect(r.out).toContain('5 passed')
  expect(r.code).toBe(0)
})
test('watchConsole: a page outside the guard reports through check()', () => {
  const d = project({
    'playwright.config.ts': cfg(),
    'fixtures.ts': fx,
    ...noSetup,
    'a.spec.ts': `import { test, expect, watchConsole } from './fixtures'
test('other context', async ({ browser }) => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const w = watchConsole(page, [/ignored/])
  await page.setContent('<p>x</p>')
  await page.evaluate(() => { console.error('ignored thing'); console.error('real problem') })
  expect(w.errors).toEqual(['console.error: real problem'])
  expect(() => w.check()).toThrow('real problem')
  await ctx.close()
})
`,
  })
  expect(playwright(d, ['--project=chromium']).code).toBe(0)
})

// -- owned
test('owned: unique across tests, workers and calls', () => {
  const d = project({
    'playwright.config.ts': cfg(),
    'fixtures.ts': fx,
    ...noSetup,
    'a.spec.ts': `import { test, expect } from './fixtures'
import { appendFileSync } from 'node:fs'
for (const i of [1, 2, 3, 4, 5, 6]) {
  test('t' + i, async ({ owned }) => {
    appendFileSync('names.txt', [owned('Quote'), owned('Quote'), owned('Job')].join('\\n') + '\\n')
    expect(owned('Quote')).toMatch(/^Quote-w\\d+-[0-9a-f]{8}-4$/)
  })
}
`,
  })
  expect(playwright(d, ['--project=chromium']).code).toBe(0)
  const names = readFileSync(`${d}/names.txt`, 'utf8').trim().split('\n')
  expect(names.length).toBe(18)
  expect(new Set(names).size).toBe(18)
})

// -- workerAuth
const authFiles = () => ({
  'playwright.config.ts': cfg(),
  'fixtures.ts': fx,
  ...noSetup,
  'a.spec.ts': `import { test, expect } from './fixtures'
import { appendFileSync } from 'node:fs'
test.use({ auth: {
  accounts: (i) => ({ email: 'user' + i + '@example.test', password: 'pw', storageInit: { modules: 'quotes,jobs' } }),
  login: async (page, account) => {
    appendFileSync('logins.txt', account.email + '\\n')
    await page.route('http://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>app</p>' }))
    await page.goto('http://app.test/')
    await page.evaluate((e) => localStorage.setItem('who', e), account.email)
  },
} })
for (const i of [1, 2, 3, 4, 5, 6]) {
  test('signed in ' + i, async ({ page }) => {
    await page.route('http://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>app</p>' }))
    await page.goto('http://app.test/')
    const who = await page.evaluate(() => localStorage.getItem('who'))
    const modules = await page.evaluate(() => localStorage.getItem('modules'))
    expect(who).toMatch(/^user[01]@example.test$/)
    expect(modules).toBe('quotes,jobs')
    appendFileSync('seen.txt', who + '\\n')
  })
}
`,
})
test('workerAuth: one login per worker with its own account, state reused, storageInit seeded', () => {
  const d = project(authFiles())
  const r = playwright(d, ['--project=chromium'])
  expect(r.out).toContain('7 passed')
  const logins = readFileSync(`${d}/logins.txt`, 'utf8')
    .trim()
    .split('\n')
    .sort()
  expect(logins).toEqual(['user0@example.test', 'user1@example.test'])
  const seen = new Set(readFileSync(`${d}/seen.txt`, 'utf8').trim().split('\n'))
  expect(seen).toEqual(new Set(['user0@example.test', 'user1@example.test']))
})
test('workerAuth: a restarted worker (after a failed test) reuses the saved state', () => {
  const files = authFiles()
  const d = project({
    ...files,
    'playwright.config.ts': cfg().replace(
      'workers: 2',
      'workers: 1, fullyParallel: false'
    ),
    'a.spec.ts': files['a.spec.ts'].replace(
      'for (const i of [1, 2, 3, 4, 5, 6])',
      "test('fails first', async ({ page }) => { void page; throw new Error('x') })\nfor (const i of [1, 2])"
    ),
  })
  const r = playwright(d, ['--project=chromium'])
  expect(r.out).toContain('1 failed')
  expect(r.out).toContain('3 passed')
  expect(readFileSync(`${d}/logins.txt`, 'utf8').trim().split('\n')).toEqual([
    'user0@example.test',
  ])
})
test('workerAuth: without accounts/login the config storageState is untouched', () => {
  const d = project({
    'playwright.config.ts': cfg(`storageState: 'state.json'`),
    'fixtures.ts': fx,
    ...noSetup,
    'state.json': JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: 'http://app.test',
          localStorage: [{ name: 'k', value: 'from-config' }],
        },
      ],
    }),
    'a.spec.ts': `import { test, expect } from './fixtures'
test('state from config', async ({ page }) => {
  await page.route('http://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>app</p>' }))
  await page.goto('http://app.test/')
  expect(await page.evaluate(() => localStorage.getItem('k'))).toBe('from-config')
})
`,
  })
  expect(playwright(d, ['--project=chromium']).code).toBe(0)
})
