// A repo that needs a longer cap sets it in its own `use`.
import { defineConfig } from '@playwright/test'
import { playwrightDefaults } from '@lakestoneai/dev-config/playwright'

export default defineConfig(playwrightDefaults, {
  testDir: './specs',
  timeout: 60_000,
  reporter: 'list',
  use: { actionTimeout: 3_000 },
  projects: [{ name: 'repo-override' }],
})
