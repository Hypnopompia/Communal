import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { headlessDataDir, SERVICE_DATA_DIR } from './discover.js';

describe('headlessDataDir', () => {
  it('uses COMMUNAL_DATA when set', () => {
    expect(headlessDataDir({ COMMUNAL_DATA: '/srv/c', HOME: '/home/a' }, 'communal', 'linux')).toBe(
      '/srv/c',
    );
  });

  it("finds the Linux service's data dir as its communal user", () => {
    // `sudo -u communal communal status` sets HOME to the user's home, not the data dir.
    expect(headlessDataDir({ HOME: SERVICE_DATA_DIR }, 'communal', 'linux')).toBe(SERVICE_DATA_DIR);
  });

  it('uses ~/.communal for anyone else', () => {
    expect(headlessDataDir({ HOME: '/home/alice' }, 'alice', 'linux')).toBe(
      join('/home/alice', '.communal'),
    );
    expect(headlessDataDir({ HOME: '/Users/communal' }, 'communal', 'darwin')).toBe(
      join('/Users/communal', '.communal'),
    );
  });
});
