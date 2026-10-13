import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'apps/desktop/out/**',
      'apps/desktop/release/**',
      'apps/cli/release/**',
      'apps/hub/release/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The static site's browser script.
    files: ['site/**/*.js'],
    languageOptions: {
      globals: { document: 'readonly', navigator: 'readonly', fetch: 'readonly' },
    },
  },
  {
    // Plain Node build scripts (packaging, icons).
    files: ['**/scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', Buffer: 'readonly' },
    },
  },
);
