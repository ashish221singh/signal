// The `#!/usr/bin/env node` shebang is added by tsup's banner at build time.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SignalApiClient } from './client.js';
import { buildMcpServer } from './server.js';

/**
 * Signal MCP entrypoint (B3-D8). Runnable via `npx @ashish221/signal-mcp`. A thin
 * stdio MCP server that authenticates with a CLI token and drives the console HTTP
 * API — no DB import. Config via env:
 *   SIGNAL_API_URL   base URL of the Signal API (default: the hosted Signal API)
 *   SIGNAL_TOKEN     a CLI token (cli_…) with the needed scopes (required)
 */
const DEFAULT_API_URL = 'https://signal-api-production-eca5.up.railway.app';

async function main(): Promise<void> {
  const apiUrl = process.env.SIGNAL_API_URL ?? DEFAULT_API_URL;
  const token = process.env.SIGNAL_TOKEN;
  if (!token) {
    process.stderr.write('SIGNAL_TOKEN is required (a cli_… token). Aborting.\n');
    process.exit(1);
  }

  const client = new SignalApiClient(apiUrl, token);
  const server = buildMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`signal-mcp connected (API ${apiUrl})\n`);
}

main().catch((err) => {
  process.stderr.write(`signal-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
