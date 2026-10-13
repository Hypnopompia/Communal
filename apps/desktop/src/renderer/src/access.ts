import type { Audience } from './api';

/** The rule that applies to a path: its own, else the nearest folder's, else "Only me". */
export function effective(rules: { path: string; audience: Audience }[], path: string) {
  const byPath = new Map(rules.map((r) => [r.path, r.audience]));
  const own = byPath.get(path);
  if (own !== undefined) return { audience: own, from: path };
  const segs = path.replace(/\/$/, '').split('/');
  for (let i = segs.length - 1; i >= 1; i--) {
    const p = segs.slice(0, i).join('/') + '/';
    const a = byPath.get(p);
    if (a !== undefined) return { audience: a, from: p };
  }
  return { audience: 'me' as Audience, from: null };
}
