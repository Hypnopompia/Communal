#!/usr/bin/env node
// `communal-mcp`: the Communal MCP server on stdio (ADR 0017). Also runs as `communal mcp`, and
// inside the desktop app as `ELECTRON_RUN_AS_NODE=1 Communal <this file>`.
import { runStdio } from './run.js';

runStdio().catch((err: Error) => {
  console.error(`communal-mcp: ${err.message}`);
  process.exit(1);
});
