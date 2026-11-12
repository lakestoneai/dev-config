// Lakestone Playwright defaults. Merge first, repo config second:
//   export default defineConfig(playwrightDefaults, { ...this repo's settings })
// defineConfig shallow-merges `use` and `expect`, so a repo keeps these unless it sets the same key.
// Playwright's own default for both timeouts is 0 = wait forever, which hangs agents and scripted runs
// (they have no per-test timeout).

/** @type {import('@playwright/test').PlaywrightTestConfig} */
export const playwrightDefaults = {
  forbidOnly: !!process.env.CI, // a stray test.only fails CI instead of silently skipping the suite
  use: {
    trace: 'retain-on-failure', // the trace of the FIRST failure (on-first-retry records nothing with retries: 0)
    screenshot: 'only-on-failure',
    actionTimeout: 10_000, // one click/fill/etc.
    navigationTimeout: 30_000, // goto, waitForURL, reload
  },
}
