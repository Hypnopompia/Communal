/**
 * Library (HANDOFF §11): people → their computers → shared folders, with thumbnails, online
 * badges, and Download / Subscribe / Preview.
 */
import { useState } from 'react';
import { qs, type LibraryDevice, type Listing } from '../api';
import { baseName, plural, seenLabel, computerName } from '../format';
import { useLibrary, useStatus } from '../hubs';
import { useNav, type Route } from '../nav';
import { useApi } from '../query';
import { Disc } from '../ui/Disc';
import { VerifiedMark } from '../ui/VerifiedMark';
import {
  describe,
  DownloadFolderDialog,
  FileArt,
  FolderTile,
  previewable,
  PreviewDialog,
  SubscribeDialog,
  DownloadButton,
  useDownload,
  useThumbs,
  type FileLike,
} from '../ui/files';
import { FolderIcon, Icon } from '../ui/icons';
import { Empty, ErrorNote } from '../ui/kit';

type View = 'grid' | 'list';
const VIEW_KEY = 'library.view';

/** Grid or list, remembered across folders and restarts (this profile's localStorage). */
function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });
  const choose = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Not remembered; the choice still holds for now.
    }
  };
  return [view, choose];
}

export function Library({ route }: { route: Extract<Route, { screen: 'library' }> }) {
  const lib = useLibrary();
  const device = lib.data?.devices.find((d) => d.device_id === route.device && d.hub === route.hub);
  if (route.device && route.hub)
    return (
      <Browse hub={route.hub} deviceId={route.device} device={device} path={route.path ?? ''} />
    );
  return <People devices={lib.data?.devices} error={lib.error} />;
}

