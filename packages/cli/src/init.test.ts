import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram } from './index.js';
import { runInit, WEB_SDK_DEP } from './init.js';

const KEY = 'pk_live_abc123';

describe('signal init (F2-D8)', () => {
  let dir: string;
  let out: string[];
  const sink = (line: string) => out.push(line);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'signal-init-'));
    out = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('adds the dep + writes the init snippet in a web project', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }, null, 2));

    const result = await runInit(dir, KEY, sink);

    expect(result.projectType).toBe('web');
    expect(result.depAdded).toBe(true);
    expect(result.snippetWritten).toBe(true);

    // package.json now carries the dependency.
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies[WEB_SDK_DEP]).toBeTruthy();

    // The setup file wires Signal.init with the key.
    const setup = await readFile(join(dir, 'signal-setup.js'), 'utf8');
    expect(setup).toContain(`from '${WEB_SDK_DEP}'`);
    expect(setup).toContain(`Signal.init('${KEY}')`);

    // Next steps were printed.
    expect(out.join('\n')).toContain('Next steps');
  });

  it('is idempotent — a second run does not duplicate the dep or clobber the snippet', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'my-app' }, null, 2));
    await runInit(dir, KEY, sink);
    out = [];

    const result = await runInit(dir, 'pk_different', sink);
    expect(result.depAlreadyPresent).toBe(true);
    expect(result.depAdded).toBe(false);
    expect(result.snippetAlreadyPresent).toBe(true);
    expect(result.snippetWritten).toBe(false);

    // The original key is preserved (the snippet was NOT overwritten).
    const setup = await readFile(join(dir, 'signal-setup.js'), 'utf8');
    expect(setup).toContain(`Signal.init('${KEY}')`);
    expect(setup).not.toContain('pk_different');
    expect(out.join('\n')).toContain('already');
  });

  it('preserves existing dependencies when adding the SDK', async () => {
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'my-app', dependencies: { react: '^18.0.0' } }, null, 2),
    );
    await runInit(dir, KEY, sink);
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies.react).toBe('^18.0.0');
    expect(pkg.dependencies[WEB_SDK_DEP]).toBeTruthy();
  });

  it('e2e: `signal init <key> --dir <fixture>` wires the SDK via the commander program', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-app' }, null, 2));
    const lines: string[] = [];
    const program = buildProgram({
      // The init command does not touch the API; a throwing client factory proves it.
      makeClient: () => {
        throw new Error('init must not call the API');
      },
      out: (line) => lines.push(line),
    });
    await program.parseAsync(['node', 'signal', 'init', KEY, '--dir', dir]);

    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies[WEB_SDK_DEP]).toBeTruthy();
    const setup = await readFile(join(dir, 'signal-setup.js'), 'utf8');
    expect(setup).toContain(`Signal.init('${KEY}')`);
    expect(lines.join('\n')).toContain('Next steps');
  });

  it('prints manual steps for an unknown project (no package.json)', async () => {
    const result = await runInit(dir, KEY, sink);
    expect(result.projectType).toBe('unknown');
    expect(result.depAdded).toBe(false);
    const joined = out.join('\n');
    expect(joined).toContain('Manual setup');
    expect(joined).toContain(`npm install ${WEB_SDK_DEP}`);
    expect(joined).toContain(`Signal.init('${KEY}')`);
  });
});
