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

## Release

1. Bump `version` in `package.json` (a changed default is at least a minor: a tighter cap can turn a slow suite red; say which repos may need an override). Push to `main` and wait for CI green.
2. `gh release create v<version> --repo lakestoneai/dev-config --target main`. `publish.yml` runs the tests, then stages the version on npm via trusted publishing (no token).
3. A maintainer approves it with 2FA on npmjs.com → Staged Packages. Only then does it go live, and Renovate opens the bump PRs.

`bun run test` proves the defaults and both override paths against a real browser.
