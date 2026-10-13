# ADR 0017 — Control by AI agents (MCP) and the local control socket

- Status: accepted (after M9)
- Date: 2026-10-12

The owner wants AI agents such as Claude to use Communal through both clients, and in particular to work with a desktop app that is already open, without restarting it.

## Decision

### One local API, two ways in

The core's local API (`LocalApi`) is the only interface agents use, just as it is for the CLI and the renderer.

- **Headless:** unchanged. `communal daemon` serves the API on `<data>/api.sock` (mode 0600, in a 0700 directory).
- **Desktop:** besides the token-protected 127.0.0.1 port that only main knows (ADR 0016), the core host can serve the same API on a **control socket**: `<userData>/core/api.sock`, or on Windows a named pipe `\\.\pipe\communal-<hash of the data dir>` (`apiSocketPath()`). It is **off by default**. The person turns it on in Settings › AI agents ("Allow control from the CLI and AI agents"), and it starts or stops immediately: main tells the host, and nothing restarts. The choice is kept in `<userData>/prefs.json`.
- Access control is the same as the headless daemon: only processes running as the same OS user can open the socket. That's the boundary that already protects the key files. The setting exists so the desktop app exposes nothing beyond its own window unless the person asks.

`discoverApi()` in core finds a running core in this order: `COMMUNAL_API_SOCKET`, the headless daemon (`COMMUNAL_DATA` or `~/.communal`), then the desktop app's socket. The CLI uses it too. When no daemon is running, `communal …` commands reach the open app.

### The MCP server (`packages/mcp`)

- A stdio MCP server (`@modelcontextprotocol/sdk`) whose tools call the local API. It finds the core lazily, on the first tool call, and looks again whenever the one it had stops answering. So it can start before the app does, and it survives restarts.
- How it runs:
  - `communal mcp` (CLI).
  - `communal-mcp` (package bin).
  - **Inside the desktop app:** the app's own binary in Node mode, `ELECTRON_RUN_AS_NODE=1 <app> <app>/…/@communal/mcp/dist/main.js`. Nothing else needs installing. Settings › AI agents shows the exact `claude mcp add` command and an `mcpServers` block for other clients.
- **Scope: everything except secrets and trust** (owner decision):
  - Included: search, browse, preview text, download and transfers, the upload log, shares, access rules, connections, groups, subscriptions, hubs (join and leave), network, upload limits, and `show_in_app`.
  - **Excluded:** exporting the recovery key; creating link codes or approving, denying or revoking devices; account link and restore; and marking a person as verified, since that only means something when two people compare a code.
  - Excluded tools don't exist in the server at all, rather than being refused at call time.
  - _Amended by ADR 0020:_ hub admin tools are added, refused by the hub unless the account is an admin. Making someone an admin stays shell only.
- Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`), so clients ask before changes. The server instructions tell the agent to confirm audiences before opening files to other people.

### `show_in_app`

`POST /v1/ui/show {screen, …}` lets an agent show the person what it did. `LocalApi` takes an optional `ui` hook, and only the desktop host provides one. The host sends the route to main, which brings the window forward and passes the route to the renderer as `ui:navigate`. On the headless daemon the route answers `not_found` ("no app window").

## Consequences

- A local process running as the user can, once the setting is on, do anything the tools allow. That's no more than such a process could already do to that user's files. The recovery key and device trust stay out of reach.
- The MCP server is a client of the public local API, so new API routes don't reach agents until a tool is added deliberately.
- Tests: `test/integration/m9-mcp.test.ts` drives the server through the MCP SDK client against a real core and hub. It covers tool listing (and that excluded tools are absent), a full join → share → set_access → search flow, `show_in_app` on headless and desktop, and socket discovery.
