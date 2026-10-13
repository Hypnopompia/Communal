/**
 * Search (HANDOFF §11): one result per file content, however many people have it, with filters
 * by kind and size, and an availability filter (ADR 0015).
 */
import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api, qs, type Hit, type Kind, type SearchFrom, type SearchResult } from '../api';
import { plural, seenLabel } from '../format';
import { useNames } from '../hubs';
import { useNav } from '../nav';
import {
  describe,
  FileArt,
  PreviewDialog,
  DownloadButton,
  useDownload,
  useThumbs,
  type FileLike,
} from '../ui/files';
import { Icon } from '../ui/icons';
import { Empty, ErrorNote } from '../ui/kit';
import { VerifiedMark } from '../ui/VerifiedMark';

const KINDS: { value: Kind | ''; label: string }[] = [
  { value: '', label: 'Any kind' },
  { value: 'image', label: 'Pictures' },
  { value: 'video', label: 'Videos' },
  { value: 'audio', label: 'Music and audio' },
  { value: 'document', label: 'Documents' },
  { value: 'text', label: 'Text' },
  { value: 'archive', label: 'Archives' },
  { value: 'code', label: 'Code' },
  { value: 'disk_image', label: 'Disk images' },
  { value: 'other', label: 'Other' },
];

const FROM: { value: SearchFrom; label: string }[] = [
  { value: 'anyone', label: 'From anyone' },
  { value: 'connections', label: 'From my connections' },
  { value: 'verified', label: 'From people I’ve verified' },
];

