module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest'],
  },
  // Mirrors the paths in tsconfig.json.
  moduleNameMapper: {
    '^cdk-spa-api-gateway$': '<rootDir>/src/constructs',
  },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
  collectCoverageFrom: ['src/**/*.ts', 'bin/**/*.ts', '!bin/main.ts'],
};
