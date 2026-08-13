import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
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