/** Everyone you can browse, grouped by person, you first. */
function People({ devices, error }: { devices: LibraryDevice[] | undefined; error: Error | null }) {
  const go = useNav();
  const me = useStatus().data?.account.user_id;
  const people = new Map<
    string,
    { name: string; fingerprint: string; verified: boolean; devices: LibraryDevice[] }
  >();
  for (const d of devices ?? []) {
    const p = people.get(d.user.user_id) ?? {
      name: d.user.display_name,
      fingerprint: d.user.fingerprint,
      verified: d.user.verified,
      devices: [],
    };
    // The same computer on two hubs is one entry; prefer the hub where it's online.
    const twin = p.devices.findIndex((x) => x.device_id === d.device_id);
    if (twin < 0) p.devices.push(d);
    else if (!p.devices[twin]!.online && d.online) p.devices[twin] = d;
    people.set(d.user.user_id, p);
  }
  const list = [...people.entries()].sort(([a], [b]) => Number(b === me) - Number(a === me));
  const others = list.filter(([id]) => id !== me);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <p className="lede">Everything people have shared with you, computer by computer.</p>
        </div>
      </div>
      <ErrorNote error={error} />
      {devices && others.length === 0 && (
        <Empty
          title="Nobody has shared anything with you yet"
          action={
            <button className="btn primary" onClick={() => go({ screen: 'people' })}>
              Find people
            </button>
          }
        >
          Connect with the people you know on your hub. Once they share a folder with you, it shows
          up here.
        </Empty>
      )}
      {list.map(([id, p]) => (
        <section key={id} className="section">
          <div className="section-head" style={{ alignItems: 'center', gap: 12 }}>
            <Disc
              name={p.name}
              seed={p.fingerprint}
              size={40}
              online={p.devices.some((d) => d.online)}
            />
            <h2>
              {id === me ? `${p.name} (you)` : p.name}
              <VerifiedMark on={p.verified} />
            </h2>
          </div>
          <div className="panel rows">
            {p.devices.map((d) => (
              <div
                key={d.device_id}
                className="row clickable"
                role="button"
                tabIndex={0}
                onClick={() => go({ screen: 'library', hub: d.hub, device: d.device_id })}
                onKeyDown={(e) =>
                  e.key === 'Enter' && go({ screen: 'library', hub: d.hub, device: d.device_id })
                }
              >
                <Icon name="device" size={22} />
                <div className="grow">
                  <div className="title">{d.device_name}</div>
                </div>
                <span className={`status${d.online ? ' on' : ''}`}>{seenLabel(d.seen)}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Browse({
  hub,
  deviceId,
  device,
  path,
}: {
  hub: string;
  deviceId: string;
  device: LibraryDevice | undefined;
  path: string;
}) {
  const go = useNav();
  const me = useStatus().data;
  // This computer: nothing to download or follow. Your other devices are fair game (that's
  // how two of them keep a folder in step).
  const own = deviceId === me?.device_id;
  const mine = own || device?.user.user_id === me?.account.user_id;
  const [view, setView] = useView();
  const [preview, setPreview] = useState<(FileLike & { hash: string }) | null>(null);
  const [subscribe, setSubscribe] = useState(false);
  const [getFolder, setGetFolder] = useState(false);
  const download = useDownload();
  const listing = useApi<Listing>(
    ['index', 'presence', 'browse'],
    `/v1/browse${qs({ hub, device: deviceId, path })}`,
  );
  // Dotfiles (the synced folder's marker) are bookkeeping, not something to download.
  const files: FileLike[] = (listing.data?.files ?? [])
    .map((f) => ({ ...f, name: baseName(f.path) }))
    .filter((f) => !f.name.startsWith('.'));
  const hasThumb = useThumbs(
    hub,
    deviceId,
    files
      .filter((f) => f.hash && listing.data?.files.find((x) => x.hash === f.hash)?.thumb)
      .map((f) => f.hash!),
  );
  const open = (p: string) => go({ screen: 'library', hub, device: deviceId, path: p });
  const segs = path.split('/').filter(Boolean);
  const online = listing.data?.online ?? device?.online ?? false;
  const owner = device?.user.display_name ?? 'this person';

  return (
    <div className="page">
      <div className="page-head">
        <button
          className="btn quiet"
          onClick={() => go({ screen: 'library' })}
          aria-label="All people"
        >
          <Icon name="back" />
        </button>
        {device && (
          <Disc
            name={device.user.display_name}
            seed={device.user.fingerprint}
            size={44}
            online={online}
          />
        )}
        <div>
          <h1>
            {device ? computerName(device.user.display_name, device.device_name) : 'Computer'}
            <VerifiedMark on={device?.user.verified} />
          </h1>
          <span className={`status${online ? ' on' : ''}`}>
            {device ? seenLabel(online ? 'now' : device.seen) : online ? 'Online' : 'Offline'}
          </span>
        </div>
        <div className="actions">
          {segs.length > 0 && !own && (
            <>
              <button className="btn" onClick={() => setGetFolder(true)}>
                <Icon name="transfers" size={16} /> Download folder
              </button>
              <button className="btn" onClick={() => setSubscribe(true)}>
                <Icon name="subscriptions" size={16} /> Subscribe to this folder
              </button>
            </>
          )}
          <div className="segmented" role="group" aria-label="View">
            <button aria-pressed={view === 'grid'} onClick={() => setView('grid')}>
              Grid
            </button>
            <button aria-pressed={view === 'list'} onClick={() => setView('list')}>
              List
            </button>
          </div>
        </div>
      </div>

      <nav className="crumbs" aria-label="Folder">
        {segs.length === 0 ? (
          <span className="here">Shared folders</span>
        ) : (
          <button onClick={() => open('')}>Shared folders</button>
        )}
        {segs.map((s, i) => (
          <span key={i} style={{ display: 'contents' }}>
            <span className="faint">›</span>
            {i === segs.length - 1 ? (
              <span className="here">{s}</span>
            ) : (
              <button onClick={() => open(segs.slice(0, i + 1).join('/') + '/')}>{s}</button>
            )}
          </span>
        ))}
      </nav>

      {!online && (
        <div className="notice warn">
          {owner}’s computer is offline. You can look around, but downloads wait until it’s back.
        </div>
      )}
      <ErrorNote error={listing.error} />

      {listing.data && listing.data.dirs.length === 0 && files.length === 0 && (
        <Empty title="Nothing here">
          This folder is empty, or nothing in it is shared with you.
        </Empty>
      )}

      {view === 'grid' ? (
        <div className="grid">
          {listing.data?.dirs.map((d) => (
            <FolderTile key={d.name} name={d.name} onOpen={() => open(`${path}${d.name}/`)} />
          ))}
          {files.map((f) => {
            const thumb = hasThumb(f.hash);
            return (
              <button
                key={f.name}
                className="tile"
                title={f.name}
                onClick={() => f.hash && setPreview({ ...f, hash: f.hash })}
                onDoubleClick={() => f.hash && void download.run(f.hash, f.name)}
              >
                <div className="art">
                  <FileArt file={f} hasThumb={thumb} />
                </div>
                <div className="name">{f.name}</div>
                <div className="meta">
                  {f.hash ? describe(f.kind, f.meta, f.size) : 'Still being prepared'}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="panel rows">
          {listing.data?.dirs.map((d) => (
            <div key={d.name} className="row clickable" onClick={() => open(`${path}${d.name}/`)}>
              <FolderIcon size={30} />
              <div className="grow title">{d.name}</div>
            </div>
          ))}
          {files.map((f) => {
            const thumb = hasThumb(f.hash);
            return (
              <div key={f.name} className="row">
                <div className="mini-art" style={{ width: 40, height: 30 }}>
                  <FileArt file={f} hasThumb={thumb} iconSize={30} />
                </div>
                <div className="grow">
                  <div className="title">{f.name}</div>
                  <div className="sub">{describe(f.kind, f.meta, f.size)}</div>
                </div>
                <div className="end">
                  {f.hash && previewable(f, thumb) && (
                    <button
                      className="btn small quiet"
                      onClick={() => setPreview({ ...f, hash: f.hash! })}
                    >
                      Preview
                    </button>
                  )}
                  {f.hash ? (
                    !own && (
                      <DownloadButton
                        small
                        onDownload={() => void download.run(f.hash!, f.name)}
                        onSaveTo={() => void download.run(f.hash!, f.name, true)}
                      />
                    )
                  ) : (
                    <span className="faint small">Still being prepared</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {files.length > 0 && view === 'grid' && (
        <p className="faint small">
          {plural(files.length, 'file')}. Click a file to look at it, double-click to download it.
        </p>
      )}

      {preview && (
        <PreviewDialog
          file={preview}
          hub={hub}
          device={deviceId}
          onClose={() => setPreview(null)}
          {...(own
            ? {}
            : {
                onDownload: () =>
                  void download.run(preview.hash, preview.name).then(() => setPreview(null)),
                onSaveTo: () =>
                  void download
                    .run(preview.hash, preview.name, true)
                    .then((r) => r && setPreview(null)),
              })}
        />
      )}
      {getFolder && (
        <DownloadFolderDialog
          hub={hub}
          device={deviceId}
          path={path}
          {...(mine ? {} : { owner })}
          onClose={() => setGetFolder(false)}
        />
      )}
      {subscribe && (
        <SubscribeDialog
          hub={hub}
          device={deviceId}
          path={path}
          owner={owner}
          {...(mine && device ? { ownDevice: device.device_name } : {})}
          onClose={() => setSubscribe(false)}
        />
      )}
    </div>
  );
}
