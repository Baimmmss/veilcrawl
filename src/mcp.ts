import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { refreshIfStale } from './crawler.ts';
import { VeilError } from './errors.ts';
import { deleteStale } from './store.ts';
import { tools } from './tools.ts';

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'veilcrawl', version: '0.3.0' });
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema.shape }, async (args: any) => {
      try {
        const result = await tool.run(args);
        if (typeof args.site_id === 'string') refreshIfStale(args.site_id);
        return { content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result) }] };
      } catch (error) {
        // Unexpected errors can quote page content or URLs, so they stay in the local log.
        if (!(error instanceof VeilError)) console.error(error);
        const text = error instanceof VeilError ? error.message : 'Internal error. Details are in the local VeilCrawl log.';
        return { isError: true, content: [{ type: 'text' as const, text }] };
      }
    });
  }
  return server;
}

export async function runMcpServer(): Promise<void> {
  deleteStale();
  await createMcpServer().connect(new StdioServerTransport());
}
