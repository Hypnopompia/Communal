/**
 * Agent tools beyond ADR 0017 (ADR 0021): thumbnails an agent can look at, through the same
 * access checks as the app.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { generateKeyPair } from '@communal/crypto';
import { CommunalCore, LocalApi, LocalApiClient, apiSocketPath } from '@communal/core';
import { png } from '@communal/core/testing';
import { createServer } from '@communal/mcp';
import { HubDb } from '@communal/hub';
import { sleep, startTestHub, type TestHub } from '@communal/hub/testing';

const quiet = pino({ level: 'silent' });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function hub(): Promise<TestHub> {
  const dir = tmp('communal-m12-hub-');
  const db = new HubDb(join(dir, 'hub.db'));
  const t = await startTestHub({ dir, db, silenceMs: 20_000 });
  cleanups.push(async () => {
    await t.close();
    db.close();
  });
  return t;
}

async function core(name: string) {
  const c = new CommunalCore({
    dataDir: tmp(`communal-m12-${name}-`),
    device: generateKeyPair(),
    hubClient: { pingIntervalMs: 1_000, silenceMs: 20_000, backoff: { initialMs: 50, maxMs: 300 } },
    indexer: { flushMs: 100 },
    peer: { loopback: true },
    media: { concurrency: 2 },
    log: quiet,
  });
  cleanups.push(() => c.stop());
  await c.start();
  return c;
}

/** An AI agent on `c`, through its local API and the MCP server. */
async function agentOn(c: CommunalCore) {
  const api = new LocalApi(c);
  const socketPath = apiSocketPath(tmp('communal-m12-sock-'));
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
  return async (name: string, args: Record<string, unknown> = {}) =>
    (await agent.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: (
        { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
      )[];
    };
}

async function until(cond: () => boolean | Promise<boolean>, ms: number, label: string) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

const acct = (n: string) => ({
  display_name: n,
  device_name: `${n}-box`,
  platform: 'linux' as const,
});

describe('M12: agent tools', () => {
  it('shows an agent thumbnails it may see, and nothing of the rest', async () => {
    const h = await hub();
    const alice = await core('alice');
    const ha = (await alice.addHub(h.url, acct('alice'))).hub.id;
    const pub = tmp('communal-m12-pub-');
    const priv = tmp('communal-m12-priv-');
    await png(join(pub, 'beach.png'), 160, 120, 1);
    await png(join(priv, 'secret.png'), 160, 120, 2);
    await alice.addShare('Public', pub);
    await alice.setRule(ha, 'Public/', 'hub');
    await alice.addShare('Private', priv); // only alice, the default
    await until(
      () => alice.store.counts().hashed === 2 && alice.store.mediaCounts().pending === 0,
      30_000,
      'media',
    );
    const open = alice.store.file('Public', 'beach.png')!.hash!;
    const secret = alice.store.file('Private', 'secret.png')!.hash!;

    const bob = await core('bob');
    const hb = (await bob.addHub(h.url, acct('bob'))).hub.id;
    const call = await agentOn(bob);

    const tools = await call('view_thumbnails', {
      hub: hb,
      device: alice.deviceId,
      hashes: [open, secret],
    });
    expect(tools.isError).toBeFalsy();
    const images = tools.content.filter((x) => x.type === 'image');
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ mimeType: 'image/webp' });
    // A real WebP: RIFF....WEBP
    const bytes = Buffer.from((images[0] as { data: string }).data, 'base64');
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString()).toBe('WEBP');
    const text = tools.content
      .filter((x) => x.type === 'text')
      .map((x) => (x as { text: string }).text)
      .join('\n');
    expect(text).toContain(`Thumbnail of ${open}`);
    expect(text).toContain(`No thumbnail`);
    expect(text).toContain(secret);

    // The owner's agent sees its own private files.
    const own = await (
      await agentOn(alice)
    )('view_thumbnails', {
      hub: ha,
      device: alice.deviceId,
      hashes: [secret],
      size: 'large',
    });
    expect(own.content.filter((x) => x.type === 'image')).toHaveLength(1);

    // Limits: two large at a time.
    const tooMany = await call('view_thumbnails', {
      hub: hb,
      device: alice.deviceId,
      hashes: [open, secret, 'ee'.repeat(32)],
      size: 'large',
    });
    expect(tooMany.isError).toBe(true);
  }, 60_000);
});
