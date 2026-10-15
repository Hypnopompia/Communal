import { describe, expect, it } from 'vitest';
import { effective } from './access';
import { computerName, hubUrl, seenLabel, size, splitName } from './format';

describe('hub addresses as people type them', () => {
  it('becomes the hub WebSocket URL', () => {
    expect(hubUrl('hub.example.com')).toBe('wss://hub.example.com/v1');
    expect(hubUrl(' https://hub.example.com ')).toBe('wss://hub.example.com/v1');
    expect(hubUrl('localhost:8443')).toBe('wss://localhost:8443/v1');
    expect(hubUrl('wss://hub.example.com/custom')).toBe('wss://hub.example.com/custom');
    expect(hubUrl('ws://10.0.0.2:8443/v1')).toBe('ws://10.0.0.2:8443/v1');
  });
});

describe('the rule that applies to a path (HANDOFF §6)', () => {
  const rules = [
    { path: 'Photos/', audience: 'hub' as const },
    { path: 'Photos/Private/', audience: 'me' as const },
    { path: 'Photos/Private/ok.jpg', audience: { users: ['u_bob'] } },
  ];
  it('is its own, else the nearest folder’s, else only me', () => {
    expect(effective(rules, 'Photos/a.jpg')).toEqual({ audience: 'hub', from: 'Photos/' });
    expect(effective(rules, 'Photos/Private/x/y.jpg')).toEqual({
      audience: 'me',
      from: 'Photos/Private/',
    });
    expect(effective(rules, 'Photos/Private/ok.jpg')).toEqual({
      audience: { users: ['u_bob'] },
      from: 'Photos/Private/ok.jpg',
    });
    expect(effective(rules, 'Photos/')).toEqual({ audience: 'hub', from: 'Photos/' });
    expect(effective(rules, 'Music/song.mp3')).toEqual({ audience: 'me', from: null });
  });
});

describe('display text', () => {
  it('rounds sizes and names availability like the CLI', () => {
    expect(size(999)).toBe('999 B');
    expect(size(1_500)).toBe('1.5 KB');
    expect(size(250_000_000)).toBe('250 MB');
    expect(seenLabel('now')).toBe('Online');
    expect(seenLabel('older')).toBe('Offline for over a month');
  });
});

describe('computer names', () => {
  it('adds the owner only when the device name lacks it', () => {
    expect(computerName('Maya', 'iMac')).toBe('Maya’s iMac');
    expect(computerName('Maya', 'Maya’s iMac')).toBe('Maya’s iMac');
    expect(computerName('Maya', 'maya-laptop')).toBe('maya-laptop');
    expect(computerName('Maya Lindqvist', 'Maya’s iMac')).toBe('Maya’s iMac');
    expect(computerName('Maya Lindqvist', 'iMac')).toBe('Maya Lindqvist’s iMac');
    expect(computerName('Al', 'Alpha')).toBe('Al’s Alpha');
  });
});

describe('names cut in the middle', () => {
  it('keeps the extension and a little before it', () => {
    expect(splitName('Breaking.Bad.S01E01.Pilot.1080p.BluRay.x264-GROUPNAME.mkv')).toEqual([
      'Breaking.Bad.S01E01.Pilot.1080p.BluRay.x264',
      '-GROUPNAME.mkv',
    ]);
    expect(splitName('a_very_long_name_without_any_extension_at_all')).toEqual([
      'a_very_long_name_without_any_extens',
      'ion_at_all',
    ]);
  });

  it('never splits more than half, or inside an emoji', () => {
    expect(splitName('ab.mkv')).toEqual(['ab.', 'mkv']);
    expect(splitName('😀😀😀😀')).toEqual(['😀😀', '😀😀']);
    expect(splitName('')).toEqual(['', '']);
  });
});
