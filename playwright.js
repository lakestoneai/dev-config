// Lakestone Playwright defaults. Merge first, repo config second:
//   export default defineConfig(playwrightDefaults, { ...this repo's settings })
// defineConfig shallow-merges `use` and `expect`, so a repo keeps these unless it sets the same key.
// Playwright's own default for both timeouts is 0 = wait forever, which hangs agents and scripted runs
// (they have no per-test timeout).
import { defineConfig, devices } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const SHARD_REPORTER = fileURLToPath(
  new URL('./playwright-shard-reporter.js', import.meta.url)
)
const MAX_FAILURES = { smoke: 3, gate: 10, full: 20, real: 20, manual: 0 }
const GLOBAL_TIMEOUT = {
  smoke: 10 * 60_000,
  gate: 60 * 60_000,
  full: 120 * 60_000,
  real: 120 * 60_000,
  manual: undefined,
}

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

/**
 * One e2e config for a repo. Merge order, lowest to highest priority:
 *   playwrightDefaults < harness (projects, lane, reporters, workers…) < the repo's own opts.
 * Every opt that is not listed below is passed straight through as repo config (`testDir`, `webServer`,
 * `timeout`, `use`, `expect`, `reporter`, `projects`…), so a repo's key always wins; a `projects` array
 * replaces the harness projects. `use` is shallow-merged over the harness `use`.
 *
 * `workers`, `retries` (default 1 on CI in the smoke lane), `fullyParallel`, `maxFailures` and `globalTimeout` take a value or `{ default, smoke, gate, full, real, manual }`.
 * `outputDir` is overridden by env E2E_OUTPUT_DIR (separate result folders for parallel stacks).
 *
 * Projects: `setup` (`*.setup.ts`) -> `chromium` (1440x900, `storageState`, depends on setup) -> optional `mobile`
 * (390 wide, `@mobile` tests only). Lane from E2E_LANE: smoke | gate (default) | full | real.
 *
 * @param {import('./playwright.js').E2EOptions} [opts]
 */
