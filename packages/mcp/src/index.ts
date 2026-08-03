#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SignalApiClient } from './client.js';
import { buildMcpServer } from './server.js';

/**
 * `@signal/mcp` entrypoint (B3-D8). Runnable via `npx @signal/mcp`. A thin stdio
 * MCP server that authenticates with a CLI token and drives the console HTTP API —
 * no DB import. Config via env:
 *   SIGNAL_API_URL   base URL of the Signal API (default http://localhost:3000)
 *   SIGNAL_TOKEN     a CLI token (cli_…) with the needed scopes (required)
 */
async function main(): Promise<void> {
  const apiUrl = process.env.SIGNAL_API_URL ?? 'http://localhost:3000';
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
