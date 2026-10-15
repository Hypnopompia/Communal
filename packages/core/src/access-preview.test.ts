import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { explainAccess, previewRule, type PeopleOnHub } from './access-preview.js';
import { IndexStore } from './index/store.js';

let dir: string;
let store: IndexStore;
const H = 'h_home';

const people: PeopleOnHub = {
  hubName: 'Hunter family',
  connections: new Map([
    ['u_ann', 'Ann'],
    ['u_ben', 'Ben'],
    ['u_cat', 'Cat'],
  ]),
  groups: new Map([['g_kids', { name: 'Kids', members: ['u_ben', 'u_cat', 'u_stranger'] }]]),
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'communal-preview-'));
  store = new IndexStore(join(dir, 'index.db'));
  store.addShare('Photos', '/x/Photos', [H]);
  store.addShare('Notes', '/x/Notes', []);
  const file = (share: string, rel: string, size = 100) =>
    store.upsertFile({ share, rel, size, mtime: 1, mime: 'image/png', kind: 'image' });
  file('Photos', 'beach.png');
  file('Photos', '2024/a.png', 200);
  file('Photos', '2024/b.png', 300);
  file('Photos', '2024/private/c.png');
  file('Notes', 'todo.txt');
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('previewRule', () => {
  it('says which files would go from only you to everyone on the hub', () => {
    const p = previewRule(store, H, 'Photos/', 'hub', people);
    expect(p).toMatchObject({ listed: true, files: 4, bytes: 700, widens: true });
    expect(p.changes).toEqual([
      expect.objectContaining({
        from: { audience: 'me', label: 'only you', people: 0 },
        to: { audience: 'hub', label: 'everyone on Hunter family', people: null },
        files: 4,
        widens: true,
      }),
    ]);
    expect(p.summary).toContain('4 files');
    expect(p.summary).toContain('can’t see these files now');
    // Nothing changed.
    expect(store.rules(H)).toEqual([]);
  });

  it('leaves out files a nearer rule already decides', () => {
    store.setRule(H, 'Photos/2024/private/', 'me');
    const p = previewRule(store, H, 'Photos/', 'hub', people);
    expect(p.files).toBe(3);
    expect(p.changes[0]!.examples).not.toContain('Photos/2024/private/c.png');
  });

  it('names people and counts only connections, groups included', () => {
    const p = previewRule(
      store,
      H,
      'Photos/2024/',
      { users: ['u_ann'], groups: ['g_kids'] },
      people,
    );
    // Ann, plus Ben and Cat from Kids; the stranger isn't a connection, so can't see it.
    expect(p.changes[0]!.to).toMatchObject({
      label: 'Ann and the group Kids (3 people)',
      people: 3,
    });
    expect(p.widens).toBe(true);
  });

  it('knows narrowing and swapping people', () => {
    store.setRule(H, 'Photos/', 'hub');
    const narrower = previewRule(store, H, 'Photos/', { users: ['u_ann'] }, people);
    expect(narrower).toMatchObject({ files: 4, widens: false });

    store.setRule(H, 'Photos/', { users: ['u_ann', 'u_ben'] });
    expect(previewRule(store, H, 'Photos/', { users: ['u_ann'] }, people).widens).toBe(false);
    expect(previewRule(store, H, 'Photos/', { users: ['u_cat'] }, people).widens).toBe(true);
    // Clearing the rule: back to only you.
    const cleared = previewRule(store, H, 'Photos/', null, people);
    expect(cleared.changes[0]!.to.label).toBe('only you');
    expect(cleared.widens).toBe(false);
  });

  it('says when nothing would change', () => {
    store.setRule(H, 'Photos/', 'hub');
    const p = previewRule(store, H, 'Photos/', 'hub', people);
    expect(p).toMatchObject({ files: 0, changes: [], widens: false });
    expect(p.summary).toMatch(/^Nothing changes/);
  });

  it('previews a single file', () => {
    const p = previewRule(store, H, 'Photos/beach.png', 'hub', people);
    expect(p.files).toBe(1);
    expect(p.changes[0]!.examples).toEqual(['Photos/beach.png']);
  });

  it("doesn't call a share that isn't on the hub a widening, and says why", () => {
    const p = previewRule(store, H, 'Notes/', 'hub', people);
    expect(p).toMatchObject({ listed: false, files: 1, widens: false });
    expect(p.summary).toContain('isn’t listed on Hunter family');
  });
});

describe('explainAccess', () => {
  it('says only you when no rule covers a path', () => {
    const e = explainAccess(store, H, 'Photos/beach.png', people);
    expect(e).toMatchObject({ listed: true, rule_path: null, inherited: false });
    expect(e.audience.label).toBe('only you');
    expect(e.summary).toBe('On Hunter family, no rule covers it, so only you can see it.');
  });

  it('names the folder a rule is inherited from, and its people', () => {
    store.setRule(H, 'Photos/', 'hub');
    store.setRule(H, 'Photos/2024/', { groups: ['g_kids'] });
    const e = explainAccess(store, H, 'Photos/2024/private/c.png', people);
    expect(e).toMatchObject({ rule_path: 'Photos/2024/', inherited: true });
    expect(e.audience).toMatchObject({ label: 'the group Kids (2 people)', people: 2 });
    expect(e.summary).toContain('follows the rule on Photos/2024/');
    expect(explainAccess(store, H, 'Photos/', people)).toMatchObject({
      rule_path: 'Photos/',
      inherited: false,
      audience: { audience: 'hub' },
    });
  });

  it('says nobody on the hub sees a share that isn’t listed there', () => {
    store.setRule(H, 'Notes/', 'hub');
    const e = explainAccess(store, H, 'Notes/todo.txt', people);
    expect(e.listed).toBe(false);
    expect(e.summary).toContain('isn’t listed on Hunter family');
  });
});
