// Lakestone Playwright defaults. Merge first, repo config second:
//   export default defineConfig(playwrightDefaults, { ...this repo's settings })
// defineConfig shallow-merges `use` and `expect`, so a repo keeps these unless it sets the same key.
// Playwright's own default for action/navigation timeouts and for expect.toPass is 0 = wait forever, which hangs
// agents and scripted runs (they have no per-test timeout). README "Timeouts" lists every bound.
import { defineConfig, devices } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { timingsFromReport } from './playwright-shard-reporter.js'

const SHARD_REPORTER = fileURLToPath(
  new URL('./playwright-shard-reporter.js', import.meta.url)
)
const TIMEOUT_REPORTER = fileURLToPath(
  new URL('./playwright-timeout-reporter.js', import.meta.url)
)
const MAX_FAILURES = { smoke: 3, gate: 10, full: 20, real: 20, manual: 0 }
const GLOBAL_TIMEOUT = {
  smoke: 10 * 60_000,
  gate: 60 * 60_000,
  full: 120 * 60_000,
  real: 120 * 60_000,
  manual: 60 * 60_000,
}
const TOPASS_TIMEOUT = 20_000
const TEST_TIMEOUT = 30_000 // Playwright's own default, made explicit so a lane can set its own
// Smart lane budget (E2E_SHARD_TIMINGS present): expected wall time x factor, never below the floor
const BUDGET_FACTOR = 3
const BUDGET_FLOOR_MS = 5 * 60_000
// Interactive runs have a person at the keyboard: no run cap (`--debug` already sets timeout 0 itself)
// (`--ui-port`/`--ui-host` open UI mode on their own, `--debug=cli` is the inspector's cli mode)
const INTERACTIVE_ARG = /^--(ui|ui-port|ui-host|debug|headed)(=|$)/

/** @type {import('@playwright/test').PlaywrightTestConfig} */
export const playwrightDefaults = {
  forbidOnly: !!process.env.CI, // a stray test.only fails CI instead of silently skipping the suite
  use: {
    trace: 'retain-on-failure', // the trace of the FIRST failure (on-first-retry records nothing with retries: 0)
    screenshot: 'only-on-failure',
    actionTimeout: 10_000, // one click/fill/etc.
    navigationTimeout: 30_000, // goto, waitForURL, reload
  },
  // toPass defaults to 0 = forever and ignores expect.timeout. 20 s sits below the 30 s test timeout, so a stuck
  // toPass fails as itself (naming its last error) instead of as a vague "Test timeout exceeded".
  expect: { toPass: { timeout: TOPASS_TIMEOUT } },
}

/**
 * Expected wall time of a run from a Playwright JSON report: the busiest of "all test time spread over the
 * workers of all shards" and the longest single file (a file never splits across workers).
 * @param {Map<string, number>} timings from `timingsFromReport`
 */
export function expectedDurationMs(timings, { workers, shards }) {
  let sum = 0
  let longest = 0
  for (const ms of timings.values()) {
    sum += ms
    longest = Math.max(longest, ms)
  }
  return Math.max(sum / (Math.max(workers, 1) * Math.max(shards, 1)), longest)
}
/** `globalTimeout` for an expected duration: factor x, rounded up to a second, never below the floor. */
export const budgetFromExpected = (expectedMs) =>
  Math.max(
    BUDGET_FLOOR_MS,
    Math.ceil((expectedMs * BUDGET_FACTOR) / 1000) * 1000
  )

// { current, total } from `--shard=i/n`, `--shard i/n` or E2E_SHARD=i/n; undefined when the shard count is unknown
function shardCount(argv, env) {
  const i = argv.findIndex((a) => a.startsWith('--shard'))
  const spec =
    i < 0 ? '' : argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1]
  const m = /^(\d+)\/(\d+)$/.exec(spec || env.E2E_SHARD || '')
  return m ? { current: Number(m[1]), total: Number(m[2]) } : undefined
}

