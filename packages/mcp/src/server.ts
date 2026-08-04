import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SignalApiClient } from './client.js';
import { TOOLS } from './tools.js';

/**
 * Build the Signal MCP server (B3-D8) over a `SignalApiClient`. Registers every
 * tool from `TOOLS`; each handler calls the console API and returns its JSON as
 * text content. An API error is surfaced as an `isError` result carrying the
 * server's `{ code, message }` so the agent can react (e.g. 409 code_managed).
 *
 * The transport (stdio) is wired in `index.ts`; keeping construction separate makes
 * the server testable via the in-memory transport.
 */
export function buildMcpServer(client: SignalApiClient): McpServer {
  const server = new McpServer(
    { name: 'signal-mcp', version: '0.1.0' },
    {
      instructions:
        'Manage Signal CSAT/CES workflows: create/update/publish/pause workflows, ' +
        'set targeting rules, discover events, and read reporting. All actions are ' +
        'scoped to the account of the SIGNAL_TOKEN.',
    },
  );

  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputShape },
      // biome-ignore lint/suspicious/noExplicitAny: SDK infers per-tool arg types we erase in TOOLS.
      (async (args: any) => {
        try {
          const result = await def.handler(args ?? {}, client);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result ?? { ok: true }, null, 2),
              },
            ],
          };
        } catch (err) {
          const e = err as { status?: number; code?: string; message?: string };
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    error: {
                      status: e.status ?? 0,
                      code: e.code ?? 'error',
                      message: e.message ?? String(err),
                    },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        // biome-ignore lint/suspicious/noExplicitAny: see above.
      }) as any,
    );
  }

  return server;
}