const SIZES = [
  { value: 0, label: 'Any size' },
  { value: 1_000_000, label: 'Over 1 MB' },
  { value: 100_000_000, label: 'Over 100 MB' },
  { value: 1_000_000_000, label: 'Over 1 GB' },
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Search({ initial }: { initial: string }) {
  const [text, setText] = useState(initial);
  const [kind, setKind] = useState<Kind | ''>('');
  const [minSize, setMinSize] = useState(0);
  const [availableOnly, setAvailableOnly] = useState(false);
  const [from, setFrom] = useState<SearchFrom>('anyone');
  const q = useDebounced(text.trim(), 250);
  const filtered = !!kind || minSize > 0;
  const search = useInfiniteQuery({
    queryKey: ['search', q, kind, minSize, availableOnly, from],
    initialPageParam: undefined as Record<string, string> | undefined,
    queryFn: ({ pageParam }) =>
      api.get<SearchResult>(
        `/v1/search${qs({
          q,
          kind: kind || undefined,
          min_size: minSize || undefined,
          available: availableOnly ? 'week' : undefined,
          from: from === 'anyone' ? undefined : from,
          limit: 60,
          cursors: pageParam ? JSON.stringify(pageParam) : undefined,
        })}`,
      ),
    getNextPageParam: (last) => {
      const cursors = Object.fromEntries(
        last.hubs.filter((h) => h.cursor).map((h) => [h.hub, h.cursor!]),
      );
      return Object.keys(cursors).length ? cursors : undefined;
    },
    enabled: q.length > 0 || filtered,
  });
  // Pages from several hubs can repeat a file; keep its first (best-ranked) appearance.
  const hits = useMemo(() => {
    const seen = new Set<string>();
    return (search.data?.pages ?? [])
      .flatMap((p) => p.hits)
      .filter((h) => !seen.has(h.hash) && seen.add(h.hash));
  }, [search.data]);
  const down = search.data?.pages[0]?.hubs.filter((h) => !h.ok) ?? [];
  // "From" is filtered here, not by the hubs, so a page can come back thin: fetch on until
  // there's a screenful (or ten pages' worth of the hubs' results were looked at).
  const pages = search.data?.pages.length ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = search;
  useEffect(() => {
    if (from !== 'anyone' && hits.length < 30 && pages > 0 && pages < 10 && hasNextPage)
      if (!isFetchingNextPage) void fetchNextPage();
  }, [from, hits.length, pages, hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Search</h1>
      </div>
      <div className="toolbar">
        <div className="search-box">
          <Icon name="search" />
          <input
            className="input"
            type="search"
            placeholder="Search everything shared with you"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            aria-label="Search"
          />
        </div>
      </div>
      <div className="toolbar">
        <select
          className="input"
          style={{ width: 'auto' }}
          value={kind}
          onChange={(e) => setKind(e.target.value as Kind | '')}
          aria-label="Kind"
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
        <select
          className="input"
          style={{ width: 'auto' }}
          value={minSize}
          onChange={(e) => setMinSize(Number(e.target.value))}
          aria-label="Size"
        >
          {SIZES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          className="input"
          style={{ width: 'auto' }}
          value={from}
          onChange={(e) => setFrom(e.target.value as SearchFrom)}
          aria-label="From"
        >
          {FROM.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <label className="check" style={{ alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={availableOnly}
            onChange={(e) => setAvailableOnly(e.target.checked)}
            style={{ marginTop: 0 }}
          />
          <span>Show only available files</span>
        </label>
      </div>
      {availableOnly && (
        <p className="faint small" style={{ marginTop: -12 }}>
          Files on a computer that’s online now or was seen in the past week.
        </p>
      )}
      {down.length > 0 && (
        <div className="notice warn">
          {plural(down.length, 'hub')} didn’t answer, so some results may be missing.
        </div>
      )}
      <ErrorNote error={search.error} />
      {!q && !filtered && (
        <Empty title="Find anything shared with you">
          Type part of a name. Every word counts, so “beach 2019” finds “Beach trip (2019).mp4”.
        </Empty>
      )}
      {search.data && hits.length === 0 && !search.isFetchingNextPage && (
        <Empty title="No matches">
          {availableOnly
            ? 'Nothing matching is on a computer that’s been around lately. Try turning off “Show only available files”.'
            : from !== 'anyone'
              ? `Nothing matching comes from ${from === 'verified' ? 'people you’ve verified' : 'your connections'}. Try “From anyone”.`
              : 'Try fewer or shorter words, or a different kind.'}
        </Empty>
      )}
      {hits.length > 0 && (
        <div className="panel rows">
          {hits.map((h) => (
            <HitRow key={h.hash} hit={h} />
          ))}
        </div>
      )}
      {search.hasNextPage && (
        <div>
          <button
            className="btn"
            disabled={search.isFetchingNextPage}
            onClick={() => void search.fetchNextPage()}
          >
            {search.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </button>
        </div>
      )}
    </div>
  );
}

function HitRow({ hit }: { hit: Hit }) {
  const names = useNames();
  const go = useNav();
  const download = useDownload();
  const [preview, setPreview] = useState(false);
  // Thumbnails and previews come from the best source (sources are sorted most available first).
  const best = hit.sources[0];
  const hasThumb = useThumbs(
    best?.online ? best.hub : undefined,
    best?.device_id,
    hit.thumb ? [hit.hash] : [],
  );
  const file: FileLike = hit;
  const owners = [...new Set(hit.sources.map((s) => s.owner))];
  // Two copies on one computer are one source as far as anyone downloading is concerned.
  const computers = new Set(hit.sources.map((s) => s.device_id)).size;
  const online = new Set(hit.sources.filter((s) => s.online).map((s) => s.device_id)).size;
  return (
    <div className="row">
      <div className="mini-art" style={{ width: 56, height: 42 }}>
        <FileArt file={file} hasThumb={hasThumb(hit.hash)} iconSize={34} />
      </div>
      <div className="grow">
        <div className="title">{hit.name}</div>
        <div className="sub">
          {describe(hit.kind, hit.meta, hit.size)}. From{' '}
          {owners.slice(0, 3).map((o, i) => (
            <span key={o}>
              {i > 0 && ', '}
              {names.user(o)}
              <VerifiedMark on={names.verified(o)} />
            </span>
          ))}
          {owners.length > 3 ? ` and ${owners.length - 3} more` : ''}
        </div>
      </div>
      <div className="end">
        <span className={`status${online ? ' on' : ''}`}>
          {online
            ? computers > 1
              ? `${online} of ${computers} computers online`
              : 'Online'
            : best
              ? seenLabel(best.seen)
              : ''}
        </span>
        {best && (
          <button
            className="btn small quiet"
            onClick={() =>
              go({
                screen: 'library',
                hub: best.hub,
                device: best.device_id,
                path: best.path.replace(/[^/]*$/, ''),
              })
            }
            title="Show the folder it’s in"
          >
            Show folder
          </button>
        )}
        {best?.online && (
          <button className="btn small quiet" onClick={() => setPreview(true)}>
            Preview
          </button>
        )}
        <DownloadButton
          small
          onDownload={() => void download.run(hit.hash, hit.name)}
          onSaveTo={() => void download.run(hit.hash, hit.name, true)}
        />
      </div>
      {preview && best && (
        <PreviewDialog
          file={{ ...file, hash: hit.hash }}
          hub={best.hub}
          device={best.device_id}
          onClose={() => setPreview(false)}
          onDownload={() => void download.run(hit.hash, hit.name).then(() => setPreview(false))}
          onSaveTo={() =>
            void download.run(hit.hash, hit.name, true).then((r) => r && setPreview(false))
          }
        />
      )}
    </div>
  );
}
