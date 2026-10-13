/**
 * First launch (HANDOFF §11, ADR 0014): a new account, this computer added to an existing
 * account with a link code, or a restore from the recovery key.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { hubUrl } from '../format';
import { invalidate } from '../query';
import { Mark } from '../ui/icons';
import { ErrorNote, useAction } from '../ui/kit';

type Mode = 'choose' | 'new' | 'link' | 'restore';

export function Welcome({ deviceId }: { deviceId: string }) {
  const [mode, setMode] = useState<Mode>('choose');
  const [deviceName, setDeviceName] = useState('');
  useEffect(() => {
    void window.communal.defaultDeviceName().then(setDeviceName);
  }, []);
  const back = () => setMode('choose');
  return (
    <div className="welcome">
      <div className="welcome-card">
        <Mark size={44} />
        {mode === 'choose' && (
          <>
            <div style={{ display: 'grid', gap: 8 }}>
              <h1>Welcome to Communal</h1>
              <p className="muted">
                Share folders with people you know, straight from your computer to theirs. Files
                never pass through anyone else’s server.
              </p>
            </div>
            <div style={{ display: 'grid', gap: 10 }}>
              <button className="choice" onClick={() => setMode('new')}>
                <strong>I’m new here</strong>
                <span>Choose a name and join the hub you were invited to.</span>
              </button>
              <button className="choice" onClick={() => setMode('link')}>
                <strong>Add this computer to my account</strong>
                <span>You already use Communal on another computer.</span>
              </button>
              <button className="choice" onClick={() => setMode('restore')}>
                <strong>Restore my account</strong>
                <span>Use the recovery key you saved, if you have no other computer left.</span>
              </button>
            </div>
          </>
        )}
        {mode === 'new' && (
          <NewAccount deviceName={deviceName} setDeviceName={setDeviceName} back={back} />
        )}
        {mode === 'link' && (
          <LinkDevice
            deviceName={deviceName}
            setDeviceName={setDeviceName}
            deviceId={deviceId}
            back={back}
          />
        )}
        {mode === 'restore' && (
          <Restore deviceName={deviceName} setDeviceName={setDeviceName} back={back} />
        )}
      </div>
    </div>
  );
}

interface StepProps {
  deviceName: string;
  setDeviceName: (s: string) => void;
  back: () => void;
}

function Step({
  title,
  lede,
  children,
  back,
}: {
  title: string;
  lede: ReactNode;
  children: ReactNode;
  back: () => void;
}) {
  return (
    <>
      <div style={{ display: 'grid', gap: 8 }}>
        <h1>{title}</h1>
        <p className="muted">{lede}</p>
      </div>
      {children}
      <div>
        <button className="btn quiet" onClick={back}>
          Back
        </button>
      </div>
    </>
  );
}

function HubField({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <label className="field">
      <span>Hub address</span>
      <input
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="hub.example.com"
        autoCapitalize="off"
        spellCheck={false}
        required
      />
      <small>The person who invited you gives you this.</small>
    </label>
  );
}

function DeviceField({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <label className="field">
      <span>Name for this computer</span>
      <input
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={64}
        required
      />
      <small>Shown to you when you manage your computers, and to people downloading from it.</small>
    </label>
  );
}

const done = () => invalidate(['hubs', 'devices', 'people', 'presence']);

function NewAccount({ deviceName, setDeviceName, back }: StepProps) {
  const [name, setName] = useState('');
  const [hub, setHub] = useState('');
  const [pending, setPending] = useState(false);
  const join = useAction(async () => {
    const r = await api.post<{ status: 'ready' | 'pending_approval' }>('/v1/hubs', {
      url: hubUrl(hub),
      display_name: name.trim(),
      device_name: deviceName.trim(),
    });
    if (r.status === 'pending_approval') setPending(true);
    else done();
  });
  if (pending)
    return (
      <Step title="Almost there" lede="This hub’s admin approves new people by hand." back={done}>
        <div className="notice">
          You’ll be able to search and share as soon as they let you in. You can set up your shared
          folders in the meantime.
        </div>
        <button className="btn primary big" onClick={done}>
          Continue
        </button>
      </Step>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void join.run();
  };
  return (
    <Step
      title="Join a hub"
      lede="Choose the name people will know you by. There’s no password and no email."
      back={back}
    >
      <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
        <label className="field">
          <span>Your name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            required
            autoFocus
          />
        </label>
        <HubField value={hub} onChange={setHub} />
        <DeviceField value={deviceName} onChange={setDeviceName} />
        <ErrorNote error={join.error} />
        <div>
          <button className="btn primary big" disabled={join.busy}>
            {join.busy ? 'Joining…' : 'Join'}
          </button>
        </div>
      </form>
    </Step>
  );
}

function LinkDevice({
  deviceName,
  setDeviceName,
  deviceId,
  back,
}: StepProps & { deviceId: string }) {
  const [hub, setHub] = useState('');
  const [code, setCode] = useState('');
  const link = useAction(
    () =>
      api.post('/v1/account/link', {
        url: hubUrl(hub),
        code: code.trim(),
        device_name: deviceName.trim(),
      }),
    { onDone: done },
  );
  return (
    <Step
      title="Add this computer"
      lede={
        <>
          On a computer that already uses Communal, open <b>Settings → Devices</b> and choose{' '}
          <b>Add a computer</b>. It shows a code to type here.
        </>
      }
      back={back}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void link.run();
        }}
        style={{ display: 'grid', gap: 16 }}
      >
        <label className="field">
          <span>Code</span>
          <input
            className="input mono"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD-1234"
            style={{ fontSize: 20, letterSpacing: '0.1em' }}
            required
            autoFocus
          />
        </label>
        <HubField value={hub} onChange={setHub} />
        <DeviceField value={deviceName} onChange={setDeviceName} />
        <ErrorNote error={link.error} />
        {link.busy ? (
          <div className="notice">
            <strong>Approve this computer on your other one.</strong>
            <span>
              Check that the request it shows comes from <b>{deviceName}</b> with this device ID:
            </span>
            <span className="mono">{deviceId}</span>
          </div>
        ) : (
          <div>
            <button className="btn primary big">Send request</button>
          </div>
        )}
      </form>
    </Step>
  );
}

function Restore({ deviceName, setDeviceName, back }: StepProps) {
  const [how, setHow] = useState<'file' | 'words'>('file');
  const [file, setFile] = useState<unknown>(null);
  const [passphrase, setPassphrase] = useState('');
  const [words, setWords] = useState('');
  const [hub, setHub] = useState('');
  const [fileError, setFileError] = useState<Error | null>(null);
  const restore = useAction(
    () =>
      api.post('/v1/account/restore', {
        ...(how === 'file' ? { file, passphrase } : { words: words.trim() }),
        ...(hub.trim() ? { hubs: [{ url: hubUrl(hub) }] } : {}),
        device_name: deviceName.trim(),
      }),
    { onDone: done },
  );
  const pick = async () => {
    setFileError(null);
    const text = await window.communal.pickTextFile('Recovery key', ['json', 'communal-recovery']);
    if (text === null) return;
    try {
      setFile(JSON.parse(text));
    } catch {
      setFileError(new Error('That file isn’t a Communal recovery key.'));
    }
  };
  return (
    <Step
      title="Restore your account"
      lede="Your shares, connections and access rules come back once this computer joins your hubs again."
      back={back}
    >
      <div className="segmented" role="group" aria-label="Recovery key type">
        <button aria-pressed={how === 'file'} onClick={() => setHow('file')}>
          Recovery file
        </button>
        <button aria-pressed={how === 'words'} onClick={() => setHow('words')}>
          Recovery words
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void restore.run();
        }}
        style={{ display: 'grid', gap: 16 }}
      >
        {how === 'file' ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button type="button" className="btn" onClick={() => void pick()}>
                Choose file…
              </button>
              <span className="muted">{file ? 'Recovery file loaded' : 'No file chosen'}</span>
            </div>
            <ErrorNote error={fileError} />
            <label className="field">
              <span>Passphrase</span>
              <input
                className="input"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                required
              />
            </label>
          </>
        ) : (
          <label className="field">
            <span>Recovery words</span>
            <textarea
              className="input"
              rows={4}
              value={words}
              onChange={(e) => setWords(e.target.value)}
              spellCheck={false}
              required
            />
            <small>In order, separated by spaces.</small>
          </label>
        )}
        <label className="field">
          <span>Hub address {how === 'file' && <span className="faint">(optional)</span>}</span>
          <input
            className="input"
            value={hub}
            onChange={(e) => setHub(e.target.value)}
            placeholder="hub.example.com"
            required={how === 'words'}
          />
          {how === 'file' && (
            <small>The file already lists the hubs you were on when you saved it.</small>
          )}
        </label>
        <DeviceField value={deviceName} onChange={setDeviceName} />
        <ErrorNote error={restore.error} />
        <div>
          <button className="btn primary big" disabled={restore.busy || (how === 'file' && !file)}>
            {restore.busy ? 'Restoring…' : 'Restore'}
          </button>
        </div>
      </form>
    </Step>
  );
}
