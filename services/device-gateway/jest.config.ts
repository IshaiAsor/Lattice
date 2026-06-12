import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  // Only run files under tests/integration/
  testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],

  // Reset mock state between every test (clears call history + return values)
  resetMocks: true,

  // Redirect workspace packages and heavy runtime deps to lightweight mocks
  moduleNameMapper: {
    '^@lattice/prisma-client$': '<rootDir>/tests/__mocks__/lattice-prisma-client.ts',
    '^@lattice/logger$':        '<rootDir>/tests/__mocks__/lattice-logger.ts',
    '^@lattice/otel$':          '<rootDir>/tests/__mocks__/lattice-otel.ts',
    '^@lattice/queue$':         '<rootDir>/tests/__mocks__/lattice-queue.ts',
    '^ioredis$':                '<rootDir>/tests/__mocks__/ioredis.ts',
  },

  // Set test env-vars before any module is loaded
  setupFiles: ['<rootDir>/tests/setup.ts'],

  // ts-jest: use the test-specific tsconfig (includes @types/jest globals)
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: './tsconfig.test.json' }],
  },

  // Show each test name in output
  verbose: true,
};

export default config;
