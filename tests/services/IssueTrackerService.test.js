/**
 * Issue tracker connections. What matters here is where the key goes: into the
 * credential store, never into issue-trackers.json and never back out to the
 * renderer. And, like every JSON store in the app, an unreadable file is left
 * alone rather than answered with an empty list.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createIssueTrackerService, maskKey } = require('../../src/main/services/IssueTrackerService');
const { describeTrackers } = require('../../src/main/issue-trackers/_registry');
const linear = require('../../src/main/issue-trackers/linear.tracker');
const fixture = require('../issue-trackers/fixtures/linear.fixture');
const fake = require('../issue-trackers/fake.tracker');

function memorySecrets() {
  const map = new Map();
  return {
    map,
    get: async (account) => map.get(account) ?? null,
    set: async (account, value) => { map.set(account, value); },
    delete: async (account) => map.delete(account),
  };
}

const registry = {
  get: (id) => ({ linear, fake })[id] || null,
  describe: () => describeTrackers([linear, fake]),
};

let dir;
let storePath;
let secrets;
let fetch;
let service;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-issue-trackers-'));
  storePath = path.join(dir, 'issue-trackers.json');
  secrets = memorySecrets();
  fetch = jest.fn(fixture.fetch);
  service = createIssueTrackerService({ storePath, secrets, registry, fetch, now: () => '2026-10-09T09:00:00.000Z' });
  fixture.reset();
});

afterEach(() => {
  try { fs.chmodSync(dir, 0o700); } catch { /* already writable */ }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const readStore = () => JSON.parse(fs.readFileSync(storePath, 'utf8'));

describe('connect', () => {
  test('checks the key with the provider and records who it belongs to', async () => {
    const conn = await service.connect('linear', `  ${fixture.secret}\n`);
    expect(conn).toMatchObject({
      provider: 'linear',
      providerName: 'Linear',
      workspace: { id: 'org-acme', name: 'Acme', url: 'https://linear.app/acme' },
      user: { id: 'u-ada', name: 'Ada Lovelace', avatarUrl: null },
      connectedAt: '2026-10-09T09:00:00.000Z',
      available: true,
    });
    expect(conn.id).toMatch(/^linear-[0-9a-f]{12}$/);
    expect(secrets.map.get(`issue-tracker:${conn.id}`)).toBe(fixture.secret);
  });

  test('the key never reaches the file, and only a masked form reaches the caller', async () => {
    const conn = await service.connect('linear', fixture.secret);
    expect(fs.readFileSync(storePath, 'utf8')).not.toContain(fixture.secret);
    expect(JSON.stringify(conn)).not.toContain(fixture.secret);
    const [listed] = await service.listConnections();
    expect(JSON.stringify(listed)).not.toContain(fixture.secret);
    expect(listed.maskedKey).toBe(maskKey(fixture.secret));
  });

  test('a rejected key stores nothing', async () => {
    await expect(service.connect('linear', 'lin_api_wrong')).rejects.toMatchObject({ code: 'AUTH' });
    expect(fs.existsSync(storePath)).toBe(false);
    expect(secrets.map.size).toBe(0);
  });

  test('an empty key is refused without a request', async () => {
    await expect(service.connect('linear', '   ')).rejects.toMatchObject({ code: 'AUTH' });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('an unknown provider is refused', async () => {
    await expect(service.connect('jira', 'x')).rejects.toMatchObject({ code: 'PROVIDER' });
  });

  test('reconnecting the same workspace replaces the key instead of adding a twin', async () => {
    const first = await service.connect('linear', fixture.secret);
    const second = await service.connect('linear', fixture.secret);
    expect(second.id).toBe(first.id);
    expect(readStore().connections).toHaveLength(1);
  });

  test('concurrent connects do not lose each other', async () => {
    const [a, b] = await Promise.all([service.connect('linear', fixture.secret), service.connect('fake', 'fake-secret')]);
    expect(readStore().connections.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  test('an unreadable store is left alone and no key is stored', async () => {
    fs.writeFileSync(storePath, '{"version":1,"connections":[{"id":"linear-1"');
    await expect(service.connect('linear', fixture.secret)).rejects.toThrow(/Refusing to modify issue-trackers\.json/);
    expect(fs.readFileSync(storePath, 'utf8')).toBe('{"version":1,"connections":[{"id":"linear-1"');
    expect(secrets.map.size).toBe(0);
  });

  (process.platform === 'win32' ? test.skip : test)('a failed write takes the new key back out of the credential store', async () => {
    fs.chmodSync(dir, 0o500);
    await expect(service.connect('linear', fixture.secret)).rejects.toThrow();
    expect(secrets.map.size).toBe(0);
  });
});

describe('disconnect', () => {
  test('removes the connection and its key', async () => {
    const conn = await service.connect('linear', fixture.secret);
    await service.disconnect(conn.id);
    expect(readStore().connections).toEqual([]);
    expect(secrets.map.size).toBe(0);
  });

  test('an unknown id is a no-op', async () => {
    const conn = await service.connect('linear', fixture.secret);
    await service.disconnect('linear-unknown');
    expect(readStore().connections.map((c) => c.id)).toEqual([conn.id]);
  });
});

describe('test', () => {
  test('re-checks the stored key', async () => {
    const conn = await service.connect('linear', fixture.secret);
    await expect(service.test(conn.id)).resolves.toMatchObject({ id: conn.id, workspace: { name: 'Acme' } });
  });

  test('a key removed from the credential store is reported as AUTH', async () => {
    const conn = await service.connect('linear', fixture.secret);
    secrets.map.clear();
    await expect(service.test(conn.id)).rejects.toMatchObject({ code: 'AUTH' });
  });

  test('a key that now belongs to another workspace is refused', async () => {
    const conn = await service.connect('linear', fixture.secret);
    const store = readStore();
    store.connections[0].workspace.id = 'org-other';
    fs.writeFileSync(storePath, JSON.stringify(store));
    await expect(service.test(conn.id)).rejects.toMatchObject({ code: 'AUTH' });
  });
});

describe('client', () => {
  test('is built once per connection and talks to the provider', async () => {
    const conn = await service.connect('linear', fixture.secret);
    const client = await service.client(conn.id);
    expect(await service.client(conn.id)).toBe(client);
    const me = await client.whoAmI();
    expect(me.workspace.name).toBe('Acme');
  });

  test('an unknown connection is NOT_FOUND', async () => {
    await expect(service.client('linear-unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('listProviders and listConnections', () => {
  test('providers are plain data', () => {
    expect(service.listProviders().map((p) => p.id)).toEqual(['linear', 'fake']);
  });

  test('no file means no connections', async () => {
    await expect(service.listConnections()).resolves.toEqual([]);
  });

  test('a connection whose adapter is gone is listed as unavailable', async () => {
    fs.writeFileSync(storePath, JSON.stringify({
      version: 1,
      connections: [{ id: 'jira-1', provider: 'jira', workspace: { id: 'w', name: 'W', url: null }, user: { id: 'u', name: 'U', avatarUrl: null } }],
    }));
    const [conn] = await service.listConnections();
    expect(conn).toMatchObject({ id: 'jira-1', providerName: 'jira', available: false });
  });
});

test('maskKey shows the start and the end only', () => {
  expect(maskKey('lin_api_abcdefghijklmnop1234')).toBe('lin_api_••••1234');
  expect(maskKey('short')).toBe('••••');
  expect(maskKey(null)).toBeNull();
});
