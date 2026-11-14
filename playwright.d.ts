import type {
  PlaywrightTestConfig,
  Project,
  ReporterDescription,
} from '@playwright/test'
export declare const playwrightDefaults: PlaywrightTestConfig

import type { E2EAuth } from './playwright-fixtures.js'

export type PerLane<T> =
  T | { default?: T; smoke?: T; gate?: T; full?: T; real?: T }

export interface E2EOptions extends Omit<
  PlaywrightTestConfig,
  'workers' | 'fullyParallel' | 'retries'
> {
  /** use.baseURL */
  baseURL?: string
  /** Auth state file for the `chromium` (and `mobile`) project; written by a `*.setup.ts` */
  storageState?: string
  /** Add the `mobile` project (390 wide, `@mobile` tests only) */
  mobile?: boolean
  /** Default 4; or per lane */
  workers?: PerLane<number>
  /** Default true; or per lane */
  fullyParallel?: PerLane<boolean>
  /** Playwright's default (0); or per lane */
  retries?: PerLane<number>
  /** Path of a global setup file, e.g. one that default-exports `preflight([...])` */
  globalSetup?: string
  /** Overrides E2E_VIDEO's video setting */
  video?: 'on' | 'off' | 'retain-on-failure' | 'on-first-retry'
  /** Overrides E2E_VIDEO's slowMo (ms) */
  slowMo?: number
  /** Playwright's `use`, plus the fixtures' options from `/playwright/fixtures` */
  use?: PlaywrightTestConfig['use'] & {
    auth?: E2EAuth | null
    consoleOptions?: { allow?: RegExp[] }
  }
  projects?: Project[]
  reporter?: ReporterDescription[] | string
}
export declare function defineE2EConfig(opts?: E2EOptions): PlaywrightTestConfig
