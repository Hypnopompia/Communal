#!/usr/bin/env node
/**
 * `communal-hub` — runs the hub (`serve`, the default) and offers admin commands that work on
 * the same SQLite database (HANDOFF §10: users, approve, set join_mode).
 */
import { join } from 'node:path';
import { Command } from 'commander';
import { pino } from 'pino';
import { HubDb } from './db.js';
import { isDevBuild, loadOrCreateHubKey, resolveTls } from './config.js';
import { HubServer } from './server.js';

const dataDir = process.env.COMMUNAL_HUB_DATA ?? './hub-data';
const openDb = () => new HubDb(join(dataDir, 'hub.db'));
const log = pino({ name: 'hub', level: process.env.LOG_LEVEL ?? 'info' });

const program = new Command().name('communal-hub').description('Communal hub server and admin');

program
  .command('serve', { isDefault: true })
  .description('run the hub')
  .action(async () => {
    const { key, created } = loadOrCreateHubKey(dataDir);
    if (created) log.info('generated new hub key');
    const db = openDb();
    // Env seeds join_mode only on first start; afterwards `communal-hub set join_mode` owns it.
    const envMode = process.env.COMMUNAL_JOIN_MODE;
    if (
      db.getSetting('join_mode') === undefined &&
      (envMode === 'open' || envMode === 'approval')
    ) {
      db.setSetting('join_mode', envMode);
    }
    const hub = new HubServer({
      db,
      hubKey: key,
      hubId: process.env.COMMUNAL_HUB_ID ?? 'communal-hub',
      tls: await resolveTls(dataDir),
      probePorts: [
        Number(process.env.COMMUNAL_PROBE_PORT_A ?? 3478),
        Number(process.env.COMMUNAL_PROBE_PORT_B ?? 3479),
      ],
      log,
    });
    if (isDevBuild()) log.warn('dev build: dev-only conveniences are enabled');
    await hub.listen(Number(process.env.COMMUNAL_HUB_PORT ?? 8443));
    const shutdown = async () => {
      log.info('shutting down');
      await hub.close();
      db.close();
      process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });

program
  .command('users')
  .description('list accounts')
  .option('--json', 'machine-readable output')
  .action((opts: { json?: boolean }) => {
    const db = openDb();
    const users = db.listUsers();
    if (opts.json) {
      console.log(JSON.stringify(users, null, 2));
    } else if (users.length === 0) {
      console.log('no users');
    } else {
      for (const u of users) {
        const when = new Date(u.created_at * 1000).toISOString().slice(0, 16).replace('T', ' ');
        const status = u.banned_at !== null ? 'banned' : u.status;
        const reason = u.ban_reason ? `  (${u.ban_reason})` : '';
        console.log(
          `${u.id}  ${status.padEnd(7)}  ${String(u.devices).padStart(2)} dev  ${when}  ${u.display_name}${reason}`,
        );
      }
    }
    db.close();
  });

program
  .command('approve <user_id>')
  .description('approve a pending account')
  .action((id: string) => {
    const db = openDb();
    const user = db.getUser(id);
    if (!user) {
      console.error(`no such user: ${id}`);
      process.exitCode = 1;
    } else if (user.status === 'active') {
      console.log(`${id} is already active`);
    } else {
      db.setUserStatus(id, 'active');
      console.log(`approved ${id} (${user.display_name})`);
    }
    db.close();
  });

program
  .command('ban <user_id>')
  .description('ban an account: signs out its devices and blocks sign-in')
  .option('--reason <text>', 'note shown in `users` (not sent to the user)')
  .action((id: string, opts: { reason?: string }) => {
    const db = openDb();
    const user = db.getUser(id);
    if (!user) {
      console.error(`no such user: ${id}`);
      process.exitCode = 1;
    } else {
      db.ban(id, opts.reason ?? null);
      console.log(`banned ${id} (${user.display_name}); live sessions end within a few seconds`);
    }
    db.close();
  });

program
  .command('unban <user_id>')
  .description('lift a ban (the user restarts their app to sign back in)')
  .action((id: string) => {
    const db = openDb();
    const user = db.getUser(id);
    if (!user) {
      console.error(`no such user: ${id}`);
      process.exitCode = 1;
    } else if (user.banned_at === null) {
      console.log(`${id} is not banned`);
    } else {
      db.unban(id);
      console.log(`unbanned ${id} (${user.display_name})`);
    }
    db.close();
  });

program
  .command('set <key> <value>')
  .description('change a hub setting: join_mode open|approval, or name "<what people see>"')
  .action((key: string, raw: string) => {
    const value = raw.trim();
    const ok =
      key === 'join_mode'
        ? value === 'open' || value === 'approval'
        : key === 'name' && value.length >= 1 && value.length <= 64;
    if (!ok) {
      console.error('supported: set join_mode open|approval, set name "<1 to 64 characters>"');
      process.exitCode = 2;
      return;
    }
    const db = openDb();
    db.setSetting(key, value);
    console.log(`${key} = ${value}`);
    db.close();
  });

program
  .command('get [key]')
  .description('show hub settings')
  .action((key?: string) => {
    const db = openDb();
    if (key) console.log(db.getSetting(key) ?? '(unset)');
    else {
      console.log(`join_mode = ${db.joinMode}`);
      console.log(`name = ${db.hubName ?? '(unset: clients show the host name)'}`);
    }
    db.close();
  });

await program.parseAsync();
