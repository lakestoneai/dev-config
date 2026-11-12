// How a client repo consumes the package: defaults first, repo config second.
import { defineConfig } from '@playwright/test'
import { playwrightDefaults } from '@lakestoneai/dev-config/playwright'

export default defineConfig(playwrightDefaults, {
  testDir: './specs',
  timeout: 60_000, // well above actionTimeout, so a pass proves the 10 s cap fired, not the test timeout
  reporter: 'list',
  projects: [
    { name: 'defaults' },
    { name: 'project-override', use: { actionTimeout: 2_000 } },
  ],
})
