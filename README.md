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

## Release

1. Bump `version` in `package.json` (a changed default is at least a minor: a tighter cap can turn a slow suite red; say which repos may need an override). Push to `main` and wait for CI green.
2. `gh release create v<version> --repo lakestoneai/dev-config --target main`. `publish.yml` runs the tests, then stages the version on npm via trusted publishing (no token).
3. A maintainer approves it with 2FA on npmjs.com → Staged Packages. Only then does it go live, and Renovate opens the bump PRs.

`bun run test` proves the defaults and both override paths against a real browser.
