// `test` for repo e2e suites: worker-scoped auth, console guard, data ownership.
//   // e2e/fixtures.ts
//   import { test as base } from '@lakestoneai/dev-config/playwright/fixtures'
//   export { expect } from '@playwright/test'
//   export const test = base.extend({})            // add repo fixtures here
//   test.use({ auth: { accounts: (i) => ({ email: `e2e${i}@example.test`, password: '…' }), login: async (page, a) => {…} } })
import { test as base } from '@playwright/test'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Collects console errors and uncaught page errors on `page` (matching `allow` RegExps are ignored).
 * `check()` throws one error listing them. The `consoleGuard` fixture uses it for the test's pages; call it
 * yourself for a page the guard cannot see (e.g. one from a separately created browser context).
 */
export function watchConsole(page, allow = []) {
  const errors = []
  const ok = (text) => allow.some((re) => re.test(text))
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !ok(msg.text()))
      errors.push(`console.error: ${msg.text()}`)
  })
  page.on('pageerror', (err) => {
    if (!ok(err.message)) errors.push(`pageerror: ${err.message}`)
  })
  return {
    errors,
    check() {
      if (errors.length)
        throw new Error(`Console errors during the test:\n${errors.join('\n')}`)
    },
  }
}

/**
 * Options (set with `test.use({...})` or in a project's `use`):
 *  - `auth: { accounts, login }` (an object: Playwright would treat a bare function option as a fixture)
 *      `accounts(index)`  the account for worker `parallelIndex`: `{ email, password, storageInit? }` (repo-supplied, unique per worker)
 *      `login(page, account)`  signs in on a clean page; the harness then saves the storage state
 *  - `consoleOptions: { allow: RegExp[] }`  console error texts that do not fail a test (an object, because Playwright reads
 *      a bare two-element array option as a `[value, options]` pair)
 * `account.storageInit` seeds localStorage after login, before the state is saved: `{ key: value }` or `async (page) => {}`.
 * Fixtures: `workerAuth` (worker), `consoleGuard` (auto), `owned(prefix)`.
 */
export const test = base.extend({
  auth: [undefined, { option: true, scope: 'worker' }],
  consoleOptions: [{ allow: [] }, { option: true }],

  // Once per worker: sign in as accounts(parallelIndex), keep the state in the project's outputDir/.auth/<i>.json
  // and reuse the file when it exists. undefined (no `auth`) leaves the config's storageState alone.
  workerAuth: [
    async ({ browser, auth }, use) => {
      if (!auth) return use(undefined)
      const { accounts, login } = auth
      const id = test.info().parallelIndex
      const file = resolve(test.info().project.outputDir, `.auth/${id}.json`)
      if (!existsSync(file)) {
        mkdirSync(dirname(file), { recursive: true })
        // a clean context: no storageState from the config leaks into the login
        const context = await browser.newContext({
          storageState: undefined,
          baseURL: test.info().project.use.baseURL, // workerAuth is worker-scoped: it cannot read the baseURL fixture
        })
        const page = await context.newPage()
        try {
          const account = await accounts(id)
          await login(page, account)
          const init = account?.storageInit
          if (typeof init === 'function') await init(page)
          else if (init)
            await page.evaluate((kv) => {
              for (const [k, v] of Object.entries(kv))
                localStorage.setItem(k, v)
            }, init)
          await context.storageState({ path: file })
        } finally {
          await context.close()
        }
      }
      await use(file)
    },
    { scope: 'worker' },
  ],

  storageState: async ({ workerAuth, storageState }, use) => {
    await use(workerAuth ?? storageState)
  },

  // Auto: a console error (or an uncaught page error) on any page of the test fails it, unless it matches `consoleAllow`.
  consoleGuard: [
    async ({ context, consoleOptions }, use) => {
      const allow = consoleOptions.allow ?? []
      const watchers = context.pages().map((p) => watchConsole(p, allow))
      context.on('page', (p) => watchers.push(watchConsole(p, allow)))
      await use()
      const errors = watchers.flatMap((w) => w.errors)
      if (errors.length)
        throw new Error(`Console errors during the test:\n${errors.join('\n')}`)
    },
    { auto: true },
  ],

  // owned('Quote') -> 'Quote-w2-a1b2c3d4-1', then -2…: unique per worker, test and call, so parallel tests never share rows.
  owned: async ({}, use, testInfo) => {
    const tag = `w${testInfo.parallelIndex}-${testInfo.testId
      .split('-')
      .map((part) => part.slice(0, 4))
      .join('')}`
    let n = 0
    await use((prefix) => `${prefix}-${tag}-${++n}`)
  },
})
