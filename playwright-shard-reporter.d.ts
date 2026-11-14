import type { Reporter } from '@playwright/test/reporter'
/** Per-unit (`project\0file`) milliseconds from a Playwright JSON report. */
export declare function timingsFromReport(report: unknown): Map<string, number>
/** Unit key -> 1-based shard, longest-first onto the least-loaded shard. */
export declare function assignShards(
  unitKeys: string[],
  timings: Map<string, number>,
  total: number
): Map<string, number>
export default class ShardReporter implements Reporter {
  preprocess(params: {
    config: import('@playwright/test/reporter').FullConfig
    suite: import('@playwright/test/reporter').Suite
    testRun: unknown
  }): Promise<void>
}
