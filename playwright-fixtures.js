// `test` for repo e2e suites: worker-scoped auth, console guard, data ownership.
//   // e2e/fixtures.ts
//   import { test as base } from '@lakestoneai/dev-config/playwright/fixtures'
//   export { expect } from '@playwright/test'
//   export const test = base.extend({})            // add repo fixtures here
//   test.use({ auth: { accounts: (i) => ({ email: `e2e${i}@example.test`, password: '…' }), login: async (page, a) => {…} } })
import { test as base } from '@playwright/test'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// Chromium reports a missing favicon as a console error; nothing a test can act on.
const isFaviconFailure = (msg) =>
  msg.text().startsWith('Failed to load resource') &&
  /\/favicon\.ico(\?|$)/.test(msg.location()?.url ?? '')

/**
 * Collects console errors and uncaught page errors on `page`. An `allow` RegExp is tested against
 * `<message text> @ <url>` (the URL is the message location: for a failed request, the request URL).
 * Chromium also reports every failed network request (a 401 from a wrong-password test, a 404) as
 * `console.error: Failed to load resource: … status of 401`, which fails the test: allow the ones a test expects
 * (`/status of 401\b.* @ .*\/auth\/v1\//`; real Chromium text is `… status of 401 (Unauthorized)`). A missing favicon is ignored by default.
 * `check()` throws one error listing them. The `consoleGuard` fixture uses it for the test's pages; call it
 * yourself for a page the guard cannot see (e.g. one from a separately created browser context).
 */
export function watchConsole(page, allow = []) {
  const errors = []
  const ok = (text) => allow.some((re) => re.test(text))
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    // text + ' @ ' + url: a failed resource carries its URL only in location()
    if (ok(`${msg.text()} @ ${msg.location()?.url ?? ''}`)) return
    if (isFaviconFailure(msg)) return
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
 *  - `auth: { accounts, login }` (`null` signs a spec out: `undefined` means "unset" and falls back to the config's) (an object: Playwright would treat a bare function option as a fixture)
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

  // Once per worker: sign in as accounts(parallelIndex) and keep the state in outputDir/.auth/<index>-<email>.json,
  // reused when the file exists (a restarted worker). The account is in the name: a worker slot that is handed a
  // different `auth` (another role) must not pick up the previous role's login. Own timeout, so a slow
  // sign-in does not spend the first test's budget. undefined (no or null `auth`) leaves the config's storageState alone.
  workerAuth: [
    async ({ browser, auth }, use, workerInfo) => {
      if (!auth) return use(undefined)
      const id = workerInfo.parallelIndex
      const account = await auth.accounts(id)
      const who = String(account?.email ?? 'account').replace(/[^\w.-]/g, '_')
      const file = resolve(
        workerInfo.project.outputDir,
        `.auth/${id}-${who}.json`
      )
      if (!existsSync(file)) {
        mkdirSync(dirname(file), { recursive: true })
        // the project's context options (baseURL, ignoreHTTPSErrors, extraHTTPHeaders, locale…), minus the
        // config's storageState, so a login never starts from another user's state
        const context = await browser.newContext({
          ...workerInfo.project.use,
          storageState: undefined,
        })
        const page = await context.newPage()
        try {
          await auth.login(page, account)
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
    { scope: 'worker', timeout: 60_000 },
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
    // box: the fixture's own step stays out of every report and trace
    { auto: true, box: true },
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
