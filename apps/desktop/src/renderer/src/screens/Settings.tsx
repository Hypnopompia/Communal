/**
 * Settings (HANDOFF §11): account and recovery key, devices, hubs (ADR 0007: a list, not one
 * address), network check, bandwidth and storage.
 */
import { useEffect, useState } from 'react';
import type { AgentsState } from '../../../shared/bridge';
import { api, type Device, type LinkRequest, type NetworkSummary, type UploadLimits } from '../api';
import { ago, hubName, size } from '../format';
import { hubUrl } from '../format';
import { useHubs, useStatus } from '../hubs';
import { useNav, type SettingsTab } from '../nav';
import { useApi } from '../query';
import { Icon } from '../ui/icons';
import { Dialog, ErrorNote, useAction } from '../ui/kit';

const TABS: { tab: SettingsTab; label: string }[] = [
  { tab: 'account', label: 'Account' },
  { tab: 'devices', label: 'Devices' },
  { tab: 'hubs', label: 'Hubs' },
  { tab: 'network', label: 'Network' },
  { tab: 'bandwidth', label: 'Sharing speed' },
  { tab: 'storage', label: 'Storage' },
  { tab: 'agents', label: 'AI agents' },
];

export function Settings({ tab }: { tab: SettingsTab }) {
  const go = useNav();
  const links = useApi<{ requests: LinkRequest[] }>(['devices'], '/v1/link/requests');
  const pending = links.data?.requests.length ?? 0;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <div
        className="segmented"
        role="tablist"
        aria-label="Settings"
        style={{ justifySelf: 'start', flexWrap: 'wrap' }}
      >
        {TABS.map((t) => (
          <button
            key={t.tab}
            role="tab"
            aria-pressed={t.tab === tab}
            aria-selected={t.tab === tab}
            onClick={() => go({ screen: 'settings', tab: t.tab })}
          >
            {t.label}
            {t.tab === 'devices' && pending > 0 ? ` (${pending})` : ''}
          </button>
        ))}
      </div>
      {tab === 'account' && <Account />}
      {tab === 'devices' && <Devices />}
      {tab === 'hubs' && <Hubs />}
      {tab === 'network' && <Network />}
      {tab === 'bandwidth' && <Bandwidth />}
      {tab === 'storage' && <Storage />}
      {tab === 'agents' && <Agents />}
    </div>
  );
}

// ── account ──

function Account() {
  const status = useStatus().data;
  const devices = useApi<{ devices: Device[] }>(['devices'], '/v1/devices');
  const [exporting, setExporting] = useState(false);
  const a = status?.account;
  if (!a) return null;
  const first = devices.data?.devices.find((d) => d.root);
  return (
    <>
      <div className="panel panel-pad section">
        <h2>Your account</h2>
        <dl className="kv">
          <dt>Fingerprint</dt>
          <dd className="mono">{a.fingerprint ?? 'Not set up yet'}</dd>
          <dt>This computer</dt>
          <dd className="mono">{a.device_id}</dd>
        </dl>
        <p className="faint small">
          People who verify you compare a code made from this fingerprint. It stays the same on
          every hub and every one of your computers.
        </p>
      </div>
      <div className="panel panel-pad section">
        <h2>Recovery key</h2>
        <p className="muted">
          If you lose every computer you use Communal on, the recovery key brings your account back.
          Keep it somewhere safe and private: whoever has it can use your account.
        </p>
        {a.holds_root_key ? (
          <div>
            <button className="btn primary" onClick={() => setExporting(true)}>
              Save recovery key…
            </button>
          </div>
        ) : (
          <div className="notice">
            Only your first computer{first ? ` (${first.name})` : ''} can save the recovery key.
            Open Communal there and go to Settings › Account.
          </div>
        )}
      </div>
      {exporting && <ExportRecovery onClose={() => setExporting(false)} />}
    </>
  );
}