// Where a run's globalTimeout comes from, and how long it is: E2E_GLOBAL_TIMEOUT (minutes, 0 = off) > the repo's
// value > a budget derived from E2E_SHARD_TIMINGS > the lane's fixed number. Interactive runs get none unless the env says so.
function globalBudget({ env, argv, lane, repoValue, workers, shard, sharded }) {
  if (env.E2E_GLOBAL_TIMEOUT !== undefined && env.E2E_GLOBAL_TIMEOUT !== '') {
    const min = Number(env.E2E_GLOBAL_TIMEOUT)
    if (!Number.isFinite(min) || min < 0)
      throw new Error(
        `E2E_GLOBAL_TIMEOUT=${env.E2E_GLOBAL_TIMEOUT} is not a number of minutes (0 turns the run limit off)`
      )
    return min === 0
      ? {}
      : {
          ms: Math.max(1, Math.round(min * 60_000)),
          source: `E2E_GLOBAL_TIMEOUT=${min} min`,
        }
  }
  if (argv.some((a) => INTERACTIVE_ARG.test(a)) || env.PWDEBUG) return {}
  if (repoValue !== undefined)
    return repoValue
      ? { ms: repoValue, source: "the repo's globalTimeout" }
      : {}
  if (env.E2E_SHARD_TIMINGS) {
    try {
      const timings = timingsFromReport(
        JSON.parse(readFileSync(env.E2E_SHARD_TIMINGS, 'utf8'))
      )
      if (timings.size) {
        const expected = expectedDurationMs(timings, {
          workers: typeof workers === 'number' ? workers : 1,
          shards: shard?.total ?? 1,
        })
        // A shard runs a fraction of the suite, so its limit is the derived one. An unsharded run may be using a
        // timings file from a smaller run (a smoke report, a file-filtered run): never cap it below the lane's number.
        const derived = budgetFromExpected(expected)
        const floor = sharded ? 0 : (GLOBAL_TIMEOUT[lane] ?? 0)
        if (derived >= floor)
          return {
            ms: derived,
            source: `derived from E2E_SHARD_TIMINGS: expected ${Math.round(expected / 1000)} s x ${BUDGET_FACTOR}, floor ${BUDGET_FLOOR_MS / 60_000} min`,
          }
      }
    } catch {
      // absent or unreadable timings: the lane's fixed number
    }
  }
  return { ms: GLOBAL_TIMEOUT[lane], source: `the ${lane} lane default` }
}

