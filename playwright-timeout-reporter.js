// Added by `defineE2EConfig` whenever it sets a `globalTimeout`. Playwright's own message on a run-limit hit is
// "Timed out waiting Ns for the entire test run": this reporter adds what it waited for (the budget and where the
// number came from) and the tests that were still running, so a hung run says where it hung.
//   ['@lakestoneai/dev-config/playwright/timeout-reporter', { budgetMs, source }]
const secs = (ms) =>
  ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`

export default class TimeoutReporter {
  #running = new Map()
  #options
  constructor(options = {}) {
    this.#options = options
  }
  printsToStdio() {
    return false
  }
  onTestBegin(test) {
    this.#running.set(test.id, test)
  }
  onTestEnd(test) {
    this.#running.delete(test.id)
  }
  onEnd(result) {
    if (result.status !== 'timedout') return
    const { budgetMs, source } = this.#options
    const lines = [...this.#running.values()].map(
      (t) =>
        `  - ${t.parent.project()?.name ?? '?'} › ${t.titlePath().slice(2).join(' › ')}`
    )
    console.error(
      `\n[dev-config] the whole run hit its ${budgetMs ? secs(budgetMs) : ''} limit (${source ?? 'globalTimeout'}).` +
        (lines.length
          ? `\nStill running:\n${lines.join('\n')}`
          : '\nNo test was running (global setup/teardown, or a worker between tests).') +
        '\nRaise it for this run with E2E_GLOBAL_TIMEOUT=<minutes> (0 = off), or set globalTimeout in the config.'
    )
  }
}
