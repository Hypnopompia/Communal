import { describe, expect, it } from 'vitest';
import { isLanAddress } from '../peer/transport.js';
import { safeName, toRanges } from './downloader.js';

describe('transfer helpers', () => {
  it('coalesces chunk indices into [start, end) ranges', () => {
    expect(toRanges([5, 1, 2, 3, 9, 10])).toEqual([
      [1, 4],
      [5, 6],
      [9, 11],
    ]);
    expect(toRanges([])).toEqual([]);
  });

  it('never lets a network-supplied name escape the download folder', () => {
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('..\\..\\boot.ini')).toBe('boot.ini');
    expect(safeName('..')).toBe('download');
    expect(safeName('a<b>:c?.txt')).toBe('a_b__c_.txt');
    expect(safeName('Alien (1979).mkv')).toBe('Alien (1979).mkv');
  });

  it('classifies LAN addresses for "only upload on LAN"', () => {
    for (const a of [
      '192.168.1.5',
      '10.0.0.2',
      '172.20.1.1',
      '127.0.0.1',
      '::1',
      'fe80::1',
      'fd12::5',
      '::ffff:10.1.2.3',
    ]) {
      expect(isLanAddress(a)).toBe(true);
    }
    for (const a of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1'])
      expect(isLanAddress(a)).toBe(false);
  });
});
