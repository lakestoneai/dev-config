import type { FullResult, Reporter } from '@playwright/test/reporter'
export interface TimeoutReporterOptions {
  /** The run limit that applies, in ms */
  budgetMs?: number
  /** Where that limit came from, e.g. "the gate lane default" */
  source?: string
}
declare class TimeoutReporter implements Reporter {
  constructor(options?: TimeoutReporterOptions)
  printsToStdio(): boolean
  onEnd(result: FullResult): void
}
export default TimeoutReporter
