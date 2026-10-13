import { describe, expect, it } from 'vitest';
import { layoutGraph, type Placed } from './graph-layout';

const box = { w: 760, h: 460, margin: 40 };
const dist = (a: Placed, b: Placed) => Math.hypot(a.x - b.x, a.y - b.y);

function inside(p: Placed[]) {
  for (const q of p) {
    expect(q.x).toBeGreaterThanOrEqual(box.margin - 0.001);
    expect(q.x).toBeLessThanOrEqual(box.w - box.margin + 0.001);
    expect(q.y).toBeGreaterThanOrEqual(box.margin - 0.001);
    expect(q.y).toBeLessThanOrEqual(box.h - box.margin + 0.001);
  }
}

describe('layoutGraph', () => {
  it('handles nobody, one person and the same input twice', () => {
    expect(layoutGraph([], [], box)).toEqual([]);
    const one = layoutGraph(['a'], [], box);
    expect(one[0]).toMatchObject({ x: box.w / 2, y: box.h / 2 });
    const ids = ['a', 'b', 'c', 'd'];
    expect(layoutGraph(ids, [['a', 'b']], box)).toEqual(layoutGraph(ids, [['a', 'b']], box));
  });

  it('spreads people with no connections over the box instead of the corners', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const p = layoutGraph(ids, [['b', 'c']], box);
    inside(p);
    for (let i = 0; i < p.length; i++)
      for (let j = i + 1; j < p.length; j++) expect(dist(p[i]!, p[j]!)).toBeGreaterThan(40);
    // Not everyone pressed against an edge.
    const atEdge = p.filter(
      (q) =>
        Math.min(
          q.x - box.margin,
          box.w - box.margin - q.x,
          q.y - box.margin,
          box.h - box.margin - q.y,
        ) < 1,
    );
    expect(atEdge.length).toBeLessThan(p.length);
  });

  it('keeps connected people closer than unconnected ones', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `u${i}`);
    // Two rings of 15 people that don't know each other.
    const edges: [string, string][] = [];
    for (let i = 0; i < 15; i++) {
      edges.push([`u${i}`, `u${(i + 1) % 15}`]);
      edges.push([`u${15 + i}`, `u${15 + ((i + 1) % 15)}`]);
    }
    const p = layoutGraph(ids, edges, box);
    inside(p);
    const at = new Map(p.map((q) => [q.id, q]));
    const linked = edges.map(([a, b]) => dist(at.get(a)!, at.get(b)!));
    const across: number[] = [];
    for (let i = 0; i < 15; i++) across.push(dist(at.get(`u${i}`)!, at.get(`u${15 + i}`)!));
    const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
    expect(mean(linked)).toBeLessThan(mean(across));
  });

  it('ignores connections to people it was not given', () => {
    const p = layoutGraph(['a', 'b'], [['a', 'zz']], box);
    expect(p.map((q) => q.id)).toEqual(['a', 'b']);
    inside(p);
  });
});