function ExportRecovery({ onClose }: { onClose: () => void }) {
  const [how, setHow] = useState<'file' | 'words'>('file');
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [words, setWords] = useState<string[] | null>(null);
  const run = useAction(async () => {
    if (how === 'words') {
      const r = await api.post<{ words: string[] }>('/v1/recovery', { format: 'words' });
      setWords(r.words);
      return;
    }
    const r = await api.post<{ file: unknown }>('/v1/recovery', {
      format: 'file',
      passphrase: pass,
    });
    const saved = await window.communal.saveTextFile(
      'Save recovery key',
      'communal-recovery.json',
      JSON.stringify(r.file, null, 2),
    );
    if (saved) onClose();
  });
  if (words)
    return (
      <Dialog title="Your recovery words" onClose={onClose}>
        <p className="muted">
          Write these down in order and keep them somewhere safe. Anyone with them can use your
          account.
        </p>
        <ol style={{ columns: 3, margin: 0, paddingLeft: 24, fontWeight: 600, lineHeight: 1.9 }}>
          {words.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ol>
        <div className="dialog-actions">
          <button className="btn primary" onClick={onClose}>
            I’ve written them down
          </button>
        </div>
      </Dialog>
    );
  const mismatch = how === 'file' && again.length > 0 && pass !== again;
  return (
    <Dialog title="Save your recovery key" onClose={onClose}>
      <div className="segmented" role="group" aria-label="Format" style={{ justifySelf: 'start' }}>
        <button aria-pressed={how === 'file'} onClick={() => setHow('file')}>
          A file with a passphrase
        </button>
        <button aria-pressed={how === 'words'} onClick={() => setHow('words')}>
          Words to write down
        </button>
      </div>
      {how === 'file' ? (
        <>
          <label className="field">
            <span>Passphrase</span>
            <input
              className="input"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              minLength={8}
            />
            <small>At least 8 characters. You’ll need it to restore; it can’t be reset.</small>
          </label>
          <label className="field">
            <span>Passphrase again</span>
            <input
              className="input"
              type="password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          </label>
          {mismatch && (
            <span className="small" style={{ color: 'var(--danger)' }}>
              The passphrases don’t match.
            </span>
          )}
        </>
      ) : (
        <p className="muted">
          You’ll see 24 words. Anyone who has them can use your account, so don’t store them on this
          computer.
        </p>
      )}
      <ErrorNote error={run.error} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={run.busy || (how === 'file' && (pass.length < 8 || pass !== again))}
          onClick={() => void run.run()}
        >
          {how === 'file' ? 'Save file…' : 'Show words'}
        </button>
      </div>
    </Dialog>
  );
}

// ── devices ──

function Devices() {
  const devices = useApi<{ devices: Device[] }>(['devices', 'presence'], '/v1/devices');
  const requests = useApi<{ requests: LinkRequest[] }>(['devices'], '/v1/link/requests', {
    refetchInterval: 5_000,
  });
  const [code, setCode] = useState<{ code: string; expires_in: number; at: number } | null>(null);
  const [revoking, setRevoking] = useState<Device | null>(null);
  const create = useAction(
    () => api.post<{ code: string; expires_in: number }>('/v1/link/codes', {}),
    {
      onDone: (r) => setCode({ ...r, at: Date.now() }),
    },
  );
  const decide = useAction(
    (id: string, approve: boolean) =>
      api.post(`/v1/link/requests/${id}/${approve ? 'approve' : 'deny'}`, {}),
    {
      topics: ['devices'],
      done: (_r) => 'Done',
    },
  );
  const revoke = useAction((id: string) => api.post(`/v1/devices/${id}/revoke`, {}), {
    topics: ['devices'],
    done: 'Computer removed',
    onDone: () => setRevoking(null),
  });
  const { name: hubLabel } = useHubs();
  return (
    <>
      {(requests.data?.requests.length ?? 0) > 0 && (
        <div className="panel panel-pad section" style={{ borderColor: 'var(--accent)' }}>
          <h2>A computer wants to join your account</h2>
          {requests.data!.requests.map((r) => (
            <div key={r.request_id} style={{ display: 'grid', gap: 10 }}>
              <p>
                <b>{r.device_name}</b> asked {ago(r.at)} through {hubLabel(r.hub)}. Check that the
                new computer shows this same ID before you approve:
              </p>
              <div className="code-big mono" style={{ fontSize: 16 }}>
                {r.device_id}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn primary" onClick={() => void decide.run(r.request_id, true)}>
                  Approve
                </button>
                <button className="btn" onClick={() => void decide.run(r.request_id, false)}>
                  Deny
                </button>
              </div>
            </div>
          ))}
          <ErrorNote error={decide.error} />
        </div>
      )}

      <div className="panel panel-pad section">
        <div className="section-head">
          <h2>Add a computer</h2>
        </div>
        <p className="muted">
          On the new computer, install Communal and choose “Add this computer to my account”, then
          type this code. You’ll approve it here.
        </p>
        {code ? (
          <LinkCode code={code} onExpired={() => setCode(null)} />
        ) : (
          <div>
            <button
              className="btn primary"
              disabled={create.busy}
              onClick={() => void create.run()}
            >
              Get a code
            </button>
          </div>
        )}
        <ErrorNote error={create.error} />
      </div>

      <section className="section">
        <h2>Your computers</h2>
        <ErrorNote error={devices.error ?? revoke.error} />
        <div className="panel rows">
          {devices.data?.devices.map((d) => {
            const online = d.hubs.some((h) => h.online);
            const seen = Math.max(0, ...d.hubs.map((h) => h.last_seen ?? 0));
            return (
              <div key={d.device_id} className="row">
                <Icon name="device" size={22} />
                <div className="grow">
                  <div className="title">
                    {d.name}
                    {d.this_device && (
                      <span className="tag accent" style={{ marginLeft: 8 }}>
                        This computer
                      </span>
                    )}
                    {d.root && (
                      <span className="tag" style={{ marginLeft: 8 }}>
                        First computer
                      </span>
                    )}
                  </div>
                  <div className="sub mono">{d.device_id}</div>
                </div>
                <div className="end">
                  {d.revoked ? (
                    <span className="status bad">Removed</span>
                  ) : (
                    <span className={`status${online ? ' on' : ''}`}>
                      {online ? 'Online' : seen ? `Seen ${ago(seen)}` : 'Offline'}
                    </span>
                  )}
                  {!d.root && !d.this_device && !d.revoked && (
                    <button className="btn small quiet" onClick={() => setRevoking(d)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
      {revoking && (
        <Dialog title={`Remove ${revoking.name}?`} onClose={() => setRevoking(null)}>
          <p className="muted">
            It’s signed out of every hub at once and other people’s computers stop trusting it. Do
            this if it was lost or stolen. It can’t be undone; you’d add it again as a new computer.
          </p>
          <ErrorNote error={revoke.error} />
          <div className="dialog-actions">
            <button className="btn" onClick={() => setRevoking(null)}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void revoke.run(revoking.device_id)}>
              Remove computer
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function LinkCode({
  code,
  onExpired,
}: {
  code: { code: string; expires_in: number; at: number };
  onExpired: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round(code.expires_in - (now - code.at) / 1000));
  useEffect(() => {
    if (left === 0) onExpired();
  }, [left, onExpired]);
  return (
    <div style={{ display: 'grid', gap: 6, justifyItems: 'start' }}>
      <div className="code-big">{code.code}</div>
      <span className="faint small">
        Works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} more.
      </span>
    </div>
  );
}

// ── hubs ──

function Hubs() {
  const { hubs } = useHubs();
  const status = useStatus().data;
  const [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState<string | null>(null);
  const leave = useAction((id: string) => api.del(`/v1/hubs/${id}`), {
    topics: ['hubs', 'people', 'presence'],
    done: 'Left the hub',
    onDone: () => setLeaving(null),
  });
  return (
    <>
      <p className="muted" style={{ maxWidth: '62ch' }}>
        A hub is where you find people and files. You can be on several; searches cover all of them.
        Files always go directly between computers, never through a hub.
      </p>
      <div className="panel rows">
        {hubs.map((h) => (
          <div key={h.id} className="row" style={{ alignItems: 'flex-start' }}>
            <Icon name="globe" size={22} />
            <div className="grow" style={{ display: 'grid', gap: 4 }}>
              <div className="title">{hubName(h.url)}</div>
              <div className="sub">{h.url}</div>
              {h.problem && (
                <div className="notice warn small">
                  {problemText(h.problem.reason, h.problem.message)}
                </div>
              )}
            </div>
            <div className="end">
              <span className={`status${h.ready ? ' on' : h.problem ? ' warn' : ''}`}>
                {h.ready
                  ? 'Connected'
                  : h.problem?.reason === 'pending_approval'
                    ? 'Waiting for approval'
                    : h.problem
                      ? 'Not connected'
                      : 'Connecting…'}
              </span>
              <button className="btn small quiet" onClick={() => setLeaving(h.id)}>
                Leave
              </button>
            </div>
          </div>
        ))}
      </div>
      <div>
        <button className="btn" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> Join another hub
        </button>
      </div>
      <ErrorNote error={leave.error} />
      {adding && (
        <JoinHub onClose={() => setAdding(false)} hasShares={(status?.shares.length ?? 0) > 0} />
      )}
      {leaving && (
        <Dialog
          title={`Leave ${hubName(hubs.find((h) => h.id === leaving)?.url ?? '')}?`}
          onClose={() => setLeaving(null)}
        >
          <p className="muted">
            This computer stops listing your shares there and you won’t see its people. Your
            subscriptions to folders on that hub stop too.
          </p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setLeaving(null)}>
              Stay
            </button>
            <button className="btn primary" onClick={() => void leave.run(leaving)}>
              Leave hub
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function problemText(reason: string, message: string): string {
  switch (reason) {
    case 'pending_approval':
      return 'The hub’s admin hasn’t let you in yet.';
    case 'banned':
      return 'The hub’s admin has blocked this account.';
    case 'hub_key_mismatch':
      return 'This hub’s identity has changed since you joined. It may have been replaced by an impostor, so Communal won’t connect. Ask the hub’s admin.';
    case 'link_denied':
      return 'The request to add this computer was denied.';
    default:
      return message;
  }
}

function JoinHub({ onClose, hasShares }: { onClose: () => void; hasShares: boolean }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [device, setDevice] = useState('');
  useEffect(() => {
    void window.communal.defaultDeviceName().then(setDevice);
  }, []);
  const join = useAction(
    () =>
      api.post<{ status: string }>('/v1/hubs', {
        url: hubUrl(url),
        display_name: name.trim(),
        device_name: device.trim(),
      }),
    {
      topics: ['hubs', 'people', 'presence'],
      done: (r) => (r.status === 'ready' ? 'Joined' : 'Waiting for the hub’s admin to let you in'),
      onDone: onClose,
    },
  );
  return (
    <Dialog title="Join another hub" onClose={onClose}>
      <label className="field">
        <span>Hub address</span>
        <input
          className="input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="hub.example.com"
          autoFocus
        />
      </label>
      <label className="field">
        <span>Your name there</span>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
        />
      </label>
      <label className="field">
        <span>Name for this computer</span>
        <input
          className="input"
          value={device}
          onChange={(e) => setDevice(e.target.value)}
          maxLength={64}
        />
      </label>
      {hasShares && (
        <p className="faint small">
          Your existing shares aren’t listed on the new hub until you choose so in My shares.
        </p>
      )}
      <ErrorNote error={join.error} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!url.trim() || !name.trim() || !device.trim() || join.busy}
          onClick={() => void join.run()}
        >
          {join.busy ? 'Joining…' : 'Join'}
        </button>
      </div>
    </Dialog>
  );
}

// ── network ──

const NAT_TEXT: Record<string, { label: string; good: boolean; detail: string }> = {
  none: {
    label: 'Direct connection',
    good: true,
    detail: 'This computer can be reached directly. Downloads should always work.',
  },
  endpoint_independent: {
    label: 'Works well',
    good: true,
    detail: 'Your router lets other computers reach this one once it reaches out first.',
  },
  symmetric: {
    label: 'Limited',
    good: false,
    detail:
      'Your router makes direct connections hard. Downloads from people on similar networks may fail. Turning on UPnP on your router usually fixes it.',
  },
  blocked: {
    label: 'Blocked',
    good: false,
    detail:
      'Your network blocks the kind of traffic Communal uses. Try another network, or ask whoever runs this one.',
  },
  unknown: {
    label: 'Couldn’t tell',
    good: false,
    detail: 'The hub didn’t answer the check. Downloads may still work; try again later.',
  },
};

function Network() {
  const net = useApi<NetworkSummary>(['hubs'], '/v1/network');
  const { name } = useHubs();
  const check = useAction(() => api.post<NetworkSummary>('/v1/network/check', {}), {
    topics: ['hubs'],
    done: 'Network checked',
  });
  const data = check.busy ? undefined : net.data;
  return (
    <>
      <div className="panel panel-pad section">
        <div className="section-head" style={{ alignItems: 'center' }}>
          <h2 style={{ flex: 1 }}>Connection check</h2>
          <button className="btn" disabled={check.busy} onClick={() => void check.run()}>
            {check.busy ? 'Checking…' : 'Check again'}
          </button>
        </div>
        <ErrorNote error={net.error ?? check.error} />
        {data && Object.keys(data.hubs).length === 0 && (
          <p className="muted">Not connected to a hub yet, so nothing to check against.</p>
        )}
        {data &&
          Object.entries(data.hubs).map(([hub, h]) => {
            const t = NAT_TEXT[h.profile.nat] ?? NAT_TEXT.unknown!;
            return (
              <div key={hub} style={{ display: 'grid', gap: 4 }}>
                <span className={`status ${t.good ? 'on' : 'warn'}`}>
                  {t.label}
                  {Object.keys(data.hubs).length > 1 ? `, seen from ${name(hub)}` : ''}
                </span>
                <p className="muted">{t.detail}</p>
                {h.profile.cgnat && (
                  <p className="muted">
                    Your internet provider shares one public address among many customers. That can
                    stop people reaching you; your provider can usually give you your own address.
                  </p>
                )}
              </div>
            );
          })}
      </div>
      {data && (
        <div className="panel panel-pad section">
          <h2>Details</h2>
          <dl className="kv">
            <dt>Port</dt>
            <dd>{data.port} (UDP)</dd>
            <dt>Router</dt>
            <dd>
              {data.mapping
                ? `Opened port ${data.mapping.port} automatically (${data.mapping.method === 'pmp' ? 'NAT-PMP' : 'UPnP'})`
                : 'Couldn’t open a port automatically. Downloads can still work.'}
            </dd>
            <dt>IPv6</dt>
            <dd>
              {Object.values(data.hubs).some((h) => h.profile.ipv6) ? 'Available' : 'Not available'}
            </dd>
          </dl>
        </div>
      )}
    </>
  );
}

// ── bandwidth ──

function Bandwidth() {
  const limits = useApi<UploadLimits>([], '/v1/settings/uploads');
  const [kbps, setKbps] = useState('');
  const [max, setMax] = useState('');
  useEffect(() => {
    if (!limits.data) return;
    setKbps(
      limits.data.bytesPerSecond ? String(Math.round(limits.data.bytesPerSecond / 1000)) : '',
    );
    setMax(String(limits.data.maxConcurrent));
  }, [limits.data]);
  const save = useAction(
    (b: Partial<UploadLimits>) => api.put<UploadLimits>('/v1/settings/uploads', b),
    { done: 'Saved', onDone: () => void limits.refetch() },
  );
  if (!limits.data) return <ErrorNote error={limits.error} />;
  return (
    <div className="panel panel-pad section" style={{ maxWidth: 560 }}>
      <h2>Sharing with others</h2>
      <p className="muted">
        Limits how much this computer sends, so sharing doesn’t slow down your internet.
      </p>
      <label className="field">
        <span>Upload speed limit</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="input"
            style={{ width: 140 }}
            inputMode="numeric"
            value={kbps}
            onChange={(e) => setKbps(e.target.value.replace(/\D/g, ''))}
            placeholder="No limit"
          />
          <span className="muted">KB/s</span>
        </div>
        <small>
          {kbps ? `About ${size(Number(kbps) * 1000 * 60)} a minute.` : 'Leave empty for no limit.'}
        </small>
      </label>
      <label className="field">
        <span>People downloading at once</span>
        <input
          className="input"
          style={{ width: 140 }}
          inputMode="numeric"
          value={max}
          onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={limits.data.lanOnly}
          onChange={(e) => void save.run({ lanOnly: e.target.checked })}
        />
        <span>
          <b>Only share with computers on my home network</b>
          <br />
          <span className="muted small">
            People elsewhere still see your files, but can’t download them.
          </span>
        </span>
      </label>
      <ErrorNote error={save.error} />
      <div>
        <button
          className="btn primary"
          disabled={save.busy}
          onClick={() =>
            void save.run({
              bytesPerSecond: Number(kbps || 0) * 1000,
              maxConcurrent: Number(max || 0),
            })
          }
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ── storage ──

const CAPS = [64, 256, 1024, 4096].map((mb) => mb * 1024 * 1024);

function Storage() {
  const st = useApi<{ thumb_cache: { bytes: number; cap: number } }>([], '/v1/settings/storage');
  const set = useAction(
    (cap: number) => api.put('/v1/settings/storage', { thumb_cache_bytes: cap }),
    { onDone: () => void st.refetch() },
  );
  const clear = useAction(() => api.post('/v1/settings/storage/clear', {}), {
    done: 'Previews cleared',
    onDone: () => void st.refetch(),
  });
  if (!st.data) return <ErrorNote error={st.error} />;
  const { bytes, cap } = st.data.thumb_cache;
  return (
    <div className="panel panel-pad section" style={{ maxWidth: 560 }}>
      <h2>Previews of other people’s files</h2>
      <p className="muted">
        Thumbnails you’ve looked at are kept so folders open quickly. They use {size(bytes)} now.
      </p>
      <label className="field">
        <span>Keep up to</span>
        <select
          className="input"
          style={{ width: 'auto' }}
          value={CAPS.includes(cap) ? cap : ''}
          onChange={(e) => void set.run(Number(e.target.value))}
        >
          {!CAPS.includes(cap) && <option value="">{size(cap)}</option>}
          {CAPS.map((c) => (
            <option key={c} value={c}>
              {size(c)}
            </option>
          ))}
        </select>
      </label>
      <ErrorNote error={set.error ?? clear.error} />
      <div>
        <button
          className="btn"
          disabled={clear.busy || bytes === 0}
          onClick={() => void clear.run()}
        >
          Clear previews
        </button>
      </div>
    </div>
  );
}

// ── AI agents (ADR 0017) ──

function Agents() {
  const [state, setState] = useState<AgentsState | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    void window.communal.agents().then(setState);
    return window.communal.onAgents(setState);
  }, []);
  if (!state) return null;
  const copy = (what: string, text: string) =>
    void window.communal.copyText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    });
  return (
    <>
      <div className="panel panel-pad section" style={{ maxWidth: 720 }}>
        <h2>Control from the CLI and AI agents</h2>
        <p className="muted">
          Lets the <span className="mono">communal</span> command and AI assistants such as Claude
          use Communal on this computer while the app is open: search, download, share folders,
          change who can see them, and more. Only programs running as you on this computer can
          connect.
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={state.enabled}
            onChange={(e) => void window.communal.setAgents(e.target.checked).then(setState)}
          />
          <span>
            <b>Allow control from the CLI and AI agents</b>
            <br />
            <span className="muted small">
              {state.enabled
                ? state.socket
                  ? 'On. Agents can connect now.'
                  : state.error
                    ? `Couldn’t start: ${state.error}`
                    : 'Starting…'
                : 'Off. Nothing outside this window can control Communal.'}
            </span>
          </span>
        </label>
        <div className="notice">
          <span>
            Agents can’t see or save your recovery key, add or remove your computers, or mark people
            as verified. Your assistant asks you before it changes anything.
          </span>
        </div>
      </div>
      {state.enabled && (
        <div className="panel panel-pad section" style={{ maxWidth: 720 }}>
          <h2>Connect Claude</h2>
          <p className="muted">Run this once in a terminal to add Communal to Claude Code:</p>
          <pre className="peek" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {state.claudeCode}
          </pre>
          <div>
            <button className="btn" onClick={() => copy('cc', state.claudeCode)}>
              {copied === 'cc' ? 'Copied' : 'Copy command'}
            </button>
          </div>
          <p className="muted">
            For Claude Desktop or another MCP client, add this to its MCP servers settings:
          </p>
          <pre className="peek">{state.json}</pre>
          <div>
            <button className="btn" onClick={() => copy('json', state.json)}>
              {copied === 'json' ? 'Copied' : 'Copy settings'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
