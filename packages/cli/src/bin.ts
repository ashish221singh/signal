// Published CLI entry (F3 npm). Always runs — unlike index.ts's import guard, which
// exists so tests can import buildProgram without executing it. The `#!/usr/bin/env
// node` shebang is added by tsup's banner at build time.
import { buildProgram } from './index.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((err) => {
    const e = err as { message?: string };
    process.stderr.write(`Error: ${e.message ?? String(err)}\n`);
    process.exit(1);
  });
