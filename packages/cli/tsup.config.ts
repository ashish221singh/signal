import { defineConfig } from 'tsup';

// Publishable, self-contained CLI bin (F3 npm publish). Bundles @signal/contracts +
// commander so `npx @signal/cli init` runs on plain node with no workspace deps.
export default defineConfig({
  entry: { bin: 'src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  treeshake: true,
  noExternal: ['@signal/contracts', 'commander'],
});
