import type { Seen } from './api';

export function size(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let u = -1;
  do {
    v /= 1000;
    u++;
  } while (v >= 1000 && u < units.length - 1);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

export const rate = (bytesPerSecond: number) => `${size(bytesPerSecond)}/s`;

export function duration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function ago(unixSeconds: number): string {
  const d = Date.now() / 1000 - unixSeconds;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 7 * 86400) return `${Math.floor(d / 86400)} days ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

export const date = (unixSeconds: number) =>
  new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

/** Same wording as `seenLabel()` in core (ADR 0015). */
export function seenLabel(seen: Seen): string {
  return {
    now: 'Online',
    today: 'Offline, seen today',
    week: 'Offline, seen this week',
    month: 'Offline, seen this month',
    older: 'Offline for over a month',
  }[seen];
}

/** What to call a hub: the name its admin gave it, else its host name. */
export function hubName(hub: { url: string; name?: string | null }): string {
  if (hub.name) return hub.name;
  try {
    return new URL(hub.url).hostname;
  } catch {
    return hub.url;
  }
}

export const baseName = (p: string) => p.replace(/\/$/, '').split('/').pop() ?? p;
export const dirName = (p: string) => p.replace(/\/$/, '').split('/').slice(0, -1).join('/');

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Turns what a person types ("hub.example.com") into the hub's WebSocket URL. */
export function hubUrl(input: string): string {
  let s = input.trim();
  if (!/^wss?:\/\//i.test(s)) s = `wss://${s.replace(/^https?:\/\//i, '')}`;
  const u = new URL(s);
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/v1';
  return u.toString();
}

/**
 * "Maya’s iMac" from an owner and a device name, without doubling the owner when the device
 * name already starts with it ("Maya’s iMac", "maya-laptop").
 */
export function computerName(owner: string, device: string): string {
  const o = owner.trim().toLowerCase();
  return o && device.trim().toLowerCase().startsWith(o) ? device : `${owner}’s ${device}`;
}
