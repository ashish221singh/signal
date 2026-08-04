import { defineConfig } from 'tsup';

// F1-D15: one small, dependency-free artifact. ESM + IIFE global `SignalWebCore`
// + d.ts. tokensCss and emoji SVGs are inlined (imported as strings). No CSS file.
export default defineConfig({
  entry: { 'web-core': 'src/index.ts' },
  format: ['esm', 'iife'],
  globalName: 'SignalWebCore',
  target: 'es2020',
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  sourcemap: false,
  clean: true,
  minify: true,
  treeshake: true,
  // @signal/tokens re-exports a plain string; @signal/contracts pulls zod. We do
  // NOT want zod in the bundle — web-core imports only *types* from contracts,
  // which are erased. Bundle everything else (tokens string) in.
  noExternal: ['@signal/tokens'],
  outExtension({ format }) {
    return { js: format === 'iife' ? '.global.js' : '.mjs' };
  },
});
