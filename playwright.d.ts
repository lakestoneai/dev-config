import type {
  PlaywrightTestConfig,
  PlaywrightWorkerOptions,
  Project,
  ReporterDescription,
} from '@playwright/test'
export declare const playwrightDefaults: PlaywrightTestConfig

import type { E2EAuth } from './playwright-fixtures.js'

export type PerLane<T> =
  T | { default?: T; smoke?: T; gate?: T; full?: T; real?: T; manual?: T }

export interface E2EOptions extends Omit<
  PlaywrightTestConfig,
  | 'workers'
  | 'fullyParallel'
  | 'retries'
  | 'maxFailures'
  | 'globalTimeout'
  | 'timeout'
  | 'globalSetup'
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
  /** Stop after N failed tests. Default on CI: smoke 3, gate 10, full/real 20; 0 (off) outside CI; or per lane */
  maxFailures?: PerLane<number>
  /** Whole-run limit in ms, on every non-interactive run (CI or not). Default: smoke 10 min, gate 60, full/real 120, manual 60. 0 = none; or per lane. E2E_GLOBAL_TIMEOUT (minutes) beats it */
  globalTimeout?: PerLane<number>
  /** One test's limit in ms. Default 30 s (Playwright's own default, made explicit); or per lane */
  timeout?: PerLane<number>
  /** Path(s) of a global setup file, e.g. one that default-exports `preflight([...])` */
  globalSetup?: string | string[]
  /** Overrides E2E_VIDEO's video setting (any mode Playwright accepts) */
  video?: PlaywrightWorkerOptions['video']
  /** Overrides E2E_VIDEO's slowMo (ms) */
  slowMo?: number
  /** Playwright's `use`, plus the fixtures' options from `/playwright/fixtures` */
  use?: PlaywrightTestConfig['use'] & {
    auth?: E2EAuth | null
    consoleOptions?: { allow?: RegExp[]; replace?: boolean }
  }
  projects?: Project[]
  reporter?: ReporterDescription[] | string
}
export declare function defineE2EConfig(opts?: E2EOptions): PlaywrightTestConfig
