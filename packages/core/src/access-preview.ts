import { governingRule } from '@communal/protocol';
import type { Audience, IndexStore } from './index/store.js';

/**
 * What a rule change would do before it's made (ADR 0021): which of this computer's files
 * change who can see them on one hub, from whom to whom. It only reads this device's own rules,
 * files, connections and groups, so it can't reveal anything the owner couldn't already see.
 * A preview is shown to the person; it never stands in for asking them.
 */

/** Who an audience reaches, in words and numbers. */
export interface AudienceView {
  audience: Audience;
  /** "only you", "everyone on Hunter family", "Ann, Ben and the group Family". */
  label: string;
  /** People it reaches besides you; null for everyone on the hub (the hub doesn't say). */
  people: number | null;
}

export interface AccessChange {
  from: AudienceView;
  to: AudienceView;
  files: number;
  bytes: number;
  /** Up to five of the files, as hub paths. */
  examples: string[];
  /** Someone who couldn't see these files could afterwards. */
  widens: boolean;
}

export interface AccessPreview {
  hub: string;
  path: string;
  /** Whether the share is listed on this hub at all. If not, nobody there sees it yet. */
  listed: boolean;
  files: number;
  bytes: number;
  changes: AccessChange[];
  widens: boolean;
  /** One paragraph to show the person before they decide. */
  summary: string;
}

/** What the preview knows about people on the hub; empty when the hub is offline. */
export interface PeopleOnHub {
  hubName: string;
  /** Accepted connections: list rules reach only these (ADR 0009). */
  connections: Map<string, string>;
  groups: Map<string, { name: string; members: string[] }>;
}

const PAGE = 2_000;
const same = (a: Audience, b: Audience) => JSON.stringify(a) === JSON.stringify(b);

/** The people a list audience reaches: named users and group members who are connections. */
function reach(a: Audience, p: PeopleOnHub): Set<string> {
  if (typeof a === 'string') return new Set();
  const ids = new Set<string>(a.users ?? []);
  for (const g of a.groups ?? []) for (const m of p.groups.get(g)?.members ?? []) ids.add(m);
  return new Set([...ids].filter((id) => p.connections.has(id)));
}

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function describeAudience(a: Audience, p: PeopleOnHub): AudienceView {
  if (a === 'me') return { audience: a, label: 'only you', people: 0 };
  if (a === 'hub') return { audience: a, label: `everyone on ${p.hubName}`, people: null };
  const names = (a.users ?? []).map(
    (id) => p.connections.get(id) ?? 'someone you’re not connected to',
  );
  const groups = (a.groups ?? []).map((g) => {
    const name = p.groups.get(g)?.name;
    return name ? `the group ${name}` : 'a group that no longer exists';
  });
  const people = reach(a, p).size;
  const label = list([...names, ...groups]) || 'nobody';
  return {
    audience: a,
    label: people ? `${label} (${people} ${people === 1 ? 'person' : 'people'})` : label,
    people,
  };
}

/** Whether going from `from` to `to` lets someone new see a file. */
function widens(from: Audience, to: Audience, p: PeopleOnHub): boolean {
  if (to === 'me' || same(from, to)) return false;
  if (to === 'hub') return from !== 'hub';
  if (from === 'hub') return false;
  const before = reach(from, p);
  return [...reach(to, p)].some((id) => !before.has(id));
}

/**
 * Compares every file under `path` (in its share) before and after the rule change. `rulePath`
 * is already normalised (a folder ends with `/`).
 */
