# @lakestoneai/dev-config

Lakestone's house defaults for code config: Playwright, Prettier, ESLint, tsconfig bases, a Renovate preset and a `setup-bun` CI action. Each client repo imports these and keeps only its own exceptions; a fix here reaches every repo as a Renovate bump PR that the repo's own CI proves.

Claude Code tooling lives in [`lakestoneai/claude-tools`](https://github.com/lakestoneai/claude-tools), not here. This package is for config that CI, Vercel and every developer machine read.

## Install

```sh
bun add -d --exact @lakestoneai/dev-config
```

## Playwright

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test'
import { playwrightDefaults } from '@lakestoneai/dev-config/playwright'

export default defineConfig(playwrightDefaults, {
  // this repo's own settings: testDir, webServer, projects, baseURL…
})
```

| Setting                 | Value | Playwright's own default |
| ----------------------- | ----- | ------------------------ |
| `use.actionTimeout`     | 10 s  | 0 (wait forever)         |
| `use.navigationTimeout` | 30 s  | 0 (wait forever)         |

Defaults go first: `defineConfig` merges `use` and `expect` key by key, so anything the repo sets wins, at config level or per project. A slow page needs a longer cap: set `actionTimeout` in that repo's `use`, that project's `use`, or one spec's `test.use()`.

Why: with no `actionTimeout`, a click on a missing element waits forever. A normal test run is still capped by the test timeout (with a vague "Test timeout exceeded" error); Playwright's planner/generator/healer agents and scripted runs have no test timeout and hang.

## Playwright e2e harness

One e2e config, preflight and fixtures for every repo (0.4.0). Playwright (>= 1.52, the first with `failOnFlakyTests`) is a peer dependency only: to try an unreleased build in a repo, install the `bun pm pack` tarball, not a `link:`/symlink (a link loads `@playwright/test` twice and Playwright then refuses to run).

```ts
// playwright.config.ts
import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
import { auth } from './e2e/auth'
export default defineE2EConfig({
  baseURL: 'http://localhost:5173',
  testDir: './e2e',
  storageState: 'e2e/.auth/user.json', // written by e2e/auth.setup.ts
  mobile: true, // adds the `mobile` project
  workers: { default: 4, smoke: 2 },
  globalSetup: './e2e/preflight.ts',
  use: { auth }, // per-worker sign-in (below); omit `storageState` above when you use it
})
```

```ts
// e2e/preflight.ts
import {
  preflight,
  loopbackOnly,
  httpOk,
  localSupabase,
  commands,
  custom,
} from '@lakestoneai/dev-config/playwright/preflight'
export default preflight([
  loopbackOnly(url),
  httpOk(url),
  localSupabase(supabaseUrl),
  commands(['bun']),
  custom('not live', async () => {
    /* run a script, query a seed row… */
  }),
])
```

```ts
// e2e/auth.ts: its own module, typed E2EAuth (Playwright's `use` typing needs a variable)
import type { E2EAuth } from '@lakestoneai/dev-config/playwright/fixtures'
export const auth: E2EAuth = {
  accounts: (i) => ({
    email: `e2e${i}@example.test`,
    password: '…',
    storageInit: { modules: 'all' },
  }),
  login: async (page, account) => {
    /* sign in */
  },
}
```

```ts
// e2e/fixtures.ts
export { test, watchConsole } from '@lakestoneai/dev-config/playwright/fixtures'
export { expect } from '@playwright/test'
// a signed-out spec: test.use({ auth: null })
```

| Export                                                                                                             | Does                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineE2EConfig(opts)` from `/playwright`                                                                         | Projects `setup` (`*.setup.ts`) → `chromium` (Desktop Chrome 1440×900, `storageState`, depends on setup) → `mobile` (390 wide, only `@mobile` tests, when `opts.mobile`); lane, reporters, workers (default 4), `fullyParallel` (true)       |
| `preflight(checks, {timeoutMs})` from `/playwright/preflight`                                                      | `globalSetup` factory (runs on a real run, never on `--list`). Runs every check in order, throws ONE error listing every failed one; whole run bounded (default 20 s)                                                                        |
| `loopbackOnly(url)` `httpOk(url,{timeoutMs})` `localSupabase(url,{boxHost})` `commands([bins])` `custom(name, fn)` | Built-in checks; `custom` takes any async function (run a shell script, query a seed row)                                                                                                                                                    |
| `test`, `watchConsole(page, allow)` from `/playwright/fixtures`                                                    | `workerAuth` (worker-scoped storageState per `parallelIndex`, from `use: { auth }` in the config, state file reused), `consoleGuard` (auto; `consoleOptions: { allow: RegExp[] }`), `owned(prefix)` (unique names per worker, test and call) |

Merge order, lowest first: `playwrightDefaults` < harness < your opts. Any option the harness doesn't name is passed through (`testDir`, `webServer`, `timeout`, `use`, `projects`, …) and wins; a `projects` array replaces the harness projects; `use` is merged key by key. `workers`, `retries`, `fullyParallel`, `maxFailures` and `globalTimeout` take a value or `{ default, smoke, gate, full, real }`.

| Env var             | Effect                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `E2E_LANE`          | `smoke` = `@smoke` · `gate` (default) = all but `@real`/`@manual` · `full` = all but `@manual` · `real` = `@real`. Unknown value fails                                                           |
| `E2E_VIDEO=1`       | video on + `slowMo` 300 (opts `video` / `slowMo` win)                                                                                                                                            |
| `E2E_SHARD`         | any value (or `--shard` on the CLI) adds the `blob` reporter                                                                                                                                     |
| `E2E_BLOB`          | `1` adds the `blob` reporter without sharding; so does `PLAYWRIGHT_BLOB_OUTPUT_FILE` (a runner that splits by file lists passes no `--shard` but still merges blobs)                             |
| `E2E_SHARD_TIMINGS` | path of a previous run's JSON report: with `--shard`/`E2E_SHARD`, shards by recorded duration instead of count (see below). Needs Playwright ≥ 1.62; older versions ignore it and shard by count |
| `E2E_REPORT_DIR`    | adds `html` (`<dir>/html`) and `json` (`<dir>/results.json`) reporters                                                                                                                           |
| `E2E_OUTPUT_DIR`    | `outputDir`; beats the repo's own, so parallel stacks of one repo keep separate results and `.auth` state                                                                                        |
| `CI`                | `failOnFlakyTests` in the `smoke` lane (plus `forbidOnly` from the defaults) and the lane's `maxFailures`                                                                                        |
| `GITHUB_ACTIONS`    | adds the `github` reporter (inline annotations on the PR check)                                                                                                                                  |

| Tag       | Meaning                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------- |
| `@smoke`  | Critical journeys, the PR gate                                                                 |
| `@real`   | Needs a real corpus or vendor sandbox; only in `full` and `real`                               |
| `@mobile` | Runs in the `mobile` project (in the `smoke` lane only with `@smoke` too)                      |
| `@manual` | Writes to a vendor or sandbox; never automatic (no lane runs it; select with `--grep @manual`) |

Details worth knowing:

- **Lanes** match whole tag tokens (`@real` never matches `@realtime` or `agent@realestate.com`), also inside a repo's own `projects`; the harness `setup` project always runs, and so does any project of your own that another project lists in `dependencies` (unless it sets its own `grep`).
- **`retries`** defaults to 1 on CI in the `smoke` lane (a flaky test can only be seen if a retry can pass it, which is what `failOnFlakyTests` needs); set `retries` to change it.
- **`maxFailures`** (stop after N failed tests, the rest are skipped) defaults on CI only: `smoke` 3, `gate` 10, `full`/`real` 20; outside CI it is 0 (off) so a dev or agent healing specs sees every failure. Set it (a value or per lane) and it applies everywhere. It counts per shard process.
- **`globalTimeout`** (whole run) defaults per lane, on and off CI: `smoke` 10 min, `gate` 60, `full`/`real` 120; a hung run ends with a report instead of a killed process. Set it to change it.
- **Duration-aware sharding** (opt-in): Playwright shards by count, so one slow file can make one shard the long pole. Run with `E2E_SHARD_TIMINGS=<previous merged JSON report>` and `--shard=i/n`: the harness adds `@lakestoneai/dev-config/playwright/shard-reporter`, which packs file × project units longest-first onto the least-loaded shard (whole files stay together, in order; an unknown file weighs the median). No timings file, an unreadable one, or no `--shard`: Playwright's own sharding. Setup projects still run in every shard. Every shard must see the same timings file and the same tests.
- **`consoleGuard`** needs a browser context, so even an API-only test opens one: give API specs plain `@playwright/test`. Chromium logs every failed request as `console.error: Failed to load resource: … status of 401`, so a wrong-password or expired-session test must allow it. An `allow` RegExp is tested against `<text> @ <url>` (so a pattern anchored with `$` on the text alone no longer matches), e.g. `consoleOptions: { allow: [/status of 401\b.* @ .*\/auth\/v1\//] }`. A missing favicon is ignored by default.
- **`workerAuth`** saves state as `outputDir/.auth/<index>-<email>.json`, so a worker slot given another role logs in again; the sign-in runs as a worker setup step (60 s cap, not the first test's timeout) with the project's `use` (HTTPS errors, headers, locale). Set it in the config's `use: { auth }` (an `E2EAuth` variable); a signed-out spec says `test.use({ auth: null })` (`undefined` means "unset" and keeps the config's login). A `test.use({ auth })` in a shared helper module is ignored (it only applies inside the spec file or describe that calls it), and Playwright's types do not accept a worker option in `extend()`.
- **`preflight`** starts every check at once under one deadline; a synchronous check blocks the event loop and cannot be timed out.

Lanes filter by tag, so they work with `test.fixme`, serial `describe`s and tags set per loop iteration (`{ tag: … }`). Gotchas: Playwright reads a bare two-element array or a bare function as an option value as a fixture, which is why the options are objects (`auth`, `consoleOptions`). `workerAuth` keeps state in the project's `outputDir/.auth/<index>-<email>.json`; Playwright clears `outputDir` each run, so a run logs in once per worker and a restarted worker reuses the file.

## Prettier

```json
// .prettierrc — as-is
"@lakestoneai/dev-config/prettier"
```

```js
// prettier.config.js — with a workspace's own plugins and import order
import base from '@lakestoneai/dev-config/prettier'
export default {
  ...base,
  plugins: ['@trivago/prettier-plugin-sort-imports'],
  importOrder: ['^zod$', '<THIRD_PARTY_MODULES>', '^[./]'],
}
```

House style: no semicolons, single quotes, `es5` trailing commas, width 80, LF. A repo with an established different style (width 100) overrides those keys rather than reformatting everything.

## ESLint (flat config)

```js
// eslint.config.js
import { defineConfig } from 'eslint/config'
import { typescript } from '@lakestoneai/dev-config/eslint'

export default defineConfig({
  ...typescript,
  files: ['**/*.ts'],
  rules: { ...typescript.rules, 'no-console': ['error', { allow: ['log'] }] },
})
```

`typescript` = `@eslint/js` recommended + typescript-eslint recommended + the house rules (`_`-prefixed unused names allowed, inline type imports, no duplicate imports, no console). Plugins, globals and custom rules (design-system) stay in the repo. Peer dependencies: `eslint`, `@eslint/js`, `typescript-eslint`.

## tsconfig bases

```json
{ "extends": "@lakestoneai/dev-config/tsconfig/bun.json", "include": ["src"] }
```

| Base              | For                               | Adds to `strict.json`                                                                                                    |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `strict.json`     | every workspace                   | ES2022, Bundler resolution, `noEmit`, `strict`, no unused locals/parameters, no fallthrough, checked side-effect imports |
| `bun.json`        | API, CLI, shared packages         | `types: ["bun"]`                                                                                                         |
| `react-app.json`  | Vite React app                    | DOM libs, `react-jsx`                                                                                                    |
| `node-tools.json` | vite/vitest configs, Node scripts | ES2023, `allowJs`                                                                                                        |

`include`, `paths` and `tsBuildInfoFile` stay in the repo. A workspace on Node ESM (NodeNext) overrides `module`/`moduleResolution`.

## CI: setup-bun action

```yaml
- uses: actions/checkout@<sha> # vX
- uses: lakestoneai/dev-config/.github/actions/setup-bun@<sha> # v0.3.0
  # with: { working-directory: apps/web, install: 'false' }
```

Bun from `package.json` `packageManager`, the Bun install cache keyed on `bun.lock`, then `bun install --frozen-lockfile` (retried once). Pin it by SHA; Renovate bumps it.

## Renovate preset

`default.json` is the Lakestone Renovate standard: weekly grouped PRs on Monday 00:00-05:59 AWST (app, GitHub Actions and toolchain apart), majors and the Bun runtime via the Dependency Dashboard, security fixes at any time and auto-merged on green, monthly lockfile refresh, a 3-day release age.

```json
// renovate.json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>lakestoneai/dev-config#v0.2.0"],
  "constraints": { "bun": "1.4.2" }
}
```

Pin the tag: Renovate then opens a PR when a newer tag of this preset exists. Keep in the repo only what is the repo's own: `constraints`, `baseBranchPatterns`, and extra `packageRules` (they apply after the preset's, so they win). CI validates the preset with Renovate's own validator.

