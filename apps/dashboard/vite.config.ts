import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard is served same-origin by the API under `/app` (F3): both in
// production (static from `dist/`) and locally. `base` makes all asset URLs
// `/app/…`. In dev, proxy the API surfaces to the running API on :3000 so
// `fetch('/v1/console/auth/me')` and the server-rendered auth pages work.
const API = 'http://localhost:3000';

export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ['/v1', '/login', '/signup', '/cli', '/s', '/health', '/ready'].map((p) => [
        p,
        { target: API, changeOrigin: true },
      ]),
    ),
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
