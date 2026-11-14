import type {
  Page,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestType,
} from '@playwright/test'

export interface E2EAccount {
  email: string
  password: string
  /** Seeds localStorage after login, before the state is saved */
  storageInit?: Record<string, string> | ((page: Page) => void | Promise<void>)
  [key: string]: unknown
}
export interface ConsoleWatch {
  errors: string[]
  /** Throws one error listing every collected console error */
  check(): void
}
/** Watch a page the `consoleGuard` fixture cannot see. */
export declare function watchConsole(page: Page, allow?: RegExp[]): ConsoleWatch
export declare const test: TestType<
  PlaywrightTestArgs &
    PlaywrightTestOptions & {
      consoleOptions: { allow?: RegExp[] }
      consoleGuard: void
      /** `owned('Quote')` -> `Quote-w2-a1b2c3d4-1`, then `-2`…: unique per worker, test and call */
      owned: (prefix: string) => string
    },
  PlaywrightWorkerArgs &
    PlaywrightWorkerOptions & {
      /** Per-worker sign-in; set with `test.use({ auth })` */
      auth:
        | {
            /** Account for worker `parallelIndex` (unique per worker) */
            accounts: (index: number) => E2EAccount | Promise<E2EAccount>
            /** Signs in on a clean page; the harness then saves the state */
            login: (page: Page, account: E2EAccount) => Promise<void>
          }
        | undefined
      workerAuth: string | undefined
    }
>
