// Duration-aware sharding. Playwright shards by test/file COUNT; one slow file makes one shard the long pole.
// With E2E_SHARD_TIMINGS=<a previous run's JSON report> (and --shard / E2E_SHARD), `defineE2EConfig` adds this
// reporter: in `preprocess` (Playwright >= 1.62) it turns off the built-in shard filter and keeps only this shard's
// units. A unit is one FILE in one PROJECT (the whole file stays together, in order, so `fullyParallel: false`
// semantics hold). Units are packed longest-first onto the least-loaded shard (LPT). A unit with no timing gets the
// median known unit. No timings file, an unreadable one, or Playwright < 1.62 (no `preprocess`): built-in sharding.
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

const posix = (p) => p.split('\\').join('/')
const key = (project, file) => `${project}\u0000${posix(file)}`

/** `{ 'project\0file': ms }` from a Playwright JSON report (merged or single); every result of a test counts. */
export function timingsFromReport(report) {
  const ms = new Map()
  const walk = (suite) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) {
        const k = key(t.projectName, spec.file ?? suite.file)
        const d = (t.results ?? []).reduce((n, r) => n + (r.duration ?? 0), 0)
        ms.set(k, (ms.get(k) ?? 0) + d)
      }
    for (const s of suite.suites ?? []) walk({ file: suite.file, ...s })
  }
  for (const s of report.suites ?? []) walk(s)
  return ms
}

const median = (xs) => {
  if (!xs.length) return 1
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Which unit keys land on shard `current` of `total` (1-based). Deterministic: same inputs, same answer in every shard process. */
export function assignShards(unitKeys, timings, total) {
  const unknown = median(
    unitKeys.filter((k) => timings.has(k)).map((k) => timings.get(k))
  )
  const weight = (k) => timings.get(k) ?? unknown
  const order = [...unitKeys].sort(
    (a, b) => weight(b) - weight(a) || (a < b ? -1 : 1)
  )
  const load = Array(total).fill(0)
  const shardOf = new Map()
  for (const k of order) {
    let best = 0
    for (let i = 1; i < total; i++) if (load[i] < load[best]) best = i
    load[best] += weight(k)
    shardOf.set(k, best + 1)
  }
  return shardOf
}

export default class ShardReporter {
  async preprocess({ config, suite, testRun }) {
    const file = process.env.E2E_SHARD_TIMINGS
    if (!file || !config.shard) return
    let timings
    try {
      timings = timingsFromReport(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      return // absent or unreadable: Playwright's own count sharding
    }
    if (!timings.size) return
    // setup / dependency projects are read-only in preprocess and run in every shard
    const needed = new Set(
      config.projects.flatMap((p) => [
        ...(p.dependencies ?? []),
        ...(p.teardown ? [p.teardown] : []),
      ])
    )
    const units = new Map() // key -> tests
    for (const ps of suite.suites) {
      const name = ps.project()?.name
      if (needed.has(name)) continue
      for (const t of ps.allTests()) {
        const k = key(name, relative(config.rootDir, t.location.file))
        if (!units.has(k)) units.set(k, [])
        units.get(k).push(t)
      }
    }
    const shardOf = assignShards([...units.keys()], timings, config.shard.total)
    testRun.skipSharding()
    for (const [k, tests] of units)
      if (shardOf.get(k) !== config.shard.current)
        for (const t of tests) testRun.exclude(t)
  }
}
