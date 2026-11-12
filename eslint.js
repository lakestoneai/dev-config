// Lakestone ESLint base for TypeScript (flat config). A repo spreads it into its own entry and adds files, globals,
// plugins and its own rules (custom design-system rules stay in the repo):
//   defineConfig({ ...typescript, files: ['**/*.ts'], rules: { ...typescript.rules, 'no-console': 'error' } })
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/** The house rules every Lakestone workspace sets identically. */
export const houseRules = {
  'no-unused-vars': 'off',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      args: 'all',
      argsIgnorePattern: '^_',
      caughtErrors: 'all',
      caughtErrorsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      ignoreRestSiblings: true,
    },
  ],
  '@typescript-eslint/consistent-type-imports': [
    'error',
    {
      prefer: 'type-imports',
      fixStyle: 'inline-type-imports',
      disallowTypeAnnotations: false,
    },
  ],
  'no-duplicate-imports': 'error',
  'no-console': 'error',
}

/** recommended JS + typescript-eslint recommended + the house rules. No `files`: the repo sets them. */
export const typescript = {
  extends: [js.configs.recommended, ...tseslint.configs.recommended],
  languageOptions: { ecmaVersion: 2022 },
  rules: houseRules,
}
