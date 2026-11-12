// Lakestone Prettier base. Use as-is (`.prettierrc`: "@lakestoneai/dev-config/prettier") or extend in
// prettier.config.js: `export default { ...base, plugins: [...], importOrder: [...] }`. Plugins and import order
// encode a repo's own aliases, so they stay in the repo.

/** @type {import('prettier').Config} */
const base = {
  arrowParens: 'always',
  semi: false,
  tabWidth: 2,
  printWidth: 80,
  singleQuote: true,
  trailingComma: 'es5',
  bracketSpacing: true,
  endOfLine: 'lf',
}

export default base
