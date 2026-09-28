import js from '@eslint/js';

export default [
  { ignores: ['node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: Object.fromEntries(['process', 'console', 'fetch', 'URL', 'URLSearchParams', 'AbortSignal', 'setTimeout', 'clearTimeout', 'Response'].map(name => [name, 'readonly'])),
    },
    rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }] },
  },
];
