import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setupGuideText } from '@signal/contracts';
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
        'scoped to the account of the SIGNAL_TOKEN. ' +
        'BOUNDARY: Signal is a hosted service consumed via its PUBLISHED npm SDK ' +
        '(@ashish221/signal-web). Never build, link, vendor, or edit the Signal SDK/' +
        'source, and never drop a local build into the user’s project — install the ' +
        'registry version only. If the published SDK seems stale, tell the user it ' +
        'needs a Signal-side release; do not patch it yourself. Only edit the user’s ' +
        'own app code.',
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

  // Guided setup (agent-guided setup): a discoverable interview script an agent can
  // pull before driving create_workflow → publish_workflow, so it asks the user for
  // the right things (rating style, media, thresholds, branched actions, cadence).
  server.registerPrompt(
    'setup_workflow',
    {
      title: 'Set up a CSAT/CES workflow',
      description:
        'Interview script + field reference for creating a Signal feedback workflow ' +
        'from a natural-language request. Pull this before calling create_workflow.',
    },
    () => ({
      messages: [
        {
          role: 'user' as const,
          content: { type: 'text' as const, text: setupGuideText() },
        },
      ],
    }),
  );

  return server;
}
