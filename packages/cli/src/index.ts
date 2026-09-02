#!/usr/bin/env node
import * as readline from 'node:readline/promises';
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
import { runInit } from './init.js';
import { defaultThreshold, runSetup, type SetupAnswers } from './setup.js';

/**
 * `@signal/cli` entrypoint (B3-D9, F2-D8). Commands: `login` (device flow), `login
 * --password`, `whoami`, `deploy <file>`, `workflows list`, and `init` (Web SDK
 * install + `Signal.init` wiring). Credentials live in `~/.signal/config.json`.
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

  program
    .command('init')
    .description('Install the Web SDK and wire Signal.init(publishableKey) into a web project')
    .argument('<publishableKey>', 'your account publishable key (pk_…)')
    .option('--dir <dir>', 'the project directory (defaults to the current directory)')
    .action(async (publishableKey: string, opts: { dir?: string }) => {
      try {
        await runInit(opts.dir ?? process.cwd(), publishableKey, commandDeps.out);
      } catch (err) {
        fail(err);
      }
    });

  program
    .command('setup')
    .description('Create a feedback ask (question, rating, chips) and deploy it')
    .option('--event <name>', 'event name — when the ask fires (skips the prompt)')
    .option('--question <text>', 'the question to show users')
    .option('--rating <star|emoji>', 'rating style (star or emoji)')
    .option('--threshold <n>', 'rating at/above which a response is positive')
    .option('--chips <list>', 'comma-separated reason chips shown on a negative rating')
    .action(
      async (opts: {
        event?: string;
        question?: string;
        rating?: string;
        threshold?: string;
        chips?: string;
      }) => {
        const parseChips = (raw: string | undefined) =>
          (raw ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const toRating = (raw: string | undefined): 'star' | 'emoji' =>
          raw === 'emoji' ? 'emoji' : 'star';

        try {
          let answers: SetupAnswers;
          // Non-interactive when the two required flags are present (scriptable / CI
          // / agent use); otherwise fall back to the interactive TTY wizard.
          if (opts.event && opts.question) {
            const ratingType = toRating(opts.rating);
            const parsed = Number.parseInt(opts.threshold ?? '', 10);
            answers = {
              eventName: opts.event,
              question: opts.question,
              ratingType,
              positiveThreshold:
                Number.isInteger(parsed) && parsed > 0 ? parsed : defaultThreshold(ratingType),
              chips: parseChips(opts.chips),
            };
          } else {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            try {
              commandDeps.out("Let's set up a feedback ask. (Log in first with `signal login`.)\n");
              const eventName = (
                await rl.question('When should we ask? Event name (e.g. checkout_completed): ')
              ).trim();
              if (!eventName) throw new Error('an event name is required');
              const question = (await rl.question('What question should we show users? ')).trim();
              if (!question) throw new Error('a question is required');
              const ratingType = toRating(
                (await rl.question('Rating style — star or emoji [star]: ')).trim(),
              );
              const def = defaultThreshold(ratingType);
              const parsed = Number.parseInt(
                (await rl.question(`Count as positive at or above [${def}]: `)).trim(),
                10,
              );
              const chips = parseChips(
                await rl.question(
                  'Reason chips on a negative rating, comma-separated (optional): ',
                ),
              );
              answers = {
                eventName,
                question,
                ratingType,
                positiveThreshold: Number.isInteger(parsed) && parsed > 0 ? parsed : def,
                chips,
              };
            } finally {
              rl.close();
            }
            commandDeps.out('');
          }

          await runSetup(commandDeps, answers);
        } catch (err) {
          fail(err);
        }
      },
    );

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
