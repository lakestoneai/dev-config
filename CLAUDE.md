# dev-config

Public npm package `@lakestoneai/dev-config`: Lakestone house defaults for code config that every client repo imports. Public on purpose: nothing here may be secret or client-specific (no client names, URLs, ports or data).

| Rule | Detail |
|---|---|
| One default = one behaviour test | `test/specs/` against real Chromium, written red first; `bun run test` must pass |
| Defaults only, never repo wiring | No `webServer`, `baseURL`, `testDir` or `projects`: Playwright's `defineConfig` concatenates `webServer` and repos own the rest |
| Consumers merge defaults first | `defineConfig(playwrightDefaults, {...repo})`, so a repo's key always wins; don't design anything that needs to override a repo |
| Plain ESM + hand-written `.d.ts` | No build step; `files` in `package.json` is the published surface (check with `bun pm pack --dry-run`) |
| Release | Bump `version` → push `main` (CI green) → `gh release create v<version> --target main` → `publish.yml` stages it via npm trusted publishing (OIDC, provenance) → a maintainer approves on npmjs.com with 2FA. `bun publish` can't do OIDC or staging, so don't publish locally |
| Semver | A tighter default can turn a slow repo's suite red: treat any default change as at least a minor bump and say which repos might need an override |
