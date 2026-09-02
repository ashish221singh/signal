import { defineConfig } from 'tsup';

// Publishable, self-contained Web SDK bundle (F3 npm publish). Everything (web-core,
// contracts, tokens) is inlined so `npm install @signal/web` needs no workspace deps.
export default defineConfig({
  entry: ['src/index.ts', 'src/outbox.ts', 'src/suppression.ts', 'src/webHost.ts'],
  format: ['esm', 'cjs'],
  target: 'es2020',
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  clean: true,
  treeshake: true,
  minify: true,
  noExternal: ['@signal/contracts', '@signal/web-core', '@signal/tokens'],
});