/**
 * One e2e config for a repo. Merge order, lowest to highest priority:
 *   playwrightDefaults < harness (projects, lane, reporters, workers…) < the repo's own opts.
 * Every opt that is not listed below is passed straight through as repo config (`testDir`, `webServer`,
 * `timeout`, `use`, `expect`, `reporter`, `projects`…), so a repo's key always wins; a `projects` array
 * replaces the harness projects. `use` is shallow-merged over the harness `use`.
 *
 * `workers`, `retries` (default 1 on CI in the smoke lane), `fullyParallel`, `maxFailures`, `timeout` (default 30 s) and `globalTimeout` take a value or `{ default, smoke, gate, full, real, manual }`.
 * `globalTimeout` applies to every non-interactive run (see README "Timeouts"); env E2E_GLOBAL_TIMEOUT=<minutes> overrides it for one run (0 = none).
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
    timeout,
    outputDir,
    globalSetup,
    video,
    slowMo,
    use: repoUse,
    ...repo
  } = opts
  const env = process.env
  const lane = env.E2E_LANE || 'gate'
  if (!Object.hasOwn(LANES, lane)) {
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

  const shard = shardCount(process.argv, env)
  const budget = globalBudget({
    env,
    argv: process.argv,
    lane,
    repoValue: perLane(globalTimeout),
    workers: perLane(workers),
    shard,
    sharded,
  })

  const reporter = [['list']]
  if (env.GITHUB_ACTIONS) reporter.push(['github']) // inline annotations on the PR check
  // On a run-limit hit, print the budget and its source, and the tests still running (Playwright only says "Timed out")
  if (budget.ms)
    reporter.push([
      TIMEOUT_REPORTER,
      { budgetMs: budget.ms, source: budget.source },
    ])
  // blob: sharded runs, E2E_REPORT_DIR runs, and any run a merge step will read (a runner that splits by file lists passes no --shard)
  if (
    sharded ||
    env.E2E_REPORT_DIR ||
    env.PLAYWRIGHT_BLOB_OUTPUT_FILE ||
    env.E2E_BLOB === '1'
  )
    reporter.push(['blob', blobOptions(env, shard, process.argv)])
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

  const config = defineConfig(playwrightDefaults, {
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
    timeout: perLane(timeout) ?? TEST_TIMEOUT,
    // Stop a red run early: CI only (a dev healing specs wants every failure); a repo's value wins, locally too
    maxFailures: perLane(maxFailures) ?? (env.CI ? MAX_FAILURES[lane] : 0),
    // Every non-interactive run, CI or not (the ovh2 box sets no CI): a hung run ends with a report, not a killed process
    ...(budget.ms && { globalTimeout: budget.ms }),
    ...filter, // a repo's own projects inherit the lane
    reporter,
    failOnFlakyTests: !!env.CI && lane === 'smoke',
    ...(globalSetup && { globalSetup }),
    use,
    projects,
    ...repo,
    ...(repo.projects && {
      projects: exemptDependencies(repo.projects, grep, grepInvert),
    }),
  })
  // defineConfig merges `expect` one level deep: a repo's `expect: { toPass: { intervals } }` would replace the whole
  // toPass default and bring back its 0 = forever. Keep the bound unless the repo gave one.
  const withBound = (e) =>
    e.toPass?.timeout === undefined
      ? { ...e, toPass: { timeout: TOPASS_TIMEOUT, ...e.toPass } }
      : e
  if (config.expect?.toPass) config.expect = withBound(config.expect)
  // A project's own `expect` REPLACES the config's in Playwright (it is not merged), so it needs the bound too.
  config.projects = config.projects?.map((p) =>
    p.expect ? { ...p, expect: withBound(p.expect) } : p
  )
  return config
}

// One blob FILE per run, never a shared folder's default name: from 1.65 the blob reporter deletes its output
// DIRECTORY before writing (release notes 1.65), so N runs that write into one `outputDir` keep only the last. An
// `outputFile` is not wiped (measured on 1.65.1), so each run owns its file. Folder, and the name in it:
//  - `<E2E_REPORT_DIR>/blob` (the run owns the folder; the testing box reuses it every run): a STABLE name, so the
//    next run replaces the last blob instead of piling up next to it and a merge never sees an old run. A shard:
//    `report-<i>-of-<n>.zip`, otherwise `report.zip`.
//  - E2E_BLOB_DIR, or `blob-report` (a folder several runs share): a name from the invocation (lane + CLI args, like
//    Playwright's own hash), so the same run replaces itself and another file list adds its own file; a shard adds
//    `-<i>-of-<n>`: `report-<hash>-<i>-of-<n>.zip`, so two lanes' shard 1/2 do not overwrite each other.
// A runner's own PLAYWRIGHT_BLOB_OUTPUT_FILE is left alone.
function blobOptions(env, shard, argv) {
  if (env.PLAYWRIGHT_BLOB_OUTPUT_FILE) return {}
  const runOwned = !env.E2E_BLOB_DIR && env.E2E_REPORT_DIR
  const dir =
    env.E2E_BLOB_DIR ||
    (runOwned ? `${env.E2E_REPORT_DIR}/blob` : 'blob-report')
  // The hash leaves --shard out: a shard's own number is in the name, and one invocation's shards share a hash
  const args = argv.slice(2).filter((a, i, all) => {
    return !(/^--shard(=|$)/.test(a) || all[i - 1] === '--shard')
  })
  const invocation = createHash('sha1')
    .update(JSON.stringify([env.E2E_LANE ?? '', args]))
    .digest('hex')
    .slice(0, 8)
  const parts = [
    runOwned ? '' : invocation,
    shard ? `${shard.current}-of-${shard.total}` : '',
  ].filter(Boolean)
  const name = parts.join('-')
  return { outputFile: `${dir}/report${name && `-${name}`}.zip` }
}

// Whole tag tokens only. Playwright greps "<project> <file> <describe> <title> <tags>" joined by spaces, so a bare
// /@real/ would also drop a title containing agent@realestate.com or a tag like @realtime.
const tag = (t) => `(?:^|\\s)${t}(?=\\s|$)`
const LANES = {
  smoke: {
    grep: new RegExp(tag('@smoke')),
    grepInvert: new RegExp(tag('@manual')),
  },
  gate: { grepInvert: new RegExp(`${tag('@real')}|${tag('@manual')}`) },
  full: { grepInvert: new RegExp(tag('@manual')) },
  real: {
    grep: new RegExp(tag('@real')),
    grepInvert: new RegExp(tag('@manual')),
  },
  // @manual specs write to a vendor/sandbox: no other lane runs them (even one also tagged @smoke/@real), and a CLI --grep cannot override a lane filter
  manual: { grep: new RegExp(tag('@manual')) },
}

// The config-level lane filter reaches a repo's own projects. A project that another one depends on (a setup
// project) must always run, or its dependants start without it: give it the same match-everything filter.
function exemptDependencies(projects, laneGrep, laneInvert) {
  const needed = new Set(projects.flatMap((p) => p.dependencies ?? []))
  return projects.map((p) => {
    if (needed.has(p.name) && !p.grep && !p.grepInvert)
      return { ...p, grep: /./, grepInvert: /(?!)/ }
    // a project's own grep replaces the config-level one too: AND them, so the lane (smoke/real) still filters
    if (laneGrep && p.grep instanceof RegExp && !needed.has(p.name))
      p = { ...p, grep: allOf(p.grep, laneGrep) }
    // a project's own grepInvert replaces the config-level one in Playwright: keep the lane's exclusions (@manual, @real) too
    if (laneInvert && p.grepInvert && !needed.has(p.name))
      return { ...p, grepInvert: anyOf(p.grepInvert, laneInvert) }
    return p
  })
}
const allOf = (a, b) =>
  new RegExp(
    `(?=.*(?:${a.source}))(?=.*(?:${b.source}))`,
    [...new Set(a.flags + b.flags)].join('')
  )
const anyOf = (a, b) =>
  new RegExp(
    `(?:${a.source})|(?:${b.source})`,
    [...new Set(a.flags + b.flags)].join('')
  )
