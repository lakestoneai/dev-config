// Shared helper: a tiny consumer project that imports the package by name and runs the real Playwright CLI.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const made: string[] = []
export const cleanup = () =>
  made.forEach((d) => rmSync(d, { recursive: true, force: true }))

export function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(import.meta.dir, 'fixtures/e2e-'))
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
