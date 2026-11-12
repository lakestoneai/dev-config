import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A consumer extends a base by package name; tsc must resolve it and enforce the strict checks.
const made: string[] = []
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })))

const tsc = (base: string, code: string) => {
  const dir = mkdtempSync(join(import.meta.dir, 'fixtures/tsc-'))
  made.push(dir)
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      extends: `@lakestoneai/dev-config/tsconfig/${base}.json`,
      include: ['*.ts', '*.tsx'],
    })
  )
  writeFileSync(join(dir, base === 'react-app' ? 'x.tsx' : 'x.ts'), code)
  const r = Bun.spawnSync(['bunx', 'tsc', '-p', dir], { cwd: import.meta.dir })
  return { code: r.exitCode, out: r.stdout.toString() }
}

for (const base of ['bun', 'react-app', 'node-tools']) {
  test(`${base}: clean code passes`, () => {
    expect(
      tsc(base, 'export const add = (a: number, b: number) => a + b\n').code
    ).toBe(0)
  })
  test(`${base}: an unused local and an implicit any fail`, () => {
    const r = tsc(
      base,
      'export function f(x) {\n  const unused = 1\n  return x\n}\n'
    )
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('TS6133') // unused
    expect(r.out).toContain('TS7006') // implicit any (strict)
  })
}

test('bun: Bun globals are typed', () => {
  expect(tsc('bun', 'export const v: string = Bun.version\n').code).toBe(0)
})
test('react-app: JSX and DOM are available', () => {
  expect(
    tsc('react-app', 'export const el = <div>{document.title}</div>\n').code
  ).toBe(0)
})
