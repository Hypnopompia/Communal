/**
 * Places people for the hub admin's connection graph (ADR 0020): a force layout where everyone
 * repels, connections pull together and a gentle gravity keeps loners near the middle. It runs
 * in unit space with no walls, then the result is scaled to fit the box. Deterministic (people
 * start on a circle in the given order), so the picture doesn't jump between refreshes.
 */
export interface Placed {
  id: string;
  x: number;
  y: number;
}

export function layoutGraph(
  ids: string[],
  edges: [string, string][],
  box: { w: number; h: number; margin: number },
): Placed[] {
  const n = ids.length;
  if (n === 0) return [];
  const index = new Map(ids.map((id, i) => [id, i]));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = Math.cos((2 * Math.PI * i) / n);
    y[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const links: [number, number][] = [];
  for (const [a, b] of edges) {
    const i = index.get(a);
    const j = index.get(b);
    if (i !== undefined && j !== undefined && i !== j) links.push([i, j]);
  }
  const k = 1 / Math.sqrt(n); // the ideal distance between neighbours
  const rounds = n > 150 ? 150 : 300;
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let r = 0; r < rounds; r++) {
    dx.fill(0);
    dy.fill(0);
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const ex = x[i]! - x[j]!;
        const ey = y[i]! - y[j]!;
        const d2 = Math.max(1e-6, ex * ex + ey * ey);
        const f = (k * k) / d2; // repulsion k²/d, along the unit vector
        dx[i]! += ex * f;
        dy[i]! += ey * f;
        dx[j]! -= ex * f;
        dy[j]! -= ey * f;
      }
    for (const [i, j] of links) {
      const ex = x[i]! - x[j]!;
      const ey = y[i]! - y[j]!;
      const f = Math.sqrt(ex * ex + ey * ey) / k; // attraction d²/k
      dx[i]! -= ex * f;
      dy[i]! -= ey * f;
      dx[j]! += ex * f;
      dy[j]! += ey * f;
    }
    const temp = 0.1 * (1 - r / rounds) + 0.002;
    for (let i = 0; i < n; i++) {
      dx[i]! -= x[i]! * 0.5; // gravity
      dy[i]! -= y[i]! * 0.5;
      const d = Math.hypot(dx[i]!, dy[i]!);
      if (d === 0) continue;
      const step = Math.min(d, temp);
      x[i]! += (dx[i]! / d) * step;
      y[i]! += (dy[i]! / d) * step;
    }
  }
  // Fit into the box, keeping proportions, centred.
  let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, x[i]!);
    maxX = Math.max(maxX, x[i]!);
    minY = Math.min(minY, y[i]!);
    maxY = Math.max(maxY, y[i]!);
  }
  const innerW = box.w - 2 * box.margin;
  const innerH = box.h - 2 * box.margin;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const scale = Math.min(
    spanX > 0 ? innerW / spanX : Infinity,
    spanY > 0 ? innerH / spanY : Infinity,
  );
  // A small graph isn't blown up to fill the box: neighbours stay about 140 px apart at most.
  const s = Math.min(Number.isFinite(scale) ? scale : 0, 140 / k);
  const offX = box.margin + (innerW - spanX * s) / 2;
  const offY = box.margin + (innerH - spanY * s) / 2;
  return ids.map((id, i) => ({
    id,
    x: offX + (x[i]! - minX) * s,
    y: offY + (y[i]! - minY) * s,
  }));
}
