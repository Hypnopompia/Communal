import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  streamUrl,
  thumbUrl,
  type DownloadSettings,
  type Exposure,
  type FolderDownload,
  type Kind,
  type Meta,
  type RemoteDevice,
  type Destination,
} from '../api';
import { useHubs } from '../hubs';
import { remote, RemoteDestinationField, useRemoteTargets, WhereField } from './remote';
import { baseName, date, duration, plural, size } from '../format';
import { useApi } from '../query';
import { Dialog, ErrorNote, useAction, useConfirm } from './kit';
import { FileIcon, FolderIcon, Icon } from './icons';

/**
 * Fetches a batch of thumbnails from one device into the core's cache (one peer request for a
 * whole folder, HANDOFF §9) and says which ones are now there to show.
 */
export function useThumbs(
  hub: string | undefined,
  device: string | undefined,
  hashes: string[],
  big = false,
) {
  const q = useQuery({
    queryKey: ['thumbs', hub, device, big, hashes],
    queryFn: () =>
      api.post<{ thumbs: Record<string, boolean> }>('/v1/thumbs', {
        hub,
        device,
        hashes,
        size: big ? 1600 : 320,
      }),
    enabled: !!hub && !!device && hashes.length > 0,
    staleTime: Infinity,
    retry: false,
  });
  return (hash: string | null) => !!hash && q.data?.thumbs[hash] === true;
}

export function describe(kind: Kind, meta: Meta, bytes: number): string {
  const parts: string[] = [];
  if (meta.width && meta.height) parts.push(`${meta.width}×${meta.height}`);
  if (meta.duration) parts.push(duration(meta.duration));
  if (meta.pages) parts.push(`${meta.pages} pages`);
  if (meta.artist) parts.push(meta.artist);
  if (meta.taken_at && kind === 'image') parts.push(date(meta.taken_at));
  parts.push(size(bytes));
  return parts.join(', ');
}

export interface FileLike {
  name: string;
  hash: string | null;
  size: number;
  kind: Kind;
  mime: string;
  meta: Meta;
  icon: string;
}

export function FileArt({
  file,
  hasThumb,
  iconSize = 44,
}: {
  file: FileLike;
  hasThumb: boolean;
  iconSize?: number;
}) {
  if (hasThumb && file.hash) return <img src={thumbUrl(file.hash)} alt="" loading="lazy" />;
  return <FileIcon icon={file.icon} size={iconSize} />;
}

export function FolderTile({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <button className="tile" onDoubleClick={onOpen} onClick={onOpen} title={name}>
      <div className="art">
        <FolderIcon size={56} />
      </div>
      <div className="name">{name}</div>
    </button>
  );
}

/** What can be shown without downloading: pictures, video, music, text, and PDF pages. */
export function previewable(f: FileLike, hasThumb: boolean) {
  return (
    !!f.hash &&
    (hasThumb || f.kind === 'video' || f.kind === 'audio' || f.kind === 'text' || f.kind === 'code')
  );
}

