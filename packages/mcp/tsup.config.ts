import { defineConfig } from 'tsup';

// Publishable, self-contained MCP server bin (F3 npm). Bundles @signal/contracts;
// keeps @modelcontextprotocol/sdk + zod as external deps (real npm packages).
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  treeshake: true,
  noExternal: ['@signal/contracts'],
});
