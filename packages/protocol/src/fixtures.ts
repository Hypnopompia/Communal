/**
 * One valid sample body per message type. Used by the round-trip tests (which also assert
 * that every type has a fixture) and handy for hub/client tests later.
 */
import type { ClientBody, ClientType, HubBody, HubType } from './hub.js';

const pk = 'A'.repeat(43);
const sig = 'B'.repeat(86);
const uid = 'u_' + 'a'.repeat(26);
const uid2 = 'u_' + 'b'.repeat(26);
const did = 'd_' + 'c'.repeat(26);
const did2 = 'd_' + 'd'.repeat(26);
const fp = 'e'.repeat(52);
const hash = '0f'.repeat(32);
const gid = 'g_01J9Z3QX7M8N4P5R6S7T8V9W0X';
const sid = 'x_01J9Z3QX7M8N4P5R6S7T8V9W0X';
const user = { user_id: uid2, display_name: 'bob', fingerprint: fp, root_pubkey: pk };
const cert = { user_id: uid, device_pubkey: pk, issued_at: 1_700_000_000, signer_pubkey: pk, sig };
const revocation = {
  user_id: uid,
  device_id: did2,
  revoked_at: 1_700_000_000,
  signer_pubkey: pk,
  sig,
};
const proof = { revocation, chain: [cert] };
const entry = {
  path: 'Movies/Alien (1979).mkv',
  size: 4_831_838_208,
  mtime: 1_696_118_400,
  mime: 'video/x-matroska',
  kind: 'video' as const,
  meta: { duration: 7020, width: 1920, height: 1080 },
  thumb: true,
  hash: null,
};
const obs = { nat: 'symmetric' as const, upnp: false, ipv6: false, cgnat: false };
const candidates = [
  { kind: 'lan' as const, host: '192.168.1.20', port: 41641 },
  { kind: 'advertised' as const, host: '127.0.0.1', port: 41641 },
];
const token = { claims: { session_id: sid, from: did, to: did2, hash, exp: 1_700_000_300 }, sig };
const client = { name: 'communal-cli', version: '0.0.0' };
const source = {
  device_id: did2,
  owner: uid2,
  path: 'Movies/Alien (1979).mkv',
  online: true,
  seen: 'now' as const,
};

export const clientFixtures: { [T in ClientType]: ClientBody<T> } = {
  auth: { device_id: did, sig, client },
  'account.create': {
    display_name: 'alice',
    device_name: 'laptop',
    device_pubkey: pk,
    platform: 'darwin',
    client,
    sig,
  },
  'link.code.create': {},
  'link.claim': {
    code: 'K7Q2-9XZD',
    device_name: 'nas',
    device_pubkey: pk,
    platform: 'linux',
    sig,
  },
  'link.approve': { request_id: 'lr_1', cert, sealed: 'C'.repeat(120) },
  'link.deny': { request_id: 'lr_1' },
  'account.restore': {
    root_pubkey: pk,
    device_pubkey: pk,
    device_name: 'new laptop',
    platform: 'win32',
    issued_at: 1_700_000_000,
    root_sig: sig,
    sig,
  },
  'device.revoke': proof,
  'device.list': {},
  'network.profile': {
    nat: 'endpoint_independent',
    upnp: true,
    ipv6: false,
    cgnat: false,
    lan_addrs: ['192.168.1.20'],
  },
  'user.search': { q: 'bob', limit: 20 },
  'connection.request': { user_id: uid2 },
  'connection.accept': { user_id: uid2 },
  'connection.remove': { user_id: uid2 },
  'connection.list': {},
  'group.upsert': { name: 'Family', members: [uid2] },
  'group.delete': { group_id: gid },
  'group.list': {},
  'acl.set': { device_id: did, path: 'Photos/2024/', audience: { users: [uid2], groups: [gid] } },
  'acl.replace': { device_id: did, rules: [{ path: 'Photos/', audience: 'hub' }] },
  'index.snapshot': { rev: 3, page: 0, last: true, entries: [entry] },
  'index.delta': { base_rev: 3, rev: 4, upsert: [{ ...entry, hash }], remove: ['Movies/old.mkv'] },
  library: {},
  search: { q: 'alien', kind: 'video', min_size: 1_000_000, available: 'week', limit: 50 },
  browse: { device_id: did2, path: 'Movies/' },
  'browse.follow': { device_id: did2 },
  sources: { hash },
  watch: { device_id: did2, path: 'Photos/', recursive: true, mirror_deletes: false, since_rev: 0 },
  unwatch: { device_id: did2, path: 'Photos/' },
  'connect.request': { target: did2, hash, session_id: sid, stream_id: 7, candidates },
  'connect.answer': { session_id: sid, stream_id: 9, candidates },
  'connect.failed': {
    session_id: sid,
    observations: { ...obs, attempts: 12, udp_sent: true, udp_received: false },
  },
  ping: {},
  pong: {},
  error: { code: 'forbidden', message: 'nope' },
};