/** A file shown from its owner's computer, without downloading it (HANDOFF §9). */
export function PreviewDialog({
  file,
  hub,
  device,
  onClose,
  onDownload,
  onSaveTo,
}: {
  file: FileLike & { hash: string };
  hub: string;
  device: string;
  onClose: () => void;
  onDownload?: () => void;
  onSaveTo?: () => void;
}) {
  const media = file.kind === 'video' || file.kind === 'audio';
  const text = file.kind === 'text' || file.kind === 'code';
  const big = useThumbs(hub, device, media || text ? [] : [file.hash], true);
  const peek = useQuery({
    queryKey: ['peek', hub, device, file.hash],
    queryFn: () =>
      api.get<{ text: string; truncated: boolean }>(
        `/v1/peek?hub=${encodeURIComponent(hub)}&device=${encodeURIComponent(device)}&hash=${file.hash}`,
      ),
    enabled: text,
    retry: false,
  });
  const [mediaError, setMediaError] = useState(false);
  return (
    <Dialog title={file.name} onClose={onClose} wide>
      {media &&
        (mediaError ? (
          <div className="notice warn">This can’t be played from here. Download it to open it.</div>
        ) : file.kind === 'video' ? (
          <video
            className="preview-media"
            src={streamUrl(file.hash, file.mime)}
            controls
            autoPlay
            onError={() => setMediaError(true)}
          />
        ) : (
          <audio
            src={streamUrl(file.hash, file.mime)}
            controls
            autoPlay
            onError={() => setMediaError(true)}
            style={{ width: '100%' }}
          />
        ))}
      {text &&
        (peek.data ? (
          <pre className="peek">
            {peek.data.text}
            {peek.data.truncated && '\n…'}
          </pre>
        ) : peek.error ? (
          <div className="notice warn">The owner’s computer isn’t reachable right now.</div>
        ) : (
          <p className="muted">Loading…</p>
        ))}
      {!media &&
        !text &&
        (big(file.hash) ? (
          <img
            className="preview-media"
            src={thumbUrl(file.hash, 1600)}
            alt={file.name}
            style={{ background: 'none' }}
          />
        ) : (
          <div style={{ display: 'grid', placeItems: 'center', padding: 40 }}>
            <FileIcon icon={file.icon} size={96} />
          </div>
        ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="muted" style={{ flex: 1 }}>
          {describe(file.kind, file.meta, file.size)}
        </span>
        {onDownload && <DownloadButton primary onDownload={onDownload} onSaveTo={onSaveTo} />}
      </div>
    </Dialog>
  );
}

/**
 * Download, into the downloads folder; its menu offers Save to…, which asks where (ADR 0018),
 * and, with `onRemote`, each of your other devices that takes requests (ADR 0023). Without
 * `onDownload` (a file already on this computer) only the other devices are offered.
 */
export function DownloadButton({
  onDownload,
  onSaveTo,
  onRemote,
  small,
  primary,
}: {
  onDownload?: () => void;
  /** With a destination's name, into it; without, into a folder the person picks. */
  onSaveTo?: (destination?: string) => void;
  onRemote?: (device: RemoteDevice, destination?: string) => void;
  small?: boolean;
  primary?: boolean;
}) {
  const targets = useRemoteTargets();
  const remoteTargets = onRemote ? targets : [];
  const mine = useApi<{ destinations: Destination[] }>([], onSaveTo ? '/v1/destinations' : null);
  const named = (mine.data?.destinations ?? []).filter((d) => !d.builtin);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus();
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    // Capture, so Escape closes only the menu, not a dialog it's in.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  const cls = `btn${small ? ' small' : ''}${primary ? ' primary' : ''}`;
  const menu = (onSaveTo && onDownload ? 1 : 0) + remoteTargets.length;
  if (onDownload && menu === 0)
    return (
      <button className={cls} onClick={onDownload}>
        Download
      </button>
    );
  if (!onDownload && remoteTargets.length === 0) return null;
  return (
    <div className="split" ref={ref}>
      {onDownload ? (
        <button className={cls} onClick={onDownload} title="Into your downloads folder">
          Download
        </button>
      ) : (
        <button className={cls} onClick={() => setOpen(!open)} aria-haspopup="menu">
          Download on…
        </button>
      )}
      <button
        className={cls}
        aria-label="Other ways to download"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {onSaveTo &&
            onDownload &&
            named.map((d) => (
              <button
                key={d.name}
                role="menuitem"
                title={d.path}
                onClick={() => {
                  setOpen(false);
                  onSaveTo(d.name);
                }}
              >
                Save to {d.name}
              </button>
            ))}
          {onSaveTo && onDownload && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSaveTo();
              }}
            >
              Save to…
            </button>
          )}
          {remoteTargets.flatMap((d) =>
            // Its downloads folder, or one of its named destinations (names only: ADR 0018).
            d.destinations.length <= 1
              ? [
                  <button
                    key={d.device_id}
                    role="menuitem"
                    title={`Into ${d.name}’s downloads folder`}
                    onClick={() => {
                      setOpen(false);
                      onRemote!(d);
                    }}
                  >
                    Download on {d.name}
                  </button>,
                ]
              : d.destinations.map((dest, i) => (
                  <button
                    key={`${d.device_id}:${dest}`}
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onRemote!(d, i === 0 ? undefined : dest);
                    }}
                  >
                    On {d.name}: {dest}
                  </button>
                )),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Downloads a file into the downloads folder (Settings › Downloads), or, with `saveTo`, into a
 * folder the person picks first. Resolves to undefined when they cancel the picker.
 */
export function useDownload() {
  const confirm = useConfirm();
  return useAction(
    async (hash: string, name: string, saveTo: boolean | string = false) => {
      let dest: string | null = null;
      // A named destination (ADR 0018): no picker.
      if (typeof saveTo === 'string')
        return api.post<{ download: { name: string } }>('/v1/downloads', {
          hash,
          name,
          destination: saveTo,
        });
      if (saveTo) {
        const current = await api.get<DownloadSettings>('/v1/settings/downloads').catch(() => null);
        dest = await window.communal.pickFolder(`Save “${name}” to`, current?.dir);
        if (!dest) return null;
        // Saving into a shared folder shares the file too (ADR 0021): say so first.
        const e = await exposure(dest, name);
        if (
          e?.shared &&
          e.others &&
          !(await confirm({
            title: 'Share this file too?',
            body: <ReshareNote exposure={e} />,
            yes: 'Save and share',
          }))
        )
          return null;
      }
      return api.post<{ download: { name: string } }>('/v1/downloads', {
        hash,
        name,
        ...(dest ? { dest } : {}),
      });
    },
    {
      topics: ['transfers'],
      done: (r) => (r ? `Downloading ${r.download.name}` : null),
      toastErrors: true,
    },
  );
}

/** Who would see files saved at `dir` (+ `inside`); null if that can't be told. */
export function exposure(dir: string, inside?: string): Promise<Exposure | null> {
  const q = new URLSearchParams({ dir, ...(inside ? { inside } : {}) });
  return api.get<Exposure>(`/v1/exposure?${q}`).catch(() => null);
}

export function useExposure(dir: string | null | undefined, inside?: string) {
  const q = dir ? new URLSearchParams({ dir, ...(inside ? { inside } : {}) }) : null;
  return useApi<Exposure>(['hubs', 'people', 'index'], q ? `/v1/exposure?${q}` : null);
}

/**
 * The re-share warning (ADR 0021): files saved into one of your shared folders can be seen by
 * whoever can see that folder, possibly people the original owner never chose.
 */
export function ReshareNote({ exposure: e }: { exposure: Exposure | undefined | null }) {
  if (!e?.shared || !e.others) return null;
  return (
    <div className="notice warn" style={{ display: 'grid', gap: 6 }}>
      <span>{e.summary}</span>
      <span className="small">
        Whoever shared them with you may not have meant them for these people. To keep them to
        yourself, save somewhere outside your shared folders.
      </span>
    </div>
  );
}

/** Where a path goes, for people: the last two folders (`Music › Albums`). */
function shortPath(p: string) {
  return p.split(/[\\/]/).filter(Boolean).slice(-2).join(' › ');
}

/** What a folder download did, in a sentence. */
export function folderDownloadText(name: string, r: FolderDownload): string {
  const parts: string[] = [];
  if (r.queued) parts.push(`downloading ${plural(r.queued, 'file')} (${size(r.bytes)})`);
  if (r.copied) parts.push(`copied ${plural(r.copied, 'file')} you already had`);
  if (r.skipped) parts.push(`${plural(r.skipped, 'file')} already there`);
  if (r.unprepared) parts.push(`${plural(r.unprepared, 'file')} still being prepared`);
  const text = parts.join(', ') || 'nothing to download';
  return `${name}: ${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Downloading a folder and its subfolders once, into the downloads folder or a chosen one. */
export function DownloadFolderDialog({
  hub,
  device,
  path,
  owner,
  remoteOnly,
  onClose,
}: {
  hub: string;
  device: string;
  path: string;
  /** Whose folder it is; left out for your own other computers. */
  owner?: string;
  /** The folder is on this computer: another of your devices downloads it (ADR 0023). */
  remoteOnly?: boolean;
  onClose: () => void;
}) {
  const settings = useApi<DownloadSettings>([], '/v1/settings/downloads');
  const [dest, setDest] = useState<string | null>(null);
  const targets = useRemoteTargets();
  const { hubs } = useHubs();
  const [on, setOn] = useState<string | null>(null);
  const there = targets.find((t) => t.device_id === on) ?? (remoteOnly ? targets[0] : undefined);
  // On another device: one of its destinations, by name (ADR 0018); null is its downloads folder.
  const [remoteDest, setRemoteDest] = useState<string | null>(null);
  const name = baseName(path);
  const parent = dest ?? settings.data?.dir;
  const reshare = useExposure(there ? null : parent, `${name}/`);
  const shares = !there && reshare.data?.shared && reshare.data.others;
  const run = useAction(
    async () =>
      there
        ? {
            where: there.name,
            folder: await remote<FolderDownload>(there.device_id, {
              op: 'download_folder',
              // The other device numbers its hubs its own way: name this one by URL.
              hub: hubs.find((h) => h.id === hub)?.url,
              device_id: device,
              path,
              ...(remoteDest ? { destination: remoteDest } : {}),
            }),
          }
        : api.post<{ folder: FolderDownload; where?: string }>('/v1/downloads/folder', {
            hub,
            device,
            path,
            ...(dest ? { dest } : {}),
          }),
    {
      topics: ['transfers'],
      done: (r) => (r.where ? `On ${r.where}: ` : '') + folderDownloadText(name, r.folder),
      onDone: onClose,
    },
  );
  const pick = async () => {
    const d = await window.communal.pickFolder(`Save “${name}” to`, parent);
    if (d) setDest(d);
  };
  return (
    <Dialog title={`Download “${name}”`} onClose={onClose}>
      <p className="muted">
        Everything in this folder{owner ? ` of ${owner}’s` : ''}, including the folders inside it,
        is downloaded once. Files you already have aren’t downloaded again.
      </p>
      <WhereField
        value={there?.device_id ?? null}
        onChange={setOn}
        targets={targets}
        here={!remoteOnly}
      />
      {there ? (
        <RemoteDestinationField target={there} value={remoteDest} onChange={setRemoteDest} />
      ) : (
        <>
          <LocalDestinations current={dest} onPick={setDest} />
          <div className="field">
            <span>Save to</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                className="muted"
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={parent ? `${parent}/${name}` : undefined}
              >
                {parent ? `${shortPath(parent)} › ${name}` : '…'}
              </span>
              <button className="btn small" onClick={() => void pick()}>
                Change…
              </button>
            </div>
          </div>
        </>
      )}
      <ReshareNote exposure={reshare.data} />
      <ErrorNote error={run.error ?? settings.error} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={run.busy} onClick={() => void run.run()}>
          {run.busy ? 'Looking through the folder…' : shares ? 'Download and share' : 'Download'}
        </button>
      </div>
    </Dialog>
  );
}

/**
 * Subscribing to a folder (HANDOFF §2, §5). Whether to delete local copies when the owner
 * deletes a file is asked every time, and "No" is the default.
 */
export function SubscribeDialog({
  hub,
  device,
  path,
  owner,
  ownDevice,
  remoteOnly,
  onClose,
}: {
  hub: string;
  device: string;
  path: string;
  owner: string;
  /** Set when the folder is on another of your own devices (its name). */
  ownDevice?: string;
  /** The folder is on this computer: another of your devices follows it (ADR 0023). */
  remoteOnly?: boolean;
  onClose: () => void;
}) {
  const [dest, setDest] = useState<string | null>(null);
  const [mirror, setMirror] = useState(false);
  const settings = useApi<DownloadSettings>([], '/v1/settings/downloads');
  const targets = useRemoteTargets();
  const { hubs } = useHubs();
  const [on, setOn] = useState<string | null>(null);
  const there = targets.find((t) => t.device_id === on) ?? (remoteOnly ? targets[0] : undefined);
  // On another device: one of its destinations, by name (ADR 0018); null is its downloads folder.
  const [remoteDest, setRemoteDest] = useState<string | null>(null);
  // Without a choice, files go to <downloads folder>/<folder name> (ADR 0013, 0018).
  const reshare = useExposure(
    there ? null : (dest ?? settings.data?.dir),
    dest ? undefined : `${baseName(path)}/`,
  );
  const sub = useAction(
    () =>
      there
        ? remote(there.device_id, {
            op: 'subscribe',
            hub: hubs.find((h) => h.id === hub)?.url,
            device_id: device,
            path,
            mirror_deletes: mirror,
            ...(remoteDest ? { destination: remoteDest } : {}),
          })
        : api.post('/v1/subscriptions', {
            hub,
            device,
            path,
            mirror_deletes: mirror,
            ...(dest ? { dest } : {}),
          }),
    {
      topics: ['subscriptions', 'transfers'],
      done: there
        ? `${there.name} subscribed to ${baseName(path)}`
        : `Subscribed to ${baseName(path)}`,
      onDone: onClose,
    },
  );
  const pick = async () => {
    const d = await window.communal.pickFolder('Where should the files go?');
    if (d) setDest(d);
  };
  return (
    <Dialog title={`Subscribe to “${baseName(path)}”`} onClose={onClose}>
      {ownDevice ? (
        <p className="muted">
          Everything in this folder on {ownDevice} is copied to this computer, and new files arrive
          automatically. To keep the two in step both ways, save into a folder this computer shares,
          then subscribe to that folder from {ownDevice} too.
        </p>
      ) : (
        <p className="muted">
          Everything in this folder of {owner}’s is downloaded to your computer, and new files
          arrive automatically.
        </p>
      )}
      <WhereField
        value={there?.device_id ?? null}
        onChange={setOn}
        targets={targets}
        here={!remoteOnly}
      />
      {there ? (
        <RemoteDestinationField target={there} value={remoteDest} onChange={setRemoteDest} />
      ) : (
        <>
          <LocalDestinations current={dest} onPick={setDest} />
          <div className="field">
            <span>Save to</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                className="muted"
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {dest ??
                  (settings.data ? `${shortPath(settings.data.dir)} › ${baseName(path)}` : '…')}
              </span>
              <button className="btn small" onClick={() => void pick()}>
                Change…
              </button>
            </div>
          </div>
        </>
      )}
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 8 }}>
          {ownDevice
            ? `When a file is deleted on ${ownDevice}, delete it here too?`
            : `When ${owner} deletes a file, delete your copy too?`}
        </legend>
        <label className="check">
          <input type="radio" name="mirror" checked={!mirror} onChange={() => setMirror(false)} />
          <span>
            <b>No, keep my copy</b>
            <br />
            <span className="muted small">
              Files you already have stay, whatever happens to theirs.
            </span>
          </span>
        </label>
        <label className="check" style={{ marginTop: 8 }}>
          <input type="radio" name="mirror" checked={mirror} onChange={() => setMirror(true)} />
          <span>
            <b>Yes, move it to the trash</b>
            <br />
            <span className="muted small">Files you’ve changed yourself are never touched.</span>
          </span>
        </label>
      </fieldset>
      <ReshareNote exposure={reshare.data} />
      <ErrorNote error={sub.error} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={sub.busy} onClick={() => void sub.run()}>
          Subscribe
        </button>
      </div>
    </Dialog>
  );
}

/** This computer's named destinations, as shortcuts for "Save to" (ADR 0018). */
function LocalDestinations({
  current,
  onPick,
}: {
  current: string | null;
  onPick: (path: string | null) => void;
}) {
  const q = useApi<{ destinations: Destination[] }>([], '/v1/destinations');
  const list = q.data?.destinations ?? [];
  if (list.length <= 1) return null;
  const chosen = list.find((d) => d.path === current) ?? (current ? null : list[0]);
  return (
    <label className="field">
      <span>Destination</span>
      <select
        className="input"
        style={{ width: 'auto' }}
        value={chosen?.name ?? ''}
        onChange={(e) => {
          const d = list.find((x) => x.name === e.target.value);
          onPick(d && !d.builtin ? d.path : null);
        }}
      >
        {!chosen && <option value="">The folder below</option>}
        {list.map((d) => (
          <option key={d.name} value={d.name}>
            {d.name}
          </option>
        ))}
      </select>
    </label>
  );
}
