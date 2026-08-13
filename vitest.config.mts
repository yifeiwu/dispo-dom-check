import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  // For the automatic JSX runtime, which only the accessibility test needs. Everything else here is
  // plain TypeScript and unaffected.
  plugins: [react()],
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    /*
     * Node stays the default. The accessibility test opts itself into jsdom with a docblock, so the
     * scoring suite keeps running in the environment it was written for rather than paying for a DOM
     * that none of it touches.
     */
    environment: 'node',
    /*
     * The suite runs without a Check-Mail key, so its collector reports `unsupported` and no test can
     * reach a metered API. Vitest only copies `VITE_`-prefixed variables out of `.env` today, so this
     * is already true; it is pinned here because the day someone adds `loadEnv` for an unrelated
     * reason, the whole suite would quietly start spending a thousand-lookup monthly allowance.
     * A test wanting the keyed path sets it with `vi.stubEnv`.
     */
    env: { CHECKMAIL_API_KEY: '' },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname),
    },
  },
});
