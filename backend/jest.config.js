/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { strict: false } }] },
  // Testcontainers needs time to pull and start the postgres:15-alpine image.
  testTimeout: 60000,
};
