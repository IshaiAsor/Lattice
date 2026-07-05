// Correctness-only lint for the Node workspaces — prettier owns all style questions,
// tsc (strict) owns type errors. Backoffice has its own Angular ESLint setup.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'backoffice/**',
      'ESP32Code/**',
      'coverage/**',
      '**/*.d.ts',
    ],
  },

  // TypeScript sources — recommended rules plus the type-aware promise-safety rules,
  // which catch the bug class tsc misses (fire-and-forget async, async handlers passed
  // where void is expected).
  {
    files: [
      'services/**/src/**/*.ts',
      'packages/**/src/**/*.ts',
      'tests/**/*.ts',
      'prisma/**/*.ts',
    ],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // arguments:false — Express 4 route handlers, socket.io and MQTT callbacks are async
      // by convention here; routes handle rejections via try/catch + next(err).
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],
      '@typescript-eslint/await-thenable': 'error',
      // Permit `declare global { namespace Express { ... } }` request-type augmentation.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Plain-JS tooling (device-sim, unit tests) — syntax-level checks only.
  {
    files: ['tools/**/*.js', 'tests/**/*.js'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true },
      ],
    },
  },
);
