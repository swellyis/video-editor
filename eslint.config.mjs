// Lint config (ESLint flat config). Run: npx eslint .   (see deploy.sh)
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['vendor/**'] },
  js.configs.recommended,
  {
    files: ['js/**/*.js', 'sw.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.browser, ...globals.worker, ...globals.serviceworker } },
    rules: {
      'no-unused-vars': ['error', { ignoreRestSiblings: true, args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  { files: ['sw.js'], languageOptions: { sourceType: 'script' } },
  { files: ['tests/**/*.mjs', 'eslint.config.mjs'], languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } } },
];