## Versions

| Version | Adds                                                                                                                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.4.1   | `defineE2EConfig`: per-lane `maxFailures` (CI) and `globalTimeout`, opt-in duration-aware sharding (`E2E_SHARD_TIMINGS`), `github` reporter on Actions, `blob` also on `PLAYWRIGHT_BLOB_OUTPUT_FILE`/`E2E_BLOB=1`; `consoleGuard` is boxed. A repo on CI now stops a red run early: set `maxFailures: 0` to opt out |
| 0.4.0   | Playwright e2e harness: `defineE2EConfig`, `preflight`, fixtures. Peer `@playwright/test` is now `>=1.52` (was `>=1.40`)                                                                                                                                                                                            |
| 0.3.0   | Prettier base, ESLint base, tsconfig bases, Playwright `forbidOnly`/trace/screenshot, `setup-bun` action                                                                                                                                                                                                            |
| 0.2.0   | Renovate preset (`default.json`)                                                                                                                                                                                                                                                                                    |
| 0.1.1   | Releases stage on npm via trusted publishing                                                                                                                                                                                                                                                                        |

## Release

1. Bump `version` in `package.json` (a changed default is at least a minor: a tighter cap can turn a slow suite red; say which repos may need an override). Push to `main` and wait for CI green.
2. `gh release create v<version> --repo lakestoneai/dev-config --target main`. `publish.yml` runs the tests, then stages the version on npm via trusted publishing (no token).
3. A maintainer approves it with 2FA on npmjs.com → Staged Packages. Only then does it go live, and Renovate opens the bump PRs.

`bun run test` proves the defaults and both override paths against a real browser.
