#!/usr/bin/env node
import { Command } from 'commander';
import { CliClient } from './client.js';
import {
  type CommandDeps,
  deploy,
  loginDevice,
  loginPassword,
  whoami,
  workflowsList,
} from './commands.js';
import { defaultApiUrl } from './config.js';

/**
 * `@signal/cli` entrypoint (B3-D9). Commands: `login` (device flow), `login
 * --password`, `whoami`, `deploy <file>`, `workflows list`. `init`/SDK-install is
 * deferred to the frontend phase. Credentials live in `~/.signal/config.json`.
 */
const deps: CommandDeps = {
  makeClient: (apiUrl) => new CliClient(apiUrl),
  out: (line) => process.stdout.write(`${line}\n`),
};

function fail(err: unknown): never {
  const e = err as { message?: string; code?: string };
  process.stderr.write(`Error: ${e.message ?? String(err)}\n`);
  process.exit(1);
}

export function buildProgram(commandDeps: CommandDeps = deps): Command {
  const program = new Command();
  program
    .name('signal')
    .description('Signal CLI — device login, config-as-code deploy, workflow management')
    .option('--api-url <url>', 'Signal API base URL', defaultApiUrl());

  program
    .command('login')
    .description('Log in via the device flow (or --password for headless/CI)')
    .option('--password', 'use interim email+password login instead of the device flow')
    .option('--email <email>', 'email (with --password)')
    .option('--password-value <password>', 'password (with --password)')
    .action(async (opts) => {
      const apiUrl = program.opts().apiUrl as string;
      try {
        if (opts.password) {
          if (!opts.email || !opts.passwordValue) {
            throw new Error('--email and --password-value are required with --password');
          }
          await loginPassword(commandDeps, opts.email, opts.passwordValue, apiUrl);
        } else {
          await loginDevice(commandDeps, apiUrl);
        }
      } catch (err) {
        fail(err);
      }
    });

  program
    .command('whoami')
    .description('Show the current login')
    .action(async () => {
      try {
        await whoami(commandDeps);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command('deploy')
    .description('Apply a signal.config.{ts,js,json} config-as-code file')
    .argument('<file>', 'path to the deploy config')
    .action(async (file: string) => {
      try {
        const results = await deploy(commandDeps, file);
        if (results.some((r) => r.action === 'failed')) process.exit(2);
      } catch (err) {
        fail(err);
      }
    });

  const workflows = program.command('workflows').description('Manage workflows');
  workflows
    .command('list')
    .description('List the account’s workflows')
    .action(async () => {
      try {
        await workflowsList(commandDeps);
      } catch (err) {
        fail(err);
      }
    });

  return program;
}

// Only auto-run when invoked as a binary (not when imported by a test).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  buildProgram().parseAsync(process.argv).catch(fail);
}
