import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['src/main/**', 'src/core/**', 'src/preload/**', 'scripts/**', '*.config.*'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['src/renderer/**'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Layering: the renderer reaches the OS only through the preload bridge, and shared code
    // is plain TypeScript that every process can import.
    files: ['src/renderer/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'node:*'],
              message: 'The renderer has no Node or Electron access.',
            },
            {
              group: ['**/core/**', '**/main/**'],
              message: 'Talk to the core through the RPC client.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              allowTypeImports: true,
              message: 'The core stays headless so the CLI and MCP server can reuse it.',
            },
          ],
          patterns: [
            {
              group: ['**/renderer/**', '**/main/**'],
              message: 'The core must not import UI or main code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/shared/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: ['electron'], patterns: ['node:*', '**/renderer/**', '**/main/**', '**/core/**'] },
      ],
    },
  },
)
