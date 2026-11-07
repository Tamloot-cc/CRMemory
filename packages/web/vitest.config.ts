import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: {
    alias: {
      '@retainer/sdk': fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)),
      '@retainer/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-animation-event.ts', 'src/test-setup.ts'],
    environmentOptions: { jsdom: { url: 'http://localhost:8787/app/' } },
  },
});