export function defineE2EConfig(opts = {}) {
  const {
    baseURL,
    storageState,
    mobile = false,
    workers = 4,
    fullyParallel = true,
    retries,
    maxFailures,
    globalTimeout,
    outputDir,
    globalSetup,
    video,
    slowMo,
    use: repoUse,
    ...repo
  } = opts
  const env = process.env
  const lane = env.E2E_LANE || 'gate'
  if (!(lane in LANES)) {
    throw new Error(
      `E2E_LANE=${lane} is not a lane (use ${Object.keys(LANES).join(' | ')})`
    )
  }
  const { grep, grepInvert } = LANES[lane]
  // workers / retries / fullyParallel: a value, or { default, smoke, gate, full, real, manual } to differ per lane
  const perLane = (v) =>
    v !== null && typeof v === 'object' ? (v[lane] ?? v.default) : v
  const ciSmokeRetry = env.CI && lane === 'smoke' ? 1 : undefined
  const watch = env.E2E_VIDEO === '1'
  const sharded =
    !!env.E2E_SHARD || process.argv.some((a) => a.startsWith('--shard'))

  const reporter = [['list']]
  if (env.GITHUB_ACTIONS) reporter.push(['github']) // inline annotations on the PR check
  // blob: sharded runs, and any run a merge step will read (a runner that splits by file lists passes no --shard)
  if (sharded || env.PLAYWRIGHT_BLOB_OUTPUT_FILE || env.E2E_BLOB === '1')
    reporter.push(['blob'])
  // Opt-in duration-aware sharding: E2E_SHARD_TIMINGS = a previous JSON report. Absent (or no --shard), Playwright's own count sharding runs.
  if (sharded && env.E2E_SHARD_TIMINGS) reporter.push([SHARD_REPORTER])
  if (env.E2E_REPORT_DIR) {
    reporter.push(
      ['html', { outputFolder: `${env.E2E_REPORT_DIR}/html`, open: 'never' }],
      ['json', { outputFile: `${env.E2E_REPORT_DIR}/results.json` }]
    )
  }

  const use = {
    ...(baseURL && { baseURL }),
    ...(watch && { video: 'on', launchOptions: { slowMo: 300 } }),
    ...(video !== undefined && { video }),
    ...(slowMo !== undefined && { launchOptions: { slowMo } }),
    ...repoUse,
  }
  const filter = { ...(grep && { grep }), ...(grepInvert && { grepInvert }) }
  const projects = [
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      grep: /./, // setup always runs: the config-level lane filter must not reach it
      grepInvert: /(?!)/,
    },
    {
      name: 'chromium',
      testIgnore: /.*\.setup\.ts/,
      dependencies: ['setup'],
      ...filter,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        ...(storageState && { storageState }),
      },
    },
  ]
  if (mobile) {
    projects.push({
      name: 'mobile',
      testIgnore: /.*\.setup\.ts/,
      dependencies: ['setup'],
      ...filter,
      // @mobile tests only, and inside the lane (smoke/real: both tags must be present)
      grep: grep ? new RegExp(`(?=.*@mobile)(?=.*${grep.source})`) : /@mobile/,
      use: {
        ...devices['Pixel 7'],
        viewport: { width: 390, height: 844 },
        ...(storageState && { storageState }),
      },
    })
  }

  return defineConfig(playwrightDefaults, {
    fullyParallel: perLane(fullyParallel),
    workers: perLane(workers),
    // CI smoke retries once by default: failOnFlakyTests only sees a flaky test if a retry can pass it
    ...(() => {
      const r = perLane(retries) ?? ciSmokeRetry
      return r !== undefined && { retries: r }
    })(),
    // E2E_OUTPUT_DIR beats the repo's outputDir: parallel stacks of one repo need separate result folders
    ...((env.E2E_OUTPUT_DIR || outputDir) && {
      outputDir: env.E2E_OUTPUT_DIR || outputDir,
    }),
    // Stop a red run early: CI only (a dev healing specs wants every failure); a repo's value wins, locally too
    maxFailures: perLane(maxFailures) ?? (env.CI ? MAX_FAILURES[lane] : 0),
    // CI only: an unsharded local gate run can legitimately outlast an hour
    globalTimeout:
      perLane(globalTimeout) ?? (env.CI ? GLOBAL_TIMEOUT[lane] : undefined),
    ...filter, // a repo's own projects inherit the lane
    reporter,
    failOnFlakyTests: !!env.CI && lane === 'smoke',
    ...(globalSetup && { globalSetup }),
    use,
    projects,
    ...repo,
    ...(repo.projects && { projects: exemptDependencies(repo.projects) }),
  })
}

// Whole tag tokens only. Playwright greps "<project> <file> <describe> <title> <tags>" joined by spaces, so a bare
// /@real/ would also drop a title containing agent@realestate.com or a tag like @realtime.
const tag = (t) => `(?:^|\\s)${t}(?=\\s|$)`
const LANES = {
  smoke: { grep: new RegExp(tag('@smoke')) },
  gate: { grepInvert: new RegExp(`${tag('@real')}|${tag('@manual')}`) },
  full: { grepInvert: new RegExp(tag('@manual')) },
  real: { grep: new RegExp(tag('@real')) },
  // @manual specs write to a vendor/sandbox: no other lane runs them, and a CLI --grep cannot override a lane filter
  manual: { grep: new RegExp(tag('@manual')) },
}

// The config-level lane filter reaches a repo's own projects. A project that another one depends on (a setup
// project) must always run, or its dependants start without it: give it the same match-everything filter.
function exemptDependencies(projects) {
  const needed = new Set(projects.flatMap((p) => p.dependencies ?? []))
  return projects.map((p) =>
    needed.has(p.name) && !p.grep && !p.grepInvert
      ? { ...p, grep: /./, grepInvert: /(?!)/ }
      : p
  )
}
