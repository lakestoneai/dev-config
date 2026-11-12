import { expect, test } from 'bun:test'
import { ESLint } from 'eslint'
import { defineConfig } from 'eslint/config'
import { typescript } from '@lakestoneai/dev-config/eslint'

const lint = async (code: string) => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: defineConfig({ ...typescript, files: ['**/*.ts'] }),
  })
  const [res] = await eslint.lintText(code, { filePath: 'x.ts' })
  return res.messages.map((m) => m.ruleId)
}

test('flags unused vars, value imports used only as types, duplicate imports, console', async () => {
  const rules = await lint(
    `import { Foo } from './a'\nimport { Bar } from './a'\nconst unused = 1\nconsole.info(Bar)\nexport type T = Foo\n`
  )
  expect(rules).toContain('@typescript-eslint/no-unused-vars')
  expect(rules).toContain('@typescript-eslint/consistent-type-imports')
  expect(rules).toContain('no-duplicate-imports')
  expect(rules).toContain('no-console')
})

test('underscore-prefixed names are allowed', async () => {
  expect(
    await lint(
      `export function f(_a: number) {\n  const _b = 1\n  return 1\n}\n`
    )
  ).toEqual([])
})
