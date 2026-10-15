import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fitBounds, WindowStateFile } from './window-state.js';

const laptop = { x: 0, y: 25, width: 1440, height: 875 };
const external = { x: 1440, y: 0, width: 2560, height: 1415 };
const min = { width: 760, height: 520 };

describe('fitBounds', () => {
  it('keeps bounds that are on a screen', () => {
    const b = { x: 100, y: 100, width: 1200, height: 700 };
    expect(fitBounds(b, [laptop, external], min)).toEqual(b);
    const there = { x: 2000, y: 200, width: 1600, height: 1000 };
    expect(fitBounds(there, [laptop, external], min)).toEqual(there);
  });

  it('centres the window on the primary display when its screen is gone', () => {
    const b = fitBounds({ x: 2000, y: 200, width: 1200, height: 700 }, [laptop], min);
    expect(b).toEqual({ x: 120, y: 113, width: 1200, height: 700 });
  });

  it('shrinks a window bigger than the screen it is on', () => {
    const b = fitBounds({ x: 1500, y: 0, width: 2500, height: 1400 }, [laptop], min);
    expect(b).toEqual(laptop);
  });

  it('pulls a window hanging off the edge back inside', () => {
    expect(fitBounds({ x: -900, y: 700, width: 1000, height: 600 }, [laptop], min)).toEqual({
      x: 0,
      y: 300,
      width: 1000,
      height: 600,
    });
  });

  it('never goes below the minimum size', () => {
    expect(fitBounds({ x: 10, y: 40, width: 200, height: 100 }, [laptop], min)).toMatchObject({
      width: 760,
      height: 520,
    });
  });

  it('places it on the display it overlaps most', () => {
    const b = fitBounds({ x: 1300, y: 100, width: 1000, height: 600 }, [laptop, external], min);
    expect(b.x).toBe(1440);
  });
});

describe('WindowStateFile', () => {
  it('round-trips and ignores a damaged file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'window-state-'));
    const f = new WindowStateFile(dir);
    expect(f.read()).toBeNull();
    const s = { bounds: { x: 1, y: 2, width: 800, height: 600 }, maximized: true };
    f.write(s);
    expect(f.read()).toEqual(s);
    writeFileSync(join(dir, 'window.json'), '{"bounds":{"x":"a"}}');
    expect(f.read()).toBeNull();
  });
});
