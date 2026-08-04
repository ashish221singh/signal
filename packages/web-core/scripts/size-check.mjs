// Core bundle size budget (F1-D15): the ESM artifact must be <= 35 KB gzip,
// EXCLUDING the self-hosted font files (data-URI woff2). We strip the font
// base64 payloads before gzipping so the number reflects the actual code + token
// CSS + emoji the shell ships, not the fonts.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const distFile = join(here, '..', 'dist', 'web-core.mjs');

const BUDGET_KB = 35;

let code;
try {
  code = readFileSync(distFile, 'utf8');
} catch {
  console.error(
    `size-check: ${distFile} not found — run \`pnpm --filter @signal/web-core build\` first.`,
  );
  process.exit(1);
}

// Strip data:font/woff2;base64,<...> payloads (fonts are excluded from the budget).
const fontDataUri = /data:font\/woff2;base64,[A-Za-z0-9+/=]+/g;
const fontMatches = code.match(fontDataUri) ?? [];
const fontBytes = fontMatches.reduce((n, s) => n + s.length, 0);
const codeOnly = code.replace(fontDataUri, 'data:font/woff2;base64,');

const gzipFull = gzipSync(Buffer.from(code)).length;
const gzipCore = gzipSync(Buffer.from(codeOnly)).length;
const budgetBytes = BUDGET_KB * 1024;

const kb = (n) => (n / 1024).toFixed(2);
console.log(`web-core bundle (incl. fonts): ${kb(gzipFull)} KB gzip`);
console.log(
  `  font data-URIs stripped:     ${fontMatches.length} (${kb(fontBytes)} KB raw base64)`,
);
console.log(`web-core CORE (excl. fonts):   ${kb(gzipCore)} KB gzip  (budget ${BUDGET_KB} KB)`);

if (gzipCore > budgetBytes) {
  console.error(`\n✗ Core bundle ${kb(gzipCore)} KB exceeds the ${BUDGET_KB} KB gzip budget.`);
  process.exit(1);
}
console.log(`\n✓ Within the ${BUDGET_KB} KB gzip budget.`);
