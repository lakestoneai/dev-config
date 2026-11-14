import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assignShards,
  timingsFromReport,
} from '@lakestoneai/dev-config/playwright/shard-reporter'
import { cleanup, playwright, project } from './e2e-harness'

setDefaultTimeout(120_000)
afterAll(cleanup)

// A skewed run: 12 files, one 40 s, then 30, 20, 20, 15, 15, 10 x4, 5 x2 (total 190 s; ideal per shard of 3 = 63.3 s)
const SECONDS = [40, 30, 20, 20, 15, 15, 10, 10, 10, 10, 5, 5]
const report = (names: string[], secs: number[]) => ({
  suites: names.map((file, i) => ({
    title: file,
    file,
    specs: [
      {
        title: 't1',
        file,
        tests: [
          {
            projectName: 'chromium',
            results: [{ duration: secs[i] * 1000 * 0.5 }],
          },
        ],
      },
      {
        title: 't2',
        file,
        tests: [
          {
            projectName: 'chromium',
            results: [{ duration: secs[i] * 1000 * 0.5 }],
          },
        ],
      },
    ],
  })),
})
const names = SECONDS.map((_, i) => `f${String(i).padStart(2, '0')}.spec.ts`)
const timingsFile = join(mkdtempSync(join(tmpdir(), 'e2e-timings-')), 't.json')
writeFileSync(timingsFile, JSON.stringify(report(names, SECONDS)))

const files = Object.fromEntries(
  names.map((f, i) => [
    f,
    `import { test } from '@playwright/test'\ntest('${f} one', async () => {})\ntest('${f} two', async () => {})\n`,
  ])
)
const dir = project({
  'playwright.config.ts': `import { defineE2EConfig } from '@lakestoneai/dev-config/playwright'
export default defineE2EConfig({ workers: 1, fullyParallel: false })
`,
  'auth.setup.ts': `import { test } from '@playwright/test'\ntest('auth', async () => {})\n`,
  ...files,
})

/** file -> shard index, from a real run of every shard */
function runShards(total: number, env: Record<string, string>) {
  const ran: string[][] = []
  for (let i = 1; i <= total; i++) {
    const r = playwright(dir, ['--project=chromium', `--shard=${i}/${total}`], {
      E2E_SHARD: '1',
      ...env,
    })
    expect(r.code).toBe(0)
    ran.push(
      [...r.out.matchAll(/(f\d\d\.spec\.ts) (?:one|two)/g)].map(
        (m) => m[1] + '|' + m[0].slice(-3)
      )
    )
  }
  return ran
}

test('timingsFromReport: sums results per project and file', () => {
  const m = timingsFromReport(report(['a.spec.ts'], [10]))
  expect([...m]).toEqual([['chromium\u0000a.spec.ts', 10_000]])
})

test('assignShards: longest first onto the least-loaded shard, deterministic', () => {
  const t = new Map(names.map((f, i) => [f, SECONDS[i]]))
  const a = assignShards(names, t, 3)
  const b = assignShards([...names].reverse(), t, 3)
  expect([...a].sort()).toEqual([...b].sort())
  const load = [0, 0, 0]
  for (const [f, s] of a) load[s - 1] += t.get(f)!
  expect(Math.max(...load)).toBeLessThanOrEqual((190 / 3) * 1.2)
})

test('with timings: N shards, union = every test once, no duplicates, max bin <= 1.2x ideal', () => {
  const ran = runShards(3, { E2E_SHARD_TIMINGS: timingsFile })
  const all = ran.flat()
  expect(all.length).toBe(24)
  expect(new Set(all).size).toBe(24)
  // a file never splits across shards
  const shardOfFile = new Map<string, number>()
  ran.forEach((tests, i) =>
    tests.forEach((t) => {
      const f = t.split('|')[0]
      expect(shardOfFile.get(f) ?? i).toBe(i)
      shardOfFile.set(f, i)
    })
  )
  const load = [0, 0, 0]
  for (const [f, i] of shardOfFile) load[i] += SECONDS[names.indexOf(f)]
  expect(Math.max(...load)).toBeLessThanOrEqual((190 / 3) * 1.2)
  // the built-in count sharding of the same fixture is worse (this is what the reporter fixes)
  const counted = runShards(3, {})
  const cLoad = [0, 0, 0]
  counted.forEach((tests, i) =>
    new Set(tests.map((t) => t.split('|')[0])).forEach(
      (f) => (cLoad[i] += SECONDS[names.indexOf(f)])
    )
  )
  expect(Math.max(...cLoad)).toBeGreaterThan(Math.max(...load))
})

test('a unit with no timing gets the median; none is dropped or duplicated', () => {
  const partial = join(mkdtempSync(join(tmpdir(), 'e2e-timings-')), 'p.json')
  writeFileSync(
    partial,
    JSON.stringify(report(names.slice(0, 6), SECONDS.slice(0, 6)))
  )
  const ran = runShards(3, { E2E_SHARD_TIMINGS: partial }).flat()
  expect(ran.length).toBe(24)
  expect(new Set(ran).size).toBe(24)
})

test('no timings file, or an unreadable one: built-in count sharding', () => {
  const builtin = runShards(3, {})
  for (const bad of ['/nonexistent/t.json']) {
    expect(runShards(3, { E2E_SHARD_TIMINGS: bad })).toEqual(builtin)
  }
  const junk = join(mkdtempSync(join(tmpdir(), 'e2e-timings-')), 'j.json')
  writeFileSync(junk, 'not json')
  expect(runShards(3, { E2E_SHARD_TIMINGS: junk })).toEqual(builtin)
})

test('without --shard the timings file changes nothing', () => {
  const r = playwright(dir, ['--project=chromium'], {
    E2E_SHARD_TIMINGS: timingsFile,
  })
  expect(r.out).toContain('25 passed') // 24 + setup
})

test('timings from a real JSON report key the same files the reporter sees', () => {
  const rep = mkdtempSync(join(tmpdir(), 'e2e-rep-'))
  const r = playwright(dir, ['--project=chromium'], { E2E_REPORT_DIR: rep })
  expect(r.code).toBe(0)
  const m = timingsFromReport(
    JSON.parse(require('node:fs').readFileSync(`${rep}/results.json`, 'utf8'))
  )
  expect(m.has('chromium\u0000f00.spec.ts')).toBe(true)
  // feeding it back as timings keeps the run whole across 2 shards
  const ran = runShards(2, { E2E_SHARD_TIMINGS: `${rep}/results.json` }).flat()
  expect(new Set(ran).size).toBe(24)
})

test('assignShards: an unknown unit weighs the median known one, so unknowns spread', () => {
  const known = new Map([
    ['a', 30],
    ['b', 30],
    ['c', 30],
  ])
  const s = assignShards(['a', 'b', 'c', 'x', 'y', 'z'], known, 3)
  const per = [1, 2, 3].map(
    (i) => [...s.values()].filter((v) => v === i).length
  )
  expect(per).toEqual([2, 2, 2])
})

test('PLAYWRIGHT_BLOB_OUTPUT_FILE writes a blob zip without --shard', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'e2e-blob-')), 'report-1.zip')
  const r = playwright(dir, ['--project=chromium', 'f00.spec.ts'], {
    PLAYWRIGHT_BLOB_OUTPUT_FILE: out,
  })
  expect(r.code).toBe(0)
  expect(require('node:fs').existsSync(out)).toBe(true)
})
