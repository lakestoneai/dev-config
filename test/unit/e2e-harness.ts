// Shared helper: a tiny consumer project that imports the package by name and runs the real Playwright CLI.
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

// Fixture projects live in a dot-directory: `bun test` never scans dot-directories, so the *.spec.ts files inside
// are not picked up as tests of this suite if a run is interrupted and leaves them behind (a stale dir once made
// the next run import 119 of them). They still resolve the package by name and @playwright/test from the repo.
export const FIXTURE_ROOT = join(import.meta.dir, '.e2e-tmp')
mkdirSync(FIXTURE_ROOT, { recursive: true })
// sweep leftovers of dead runs, but never a live run's dirs (another run may be using this checkout right now)
for (const d of readdirSync(FIXTURE_ROOT)) {
  const p = join(FIXTURE_ROOT, d)
  if (Date.now() - statSync(p).mtimeMs > 3_600_000)
    rmSync(p, { recursive: true, force: true })
}

const made: string[] = []
export const cleanup = () =>
  made.forEach((d) => rmSync(d, { recursive: true, force: true }))

export function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(FIXTURE_ROOT, 'p-'))
  made.push(dir)
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  return dir
}

export function playwright(
  dir: string,
  args: string[],
  env: Record<string, string> = {}
) {
  const clean = { ...process.env }
  for (const k of [
    'E2E_LANE',
    'E2E_VIDEO',
    'E2E_SHARD',
    'E2E_REPORT_DIR',
    'CI',
    'GITHUB_ACTIONS',
    'E2E_SHARD_TIMINGS',
    'E2E_BLOB',
    'PLAYWRIGHT_BLOB_OUTPUT_FILE',
  ])
    delete clean[k]
  const r = Bun.spawnSync(['bunx', 'playwright', 'test', ...args], {
    cwd: dir,
    env: { ...clean, ...env },
  })
  return {
    code: r.exitCode,
    out: r.stdout.toString() + r.stderr.toString(),
  }
}

/** Titles Playwright would run, as `project › title` lines. */
export function listed(dir: string, env: Record<string, string> = {}) {
  const r = playwright(dir, ['--list'], env)
  if (r.code !== 0) throw new Error(r.out)
  return r.out
    .split('\n')
    .filter((l) => l.startsWith('  ['))
    .map((l) => {
      const [project, , ...title] = l.trim().split(' › ')
      return `${project.replace(/[[\]]/g, '')} › ${title.join(' › ')}`
    })
}

export const specs = `import { test } from '@playwright/test'
test('plain journey', async () => {})
test('critical @smoke', async () => {})
test('vendor sandbox @real', async () => {})
test('writes to vendor @manual', async () => {})
test('narrow @mobile', async () => {})
test('narrow critical @mobile @smoke', async () => {})
`
export const setupSpec = `import { test } from '@playwright/test'
test('auth', async () => {})
`