export function previewRule(
  store: IndexStore,
  hub: string,
  rulePath: string,
  audience: Audience | null,
  people: PeopleOnHub,
): AccessPreview {
  const share = rulePath.split('/')[0]!;
  const rules = new Map(store.rules(hub).map((r) => [r.path, r.audience]));
  const next = new Map(rules);
  if (audience === null) next.delete(rulePath);
  else next.set(rulePath, audience);
  const before = new Set(rules.keys());
  const after = new Set(next.keys());
  const effective = (paths: Set<string>, map: Map<string, Audience>, file: string): Audience => {
    const g = governingRule(paths, file);
    return g === null ? 'me' : map.get(g)!;
  };

  const groups = new Map<string, AccessChange & { fromA: Audience; toA: Audience }>();
  let files = 0;
  let bytes = 0;
  let after_: { share: string; rel: string } | null = null;
  for (;;) {
    const page = store.filesPage([share], after_, PAGE);
    if (page.length === 0) break;
    after_ = { share: page.at(-1)!.share, rel: page.at(-1)!.rel };
    for (const f of page) {
      const path = `${f.share}/${f.rel}`;
      if (rulePath.endsWith('/') ? !path.startsWith(rulePath) : path !== rulePath) continue;
      const from = effective(before, rules, path);
      const to = effective(after, next, path);
      if (same(from, to)) continue;
      const key = JSON.stringify([from, to]);
      let g = groups.get(key);
      if (!g) {
        g = {
          fromA: from,
          toA: to,
          from: describeAudience(from, people),
          to: describeAudience(to, people),
          files: 0,
          bytes: 0,
          examples: [],
          widens: widens(from, to, people),
        };
        groups.set(key, g);
      }
      g.files++;
      g.bytes += f.size;
      if (g.examples.length < 5) g.examples.push(path);
      files++;
      bytes += f.size;
    }
    if (page.length < PAGE) break;
  }

  const changes = [...groups.values()].map(({ fromA: _f, toA: _t, ...c }) => c);
  const listed = store.share(share)?.hubs.includes(hub) ?? false;
  const anyWider = changes.some((c) => c.widens);
  const parts: string[] = [];
  if (changes.length === 0)
    parts.push(
      `Nothing changes: no file under ${rulePath} would be seen by anyone new or lose anyone.`,
    );
  for (const c of changes)
    parts.push(
      `${c.files} file${c.files === 1 ? '' : 's'} (${c.examples.slice(0, 2).join(', ')}${c.files > 2 ? ', …' : ''}) would go from ${c.from.label} to ${c.to.label}.`,
    );
  if (!listed)
    parts.push(
      `${share} isn’t listed on ${people.hubName} yet, so nobody there sees it until it is.`,
    );
  else if (anyWider) parts.push('People who can’t see these files now would be able to.');
  return {
    hub,
    path: rulePath,
    listed,
    files,
    bytes,
    changes,
    widens: anyWider && listed,
    summary: parts.join(' '),
  };
}

/**
 * Who would see files saved into a folder of this computer (ADR 0021: the re-share warning).
 * A download that lands inside one of your shares is shared like the rest of that folder.
 */
export type Exposure =
  | { shared: false }
  | {
      shared: true;
      share: string;
      /** The folder or file as hubs see it, e.g. "Music/Albums/Blue/". */
      path: string;
      hubs: { hub: string; hub_name: string; audience: AudienceView }[];
      /** Anyone but you would see them. */
      others: boolean;
      summary: string;
    };

export function exposureOf(
  store: IndexStore,
  share: string,
  path: string,
  hubs: Map<string, PeopleOnHub>,
): Exposure {
  const out = [...hubs].map(([hub, people]) => {
    const rules = new Map(store.rules(hub).map((r) => [r.path, r.audience]));
    const g = governingRule(new Set(rules.keys()), path);
    const audience = g === null ? 'me' : rules.get(g)!;
    return { hub, hub_name: people.hubName, audience: describeAudience(audience, people) };
  });
  const seen = out.filter((h) => h.audience.people !== 0);
  const summary = seen.length
    ? `Files saved here go into your shared folder ${share}, so ${list(
        seen.map((h) =>
          hubs.size > 1 ? `${h.audience.label} on ${h.hub_name}` : h.audience.label,
        ),
      )} will be able to see them.`
    : `Files saved here go into your shared folder ${share}, but only you can see that folder.`;
  return { shared: true, share, path, hubs: out, others: seen.length > 0, summary };
}
