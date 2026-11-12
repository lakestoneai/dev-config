# @lakestoneai/dev-config

Lakestone's house defaults for code config. Each client repo imports these and keeps only its own exceptions; a fix here reaches every repo as a Renovate bump PR that the repo's own CI proves.

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

| Setting | Value | Playwright's own default |
|---|---|---|
| `use.actionTimeout` | 10 s | 0 (wait forever) |
| `use.navigationTimeout` | 30 s | 0 (wait forever) |

Defaults go first: `defineConfig` merges `use` and `expect` key by key, so anything the repo sets wins, at config level or per project. A slow page needs a longer cap: set `actionTimeout` in that repo's `use`, that project's `use`, or one spec's `test.use()`.

Why: with no `actionTimeout`, a click on a missing element waits forever. A normal test run is still capped by the test timeout (with a vague "Test timeout exceeded" error); Playwright's planner/generator/healer agents and scripted runs have no test timeout and hang.

## Release

1. Bump `version` in `package.json` (a changed default is at least a minor: a tighter cap can turn a slow suite red; say which repos may need an override). Push to `main` and wait for CI green.
2. `gh release create v<version> --repo lakestoneai/dev-config --target main`. `publish.yml` runs the tests, then stages the version on npm via trusted publishing (no token).
3. A maintainer approves it with 2FA on npmjs.com → Staged Packages. Only then does it go live, and Renovate opens the bump PRs.

`bun run test` proves the defaults and both override paths against a real browser.
