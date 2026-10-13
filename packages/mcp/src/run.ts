import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { discoverApi, type FoundApi } from '@communal/core';
import { createServer } from './server.js';

/**
 * Runs the MCP server on stdio. It finds the running core lazily, on the first tool call, and
 * looks again whenever the one it had stops answering, so it works when started before the app
 * and survives the app or daemon restarting.
 */
export async function runStdio(): Promise<void> {
  let found: FoundApi | null = null;
  const api = async () => {
    if (
      found &&
      (await found.client.get('/v1/status').then(
        () => true,
        () => false,
      ))
    )
      return found.client;
    found = await discoverApi();
    if (!found)
      throw new Error(
        "Communal isn't running, or doesn't allow control: open the Communal app and turn on " +
          'Settings › AI agents › "Allow control from the CLI and AI agents", or start `communal daemon`.',
      );
    return found.client;
  };
  const where = () =>
    found
      ? found.kind === 'desktop'
        ? 'the Communal desktop app'
        : `communal daemon (${found.socketPath})`
      : 'nothing yet';
  const server = createServer(api, where);
  await server.connect(new StdioServerTransport());
}
