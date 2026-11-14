import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { watchConsole } from '@lakestoneai/dev-config/playwright/fixtures'
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

// -- C1: the saved state belongs to the account, not just the worker slot
test('workerAuth: two roles in one worker slot each get their own login', () => {
  const role = (name: string) => `import { test, expect } from './fixtures'
test.use({ auth: {
  accounts: (i) => ({ email: '${name}' + i + '@example.test', password: 'pw' }),
  login: async (page, account) => {
    await page.route('http://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>app</p>' }))
    await page.goto('http://app.test/')
    await page.evaluate((e) => localStorage.setItem('who', e), account.email)
  },
} })
test('acts as ${name}', async ({ page }) => {
  await page.route('http://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>app</p>' }))
  await page.goto('http://app.test/')
  expect(await page.evaluate(() => localStorage.getItem('who'))).toBe('${name}0@example.test')
})
`
  const d = project({
    'playwright.config.ts': cfg().replace(
      'workers: 2',
      'workers: 1, fullyParallel: false'
    ),
    'fixtures.ts': fx,
    ...noSetup,
    'a-owner.spec.ts': role('owner'),
    'b-member.spec.ts': role('member'),
  })
  const r = playwright(d, ['--project=chromium'])
  expect(r.out).toContain('3 passed')
  expect(r.code).toBe(0)
})

// -- I2: the login context carries the project's use (headers, https errors, locale…)
test('workerAuth: the login request carries the project use (extraHTTPHeaders)', () => {
  const d = project({
    'playwright.config.ts': cfg(
      `use: { extraHTTPHeaders: { 'x-probe': 'from-project' } }`
    ),
    'fixtures.ts': fx,
    ...noSetup,
    'a.spec.ts': `import { test, expect } from './fixtures'
import { appendFileSync } from 'node:fs'
test.use({ auth: {
  accounts: () => ({ email: 'u@example.test', password: 'pw' }),
  login: async (page) => {
    await page.route('http://app.test/**', (r) => {
      appendFileSync('seen-header.txt', String(r.request().headers()['x-probe']) + '\\n')
      return r.fulfill({ contentType: 'text/html', body: '<p>app</p>' })
    })
    await page.goto('http://app.test/')
  },
} })
test('t', async ({ page }) => { void page })
`,
  })
  expect(playwright(d, ['--project=chromium']).code).toBe(0)
  expect(readFileSync(`${d}/seen-header.txt`, 'utf8').trim()).toBe(
    'from-project'
  )
})

// -- M1: the login is a worker setup step with its own timeout, not part of the first test's budget
test('workerAuth: a login slower than the test timeout does not fail the first test', () => {
  const d = project({
    'playwright.config.ts': cfg(`timeout: 2000`),
    'fixtures.ts': fx,
    ...noSetup,
    'a.spec.ts': `import { test } from './fixtures'
test.use({ auth: {
  accounts: () => ({ email: 'u@example.test', password: 'pw' }),
  login: async (page) => { await page.waitForTimeout(3500) },
} })
test('first test of the worker', async ({ page }) => { void page })
`,
  })
  const r = playwright(d, ['--project=chromium'])
  expect(r.out).toContain('2 passed')
  expect(r.code).toBe(0)
})

// -- M3: a missing favicon is not a console error; other failed network requests still are
test('watchConsole: a favicon load failure is ignored, other failed loads are reported', () => {
  const handlers: Record<string, (m: unknown) => void> = {}
  const page = {
    on: (e: string, h: (m: unknown) => void) => void (handlers[e] = h),
  }
  const w = watchConsole(page as never)
  const msg = (url: string) => ({
    type: () => 'error',
    text: () =>
      'Failed to load resource: the server responded with a status of 404 ()',
    location: () => ({ url }),
  })
  handlers.console(msg('http://localhost:5173/favicon.ico'))
  expect(w.errors).toEqual([])
  handlers.console(msg('http://localhost:5173/api/quotes'))
  expect(w.errors.length).toBe(1)
})

