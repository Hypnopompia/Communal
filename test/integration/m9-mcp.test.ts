/**
 * M9 (ADR 0017): an AI agent drives Communal through the MCP server, against a real core and
 * hub, the same way it would reach the open desktop app over its local socket.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generateKeyPair } from '@communal/crypto';
import {
  CommunalCore,
  LocalApi,
  LocalApiClient,
  apiSocketPath,
  discoverApi,
  type UiRoute,
} from '@communal/core';
import { createServer } from '@communal/mcp';
import { HubDb } from '@communal/hub';
import { sleep, startTestHub } from '@communal/hub/testing';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function setup(ui?: { show(r: UiRoute): void }) {
  const hubDir = tmp('communal-mcp-hub-');
  const db = new HubDb(join(hubDir, 'hub.db'));
  const hub = await startTestHub({ dir: hubDir, db, silenceMs: 5_000 });
  cleanups.push(async () => {
    await hub.close();
    db.close();
  });
  const dataDir = tmp('communal-mcp-');
  const core = new CommunalCore({
    dataDir,
    device: generateKeyPair(),
    hubClient: { pingIntervalMs: 1_000, silenceMs: 5_000 },
    indexer: { flushMs: 100 },
    log: pino({ level: 'silent' }),
  });
  await core.start();
  cleanups.push(() => core.stop());
  const api = new LocalApi(core, ui);
  const socketPath = apiSocketPath(dataDir);
  await api.listen({ socketPath });
  cleanups.push(() => api.close());

  const client = new LocalApiClient({ socketPath });
  const server = createServer(
    async () => client,
    () => 'test core',
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const agent = new Client({ name: 'test-agent', version: '0' });
  await agent.connect(b);
  cleanups.push(() => agent.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await agent.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    const text = r.content[0]!.text;
    if (r.isError) throw new Error(text);
    return JSON.parse(text) as Record<string, unknown>;
  };
  return { hub, core, dataDir, agent, call };
}

describe('M9: MCP server', () => {
  it('lists tools, never the ones that handle secrets or trust', async () => {
    const { agent } = await setup();
    const { tools } = await agent.listTools();
    const names = tools.map((t) => t.name);
    for (const t of [
      'search_files',
      'browse_folder',
      'download_file',
      'share_folder',
      'set_access',
      'show_in_app',
    ])
      expect(names).toContain(t);
    // Hub admins may approve people onto their hub (ADR 0020), never devices onto an account,
    // and nothing can make someone an admin.
    for (const forbidden of [
      /recovery/,
      /revoke/,
      /approve_(device|link)/,
      /link/,
      /verify/,
      /admin_(add|remove)|make_admin/,
    ]) {
      expect(names.filter((n) => forbidden.test(n))).toEqual([]);
    }
    // Reads say so; removals are marked destructive, so clients ask first.
    const ann = (n: string) => tools.find((t) => t.name === n)!.annotations;
    expect(ann('search_files')).toMatchObject({ readOnlyHint: true });
    expect(ann('stop_sharing')).toMatchObject({ destructiveHint: true });
  });

  it('joins a hub, shares a folder, opens it to the hub and finds it, all through tools', async () => {
    const { hub, call } = await setup();
    const joined = (await call('join_hub', {
      url: hub.url,
      display_name: 'alice',
      device_name: 'laptop',
    })) as { hub: { id: string } };
    const folder = tmp('communal-mcp-share-');
    writeFileSync(join(folder, 'holiday notes.txt'), 'sunny');
    await call('share_folder', { path: folder, name: 'Notes' });
    await call('set_access', { hub: joined.hub.id, path: 'Notes/', audience: 'hub' });
    const rules = (await call('get_access_rules', { hub: joined.hub.id })) as {
      rules: Record<string, { path: string; audience: unknown }[]>;
    };
    expect(rules.rules[joined.hub.id]).toEqual([{ path: 'Notes/', audience: 'hub' }]);

    let hits: { name: string }[] = [];
    for (let i = 0; i < 100 && hits.length === 0; i++) {
      hits = ((await call('search_files', { query: 'holi' })) as { hits: { name: string }[] }).hits;
      if (!hits.length) await sleep(100);
    }
    expect(hits.map((h) => h.name)).toEqual(['holiday notes.txt']);
    expect(await call('get_status')).toMatchObject({ connected_to: 'test core' });
  });

  it('show_in_app moves the desktop window, and says when there is none', async () => {
    const headless = await setup();
    await expect(headless.call('show_in_app', { screen: 'transfers' })).rejects.toThrow(/headless/);

    const shown: UiRoute[] = [];
    const desktop = await setup({ show: (r) => shown.push(r) });
    await desktop.call('show_in_app', { screen: 'search', q: 'beach' });
    expect(shown).toEqual([{ screen: 'search', q: 'beach' }]);
  });

  it('finds a running core by its socket', async () => {
    const { dataDir } = await setup();
    const found = await discoverApi({ COMMUNAL_DATA: dataDir, COMMUNAL_USER_DATA: tmp('nope-') });
    expect(found).toMatchObject({ kind: 'headless', socketPath: apiSocketPath(dataDir) });
    expect(
      await discoverApi({ COMMUNAL_DATA: tmp('empty-'), COMMUNAL_USER_DATA: tmp('nope-') }),
    ).toBeNull();
  });
});