export const hubFixtures: { [T in HubType]: HubBody<T> } = {
  challenge: { nonce: 'n'.repeat(43), hub_id: 'hub.example', hub_pubkey: pk },
  welcome: {
    session: 's_1',
    user_id: uid,
    device_id: did,
    observed_addr: '203.0.113.5:51234',
    index_rev: 4,
    nat_probe_ports: [3478, 3479],
  },
  'account.created': { user_id: uid, device_id: did, fingerprint: fp, status: 'active' },
  'link.code': { code: 'K7Q2-9XZD', expires_in: 600 },
  'link.request': { request_id: 'lr_1', device_name: 'nas', platform: 'linux', device_pubkey: pk },
  'link.done': { user_id: uid, device_id: did2, chain: [cert], sealed: 'C'.repeat(120) },
  'link.denied': {},
  'device.listing': {
    devices: [
      {
        device_id: did,
        name: 'laptop',
        platform: 'darwin',
        online: true,
        last_seen: null,
        revoked_at: null,
        root: true,
      },
    ],
  },
  'device.revoked': proof,
  'user.results': { users: [user] },
  'connection.request': { user },
  'connection.accept': { user },
  'connection.remove': { user_id: uid2 },
  'connection.listing': { connections: [{ user, state: 'pending_in', since: 1_700_000_000 }] },
  'group.listing': { groups: [{ group_id: gid, name: 'Family', members: [uid2] }] },
  'index.ack': { rev: 4 },
  'index.resync': { reason: 'rev_mismatch' },
  'search.results': {
    hits: [
      {
        hash,
        name: 'Alien (1979).mkv',
        size: 4_831_838_208,
        mime: 'video/x-matroska',
        kind: 'video',
        meta: { duration: 7020 },
        thumb: true,
        sources: [source],
      },
    ],
    cursor: 'c1',
  },
  'browse.listing': { online: true, dirs: [{ name: '2024' }], files: [entry] },
  'browse.changed': { device_id: did2 },
  'library.changed': {},
  'sources.list': { hash, sources: [source] },
  'library.listing': {
    devices: [{ device_id: did2, device_name: 'bob-laptop', user, online: false, seen: 'week' }],
  },
  'watch.event': { device_id: did2, path: 'Photos/', rev: 9, added: [entry], removed: [] },
  presence: { device_id: did2, user_id: uid2, online: false },
  'connect.offer': {
    session_id: sid,
    from: did,
    from_user: uid,
    from_root_pubkey: pk,
    from_chain: [],
    from_revocations: [proof],
    token,
    stream_id: 7,
    candidates,
  },
  'connect.answer': {
    session_id: sid,
    stream_id: 9,
    candidates,
    to_user: uid2,
    to_root_pubkey: pk,
    to_chain: [],
    to_revocations: [],
    token,
  },
  'connect.failed': {
    session_id: sid,
    cause: 'both_restrictive_nat',
    easier_fix: 'them',
    you: obs,
    them: { ...obs, upnp: true },
  },
  ok: {},
  ping: {},
  pong: {},
  error: { code: 'upgrade_required', message: 'please update' },
};
