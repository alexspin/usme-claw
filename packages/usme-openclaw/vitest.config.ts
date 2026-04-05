import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@usme/core/assemble/types.js': path.resolve(__dirname, '../usme-core/src/assemble/types.ts'),
      '@usme/core/assemble/index.js': path.resolve(__dirname, '../usme-core/src/assemble/index.ts'),
      '@usme/core': path.resolve(__dirname, '../usme-core/src/index.ts'),
    },
  },
});
