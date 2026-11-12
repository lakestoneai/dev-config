import { expect, test } from 'bun:test'
import { join } from 'node:path'
import * as prettier from 'prettier'
import base from '@lakestoneai/dev-config/prettier'

test('formats with the house style (no semicolons, single quotes, es5 commas, width 80)', async () => {
  const src =
    'const a = { b: "x", c: [1, 2, 3], d: function () { return 1; } };\n'
  const out = await prettier.format(src, { ...base, parser: 'typescript' })
  expect(out).toBe(
    `const a = {\n  b: 'x',\n  c: [1, 2, 3],\n  d: function () {\n    return 1\n  },\n}\n`
  )
})

test('a repo can point .prettierrc at the package by name', async () => {
  const resolved = await prettier.resolveConfig(
    join(import.meta.dir, 'fixtures/prettier-by-name/x.ts')
  )
  expect(resolved).toEqual(base)
})
