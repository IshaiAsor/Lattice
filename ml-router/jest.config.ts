import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
  resetMocks: true,

  moduleNameMapper: {
    '^@lattice/prisma-client$': '<rootDir>/tests/__mocks__/lattice-prisma-client.ts',
    '^@lattice/logger$':        '<rootDir>/tests/__mocks__/lattice-logger.ts',
    '^@lattice/otel$':          '<rootDir>/tests/__mocks__/lattice-otel.ts',
    '^prom-client$':            '<rootDir>/tests/__mocks__/prom-client.ts',
    '^onnxruntime-node$':       '<rootDir>/tests/__mocks__/onnxruntime-node.ts',
    '^sharp$':                  '<rootDir>/tests/__mocks__/sharp.ts',
  },

  setupFiles: ['<rootDir>/tests/setup.ts'],

  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: './tsconfig.test.json' }],
  },

  verbose: true,
};

export default config;
