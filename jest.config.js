/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  // Allow ts-jest to transform expo-modules-core (ESM) and react-native packages
  transformIgnorePatterns: [
    'node_modules/(?!(expo-modules-core|@expo|react-native)/)',
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react' } }],
    '^.+\\.js$': ['ts-jest', { tsconfig: { jsx: 'react', allowJs: true } }],
  },
  modulePathIgnorePatterns: ['<rootDir>/example/'],
};
