/**
 * The window's size, position and maximized state, kept in userData (`window.json`) so the app
 * opens where it was left. Nothing here imports Electron, so `fitBounds` is testable on its own.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  bounds: Rect;
  maximized: boolean;
}

/**
 * Places saved bounds on the screens there are now. The window goes on the display it overlaps
 * most (the primary one when it overlaps none, say a monitor that was unplugged), shrinks to fit
 * that display's work area, and moves inside it, so it's never off screen or out of reach.
 */
export function fitBounds(saved: Rect, workAreas: Rect[], min = { width: 0, height: 0 }): Rect {
  const overlap = (a: Rect) =>
    Math.max(0, Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x)) *
    Math.max(0, Math.min(saved.y + saved.height, a.y + a.height) - Math.max(saved.y, a.y));
  let area = workAreas[0]!;
  for (const a of workAreas) if (overlap(a) > overlap(area)) area = a;
  const onScreen = overlap(area) > 0;
  const width = Math.min(Math.max(saved.width, min.width), area.width);
  const height = Math.min(Math.max(saved.height, min.height), area.height);
  // Off every screen: centre it on the primary display rather than in a corner.
  const x = onScreen ? saved.x : area.x + Math.round((area.width - width) / 2);
  const y = onScreen ? saved.y : area.y + Math.round((area.height - height) / 2);
  return {
    x: Math.min(Math.max(x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(y, area.y), area.y + area.height - height),
    width,
    height,
  };
}

const valid = (s: unknown): s is WindowState => {
  const v = s as WindowState | null;
  return (
    !!v &&
    typeof v.maximized === 'boolean' &&
    ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(v.bounds?.[k as keyof Rect])) &&
    v.bounds.width > 0 &&
    v.bounds.height > 0
  );
};

export class WindowStateFile {
  private readonly file: string;

  constructor(dir: string) {
    this.file = join(dir, 'window.json');
  }

  /** The saved state, or null on first start (or if the file is unreadable). */
  read(): WindowState | null {
    try {
      const s: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return valid(s) ? s : null;
    } catch {
      return null;
    }
  }

  write(state: WindowState) {
    try {
      writeFileSync(this.file + '.tmp', JSON.stringify(state), { mode: 0o600 });
      renameSync(this.file + '.tmp', this.file);
    } catch {
      // Remembering the window is a nicety; never let it break the app.
    }
  }
}
