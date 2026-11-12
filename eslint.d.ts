import type { Linter } from 'eslint'
export declare const houseRules: Linter.RulesRecord
export declare const typescript: {
  extends: unknown[]
  languageOptions: { ecmaVersion: 2022 }
  rules: Linter.RulesRecord
}
