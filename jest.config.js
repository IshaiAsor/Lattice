/**
 * Root Jest config — the foundation for system-wide testing.
 *
 * - TS tests via ts-jest (lenient: integration tests, not a type-check gate); JS tests run as-is.
 * - Tests live under `tests/` (e.g. tests/e2e/*.test.ts). Per-package unit tests can be added
 *   later under each workspace and matched here.
 * - Integration/e2e suites expect the local stack (docker compose + services); they SKIP cleanly
 *   when it's down (see tests/e2e/helpers/stack.ts), so `npm test` never hard-fails on a cold box.
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.ts', '**/tests/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  testTimeout: 30000,
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: {
          allowJs: true,
          esModuleInterop: true,
          module: 'commonjs',
          target: 'es2021',
          isolatedModules: true,
        },
      },
    ],
  },
};
