/** Desktop-only preferences, kept next to the keys in userData (`prefs.json`). */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Prefs {
  /** Serve the API on the local socket for the CLI and AI agents (ADR 0017). Off by default. */
  control: boolean;
}

const DEFAULTS: Prefs = { control: false };

export class PrefsFile {
  private readonly file: string;
  value: Prefs;

  constructor(dir: string) {
    this.file = join(dir, 'prefs.json');
    try {
      this.value = {
        ...DEFAULTS,
        ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Prefs>),
      };
    } catch {
      this.value = { ...DEFAULTS };
    }
  }

  set(change: Partial<Prefs>) {
    this.value = { ...this.value, ...change };
    writeFileSync(this.file + '.tmp', JSON.stringify(this.value, null, 2), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }
}
