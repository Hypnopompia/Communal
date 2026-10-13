import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, streamUrl, thumbUrl, type Kind, type Meta } from '../api';
import { baseName, date, duration, size } from '../format';
import { Dialog, ErrorNote, useAction } from './kit';
import { FileIcon, FolderIcon } from './icons';

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
}: {
  file: FileLike & { hash: string };
  hub: string;
  device: string;
  onClose: () => void;
  onDownload?: () => void;
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
        {onDownload && (
          <button className="btn primary" onClick={onDownload}>
            Download
          </button>
        )}
      </div>
    </Dialog>
  );
}

export function useDownload() {
  return useAction(
    (hash: string, name: string) =>
      api.post<{ download: { name: string } }>('/v1/downloads', { hash, name }),
    { topics: ['transfers'], done: (r) => `Downloading ${r.download.name}`, toastErrors: true },
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
  onClose,
}: {
  hub: string;
  device: string;
  path: string;
  owner: string;
  /** Set when the folder is on another of your own devices (its name). */
  ownDevice?: string;
  onClose: () => void;
}) {
  const [dest, setDest] = useState<string | null>(null);
  const [mirror, setMirror] = useState(false);
  const sub = useAction(
    () =>
      api.post('/v1/subscriptions', {
        hub,
        device,
        path,
        mirror_deletes: mirror,
        ...(dest ? { dest } : {}),
      }),
    {
      topics: ['subscriptions', 'transfers'],
      done: `Subscribed to ${baseName(path)}`,
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
      <div className="field">
        <span>Save to</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="muted" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {dest ?? `Downloads › Communal › ${baseName(path)}`}
          </span>
          <button className="btn small" onClick={() => void pick()}>
            Change…
          </button>
        </div>
      </div>
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