// -- allow matches text + ' @ ' + url (a resource error carries its URL only in location)
test('watchConsole: allow can match the failing URL', () => {
  const handlers: Record<string, (m: unknown) => void> = {}
  const page = {
    on: (e: string, h: (m: unknown) => void) => void (handlers[e] = h),
  }
  const w = watchConsole(page as never, [/status of 401\b.* @ .*\/auth\/v1\//])
  const msg = (url: string) => ({
    type: () => 'error',
    text: () =>
      'Failed to load resource: the server responded with a status of 401 (Unauthorized)',
    location: () => ({ url }),
  })
  handlers.console(msg('http://localhost:54321/auth/v1/token'))
  expect(w.errors).toEqual([])
  handlers.console(msg('http://localhost:54321/rest/v1/quotes'))
  expect(w.errors.length).toBe(1)
})

// -- auth from the config's use, shared by every spec; a spec opts out with test.use({ auth: undefined })
test('workerAuth: auth set in the config use applies to all specs; auth: null signs out', () => {
  const d = project({
    'playwright.config.ts': `import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
import { auth } from './auth'
export default defineE2EConfig({ workers: 2, use: { auth } })
`,
    'auth.ts': `import type { E2EAuth } from '@lakestoneai/dev-config/playwright/fixtures'
export const auth: E2EAuth = {
  accounts: (i) => ({ email: 'user' + i + '@example.test', password: 'pw' }),
  login: async (page, account) => {
    await page.route('http://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>app</p>' }))
    await page.goto('http://app.test/')
    await page.evaluate((e) => localStorage.setItem('who', e), account.email)
  },
}
`,
    'fixtures.ts': fx,
    ...noSetup,
    'in.spec.ts': `import { test, expect } from './fixtures'
test('signed in', async ({ page }) => {
  await page.route('http://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>app</p>' }))
  await page.goto('http://app.test/')
  expect(await page.evaluate(() => localStorage.getItem('who'))).toMatch(/^user\\d@example.test$/)
})
`,
    'out.spec.ts': `import { test, expect } from './fixtures'
test.use({ auth: null })
test('signed out', async ({ page }) => {
  await page.route('http://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>app</p>' }))
  await page.goto('http://app.test/')
  expect(await page.evaluate(() => localStorage.getItem('who'))).toBeNull()
})
`,
  })
  const r = playwright(d, ['--project=chromium'])
  expect(r.out).toContain('3 passed')
  expect(r.code).toBe(0)
})

test('workerAuth: test.use({ auth: undefined }) is "unset": the config login still applies', () => {
  const d = project({
    'playwright.config.ts': `import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
import { auth } from './auth'
export default defineE2EConfig({ workers: 1, use: { auth } })
`,
    'auth.ts': `import type { E2EAuth } from '@lakestoneai/dev-config/playwright/fixtures'
export const auth: E2EAuth = { accounts: () => ({ email: 'u@example.test', password: 'pw' }), login: async () => {} }
`,
    'fixtures.ts': fx,
    ...noSetup,
    'a.spec.ts': `import { test, expect } from './fixtures'
test.use({ auth: undefined })
test('still signed in', async ({ storageState }) => { expect(String(storageState)).toContain('.auth/0-u') })
`,
  })
  expect(playwright(d, ['--project=chromium']).code).toBe(0)
})

// -- consoleGuard is boxed: its fixture step stays out of the report
test('consoleGuard: no `Fixture "consoleGuard"` step in the report', () => {
  const d = project({
    'playwright.config.ts': cfg(
      `reporter: [['./steps.reporter.js'], ['list']]`
    ),
    'steps.reporter.js': `export default class {
  onStepBegin(test, result, step) { console.log('STEP>' + step.title) }
}
`,
    'fixtures.ts': fx,
    ...noSetup,
    'a.spec.ts': `import { test } from './fixtures'
test('ok', async ({ page }) => { await page.setContent('<p>hi</p>') })
`,
  })
  const r = playwright(d, ['--project=chromium'])
  expect(r.code).toBe(0)
  expect(r.out).toContain('STEP>') // the reporter saw steps (e.g. the page fixture)
  expect(r.out).not.toContain('consoleGuard')
})

// -- workerAuth: a saved Supabase session near or past expiry is re-created, not reused (FLEET-133)
// `login` writes a session whose expires_at is `now + offsets[n]` seconds on its n-th call (counter in logins.txt);
// `store` is 'ls' (localStorage) or 'cookie' (chunked, base64- prefixed, as @supabase/ssr writes it).
const sessionAuth = (
  offsets: number[],
  { store = 'ls', margin = '', tests = 2 } = {} as {
    store?: string
    margin?: string
    tests?: number
  }
) => ({
  'playwright.config.ts': cfg().replace('workers: 2', 'workers: 1'),
  'fixtures.ts': fx,
  ...noSetup,
  'a.spec.ts': `import { test, expect } from './fixtures'
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
const offsets = ${JSON.stringify(offsets)}
test.use({ auth: {
  ${margin}
  accounts: () => ({ email: 'u@example.test', password: 'pw' }),
  login: async (page) => {
    const n = existsSync('logins.txt') ? readFileSync('logins.txt', 'utf8').trim().split('\\n').filter(Boolean).length : 0
    appendFileSync('logins.txt', 'login' + n + '\\n')
    const session = JSON.stringify({ access_token: 'a' + n, refresh_token: 'r' + n, expires_at: Math.floor(Date.now() / 1000) + offsets[Math.min(n, offsets.length - 1)] })
    await page.route('http://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>app</p>' }))
    await page.goto('http://app.test/')
    if (${JSON.stringify(store)} === 'ls') {
      await page.evaluate((s) => localStorage.setItem('sb-abc-auth-token', s), session)
    } else {
      const v = ${JSON.stringify(store)} === 'urlcookie' ? encodeURIComponent(session) : 'base64-' + Buffer.from(session).toString('base64url')
      if (${JSON.stringify(store)} === 'twohosts')
        await page.context().addCookies([{ name: 'sb-abc-auth-token', value: v, url: 'http://other.test/' }])
      // 12 chunks: as text, .10 and .11 sort before .2, so the harness must order them numerically
      const n = 12
      const h = Math.ceil(v.length / n)
      await page.context().addCookies(
        Array.from({ length: n }, (_, i) => ({ name: 'sb-abc-auth-token.' + i, value: v.slice(i * h, (i + 1) * h), url: 'http://app.test/' })).reverse()
      )
    }
  },
} })
for (let i = 0; i < ${tests}; i++) {
  test('test ' + i, async ({ page }) => {
    await page.route('http://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<p>app</p>' }))
    await page.goto('http://app.test/')
    if (${JSON.stringify(store)} === 'ls') {
      const s = JSON.parse((await page.evaluate(() => localStorage.getItem('sb-abc-auth-token')))!)
      appendFileSync('seen-token.txt', s.access_token + '\\n')
    } else {
      appendFileSync('seen-token.txt', 'cookie\\n')
    }
  })
}
`,
})
const loginCount = (d: string) =>
  readFileSync(`${d}/logins.txt`, 'utf8').trim().split('\n').length
const seenTokens = (d: string) =>
  readFileSync(`${d}/seen-token.txt`, 'utf8').trim().split('\n')

test('workerAuth: a session with a long life is reused, one login', () => {
  const d = project(sessionAuth([3600]))
  expect(playwright(d, ['--project=chromium']).code).toBe(0)
  expect(loginCount(d)).toBe(1)
})
test('workerAuth: a session already expired is replaced before the first test', () => {
  const d = project(sessionAuth([-60, 3600]))
  const r = playwright(d, ['--project=chromium'])
  expect(r.code).toBe(0)
  expect(loginCount(d)).toBe(2)
  expect(seenTokens(d)).toEqual(['a1', 'a1']) // the tests run on the fresh session, never the expired one
})
test('workerAuth: a session inside the default 10 min margin is replaced', () => {
  const d = project(sessionAuth([300, 3600]))
  expect(playwright(d, ['--project=chromium']).code).toBe(0)
  expect(loginCount(d)).toBe(2)
})
test('workerAuth: a session that ages past the margin during the run is replaced before the next test', () => {
  // life 68 s, margin 60 s: an 8 s window in which the first test's check still finds it fresh (a loaded machine
  // has to stall 8 s to break that), then test 0 sleeps 9 s, so test 1 finds it inside the margin
  const files = sessionAuth([68, 3600], {
    margin: 'sessionMarginMs: 60_000,',
  })
  const spec = files['a.spec.ts'].replace(
    "test('test ' + i, async ({ page }) => {",
    "test('test ' + i, async ({ page }) => {\n    if (i === 0) await new Promise((r) => setTimeout(r, 9000))"
  )
  const e = project({ ...files, 'a.spec.ts': spec })
  expect(playwright(e, ['--project=chromium']).code).toBe(0)
  expect(loginCount(e)).toBe(2)
  expect(seenTokens(e)).toEqual(['a0', 'a1'])
})
test('workerAuth: sessionMarginMs is configurable (a 5 min session is kept under a 1 min margin)', () => {
  const d = project(sessionAuth([300], { margin: 'sessionMarginMs: 60_000,' }))
  expect(playwright(d, ['--project=chromium']).code).toBe(0)
  expect(loginCount(d)).toBe(1)
})
test('workerAuth: the session is also read from a chunked base64 cookie', () => {
  const d = project(sessionAuth([-60, 3600], { store: 'cookie' }))
  expect(playwright(d, ['--project=chromium']).code).toBe(0)
  expect(loginCount(d)).toBe(2)
})
test('workerAuth: a URL-encoded JSON cookie (older @supabase/ssr) is read', () => {
  const d = project(sessionAuth([-60, 3600], { store: 'urlcookie' }))
  expect(playwright(d, ['--project=chromium']).code).toBe(0)
  expect(loginCount(d)).toBe(2)
})
test('workerAuth: the same cookie name on two hosts is judged per host, not concatenated', () => {
  const d = project(sessionAuth([-60, 3600], { store: 'twohosts' }))
  expect(playwright(d, ['--project=chromium']).code).toBe(0)
  expect(loginCount(d)).toBe(2)
})
test('workerAuth: a margin larger than the session life warns once and stops re-logging in', () => {
  // every login gives a 300 s session, the margin is 600 s: one re-login, a warning, then the state is left alone
  const d = project(sessionAuth([300], { tests: 4 }))
  const r = playwright(d, ['--project=chromium'])
  expect(r.code).toBe(0)
  expect(loginCount(d)).toBe(2)
  expect(r.out.match(/already inside sessionMarginMs/g)?.length).toBe(1)
})
test('workerAuth: after the margin warning, a session that really expires is still replaced', () => {
  // logins give 300 s, then 8 s, then 1 h; margin 600 s. The 8 s session is inside the margin, so the margin
  // falls back to 0 (warn once); it expires during test 0 (which sleeps 10 s), so test 1 must start on a fresh login, not the dead one
  const files = sessionAuth([300, 8, 3600], { tests: 3 })
  const spec = files['a.spec.ts'].replace(
    "test('test ' + i, async ({ page }) => {",
    "test('test ' + i, async ({ page }) => {\n    if (i === 0) await new Promise((r) => setTimeout(r, 10000))"
  )
  const d = project({ ...files, 'a.spec.ts': spec })
  const r = playwright(d, ['--project=chromium'])
  expect(r.code).toBe(0)
  expect(loginCount(d)).toBe(3)
  expect(seenTokens(d)).toEqual(['a1', 'a2', 'a2'])
  expect(r.out.match(/already inside sessionMarginMs/g)?.length).toBe(1)
})
