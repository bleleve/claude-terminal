'use strict';
/**
 * Issue tracker connections: which providers the user connected, to which
 * workspace, and a client for each.
 *
 * A connection is a provider (an adapter from `src/main/issue-trackers/`) plus
 * a credential. The credential lives in the OS credential store, under one
 * keychain account per connection; `~/.claude-terminal/issue-trackers.json`
 * holds the rest (workspace, user, date) and never a secret. Nothing here
 * returns a key to the renderer, only a masked form.
 *
 * Design note: `design/issue-trackers.md`.
 */

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const { dataDir } = require('../utils/paths');
const registry = require('../issue-trackers/_registry');
const { trackerError } = require('../issue-trackers/_contract');
const { sanitizePerson } = require('../../shared/issue-trackers');

const STORE_FILE = path.join(dataDir, 'issue-trackers.json');
const STORE_VERSION = 1;
const KEYCHAIN_SERVICE = 'claude-terminal';

const keychainAccount = (connectionId) => `issue-tracker:${connectionId}`;

/** Show enough of a key to recognise it, never the whole thing. */
function maskKey(key) {
  if (!key) return null;
  const str = String(key);
  if (str.length <= 12) return '••••';
  return `${str.slice(0, 8)}••••${str.slice(-4)}`;
}

/** The credential store, loaded lazily so nothing native loads until it is used. */
const keytarSecrets = {
  get: (account) => require('keytar').getPassword(KEYCHAIN_SERVICE, account),
  set: (account, value) => require('keytar').setPassword(KEYCHAIN_SERVICE, account, value),
  delete: (account) => require('keytar').deletePassword(KEYCHAIN_SERVICE, account),
};

function httpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

function cleanWorkspace(raw) {
  const id = typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  const name = typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : null;
  if (!id || !name) return null;
  return { id, name, url: httpsUrl(raw.url) };
}

/**
 * @param {object} deps
 * @param {string} deps.storePath
 * @param {{ get: Function, set: Function, delete: Function }} deps.secrets
 * @param {{ get: Function, describe: Function }} deps.registry
 * @param {typeof fetch} deps.fetch
 * @param {() => string} [deps.now]
 */
function createIssueTrackerService({ storePath, secrets, registry: trackers, fetch, now = () => new Date().toISOString() }) {
  const clients = new Map();
  let queue = Promise.resolve();

  /** Store mutations run one after the other: each is a whole-file read-modify-write. */
  function exclusive(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  /**
   * Absent is a fresh install. Unreadable throws: answering it with an empty
   * list would make the next connect rewrite the file with that one entry,
   * and every other connection's key would be orphaned in the keychain.
   */
  async function readStore() {
    let raw;
    try {
      raw = await fsp.readFile(storePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { version: STORE_VERSION, connections: [] };
      throw err;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Refusing to modify ${path.basename(storePath)}: it is not valid JSON (${err.message})`, { cause: err });
    }
    if (!parsed || !Array.isArray(parsed.connections)) {
      throw new Error(`Refusing to modify ${path.basename(storePath)}: it has no connections list`);
    }
    return parsed;
  }

  async function writeStore(store) {
    await fsp.mkdir(path.dirname(storePath), { recursive: true });
    const tmp = `${storePath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
    await fsp.rename(tmp, storePath);
  }

  function providerOf(id) {
    const def = trackers.get(id);
    if (!def) throw trackerError('PROVIDER', `Unknown issue tracker: ${id}`);
    return def;
  }

  async function publicConnection(entry) {
    // A credential store that cannot be read (or keytar failing to load) costs the mask, not the list.
    const maskedKey = await Promise.resolve().then(() => secrets.get(keychainAccount(entry.id))).then(maskKey, () => null);
    const def = trackers.get(entry.provider);
    return {
      id: entry.id,
      provider: entry.provider,
      providerName: def ? def.name : entry.provider,
      workspace: entry.workspace,
      user: entry.user,
      connectedAt: entry.connectedAt,
      maskedKey,
      available: !!def,
    };
  }

  /** Ask the provider who the key belongs to: the only proof that it works. */
  async function identify(def, secret) {
    const me = await def.createClient({ secret, fetch }).whoAmI();
    const user = sanitizePerson(me?.user);
    const workspace = cleanWorkspace(me?.workspace);
    if (!user || !workspace) throw trackerError('PROVIDER', `${def.name} did not say which account this key belongs to`);
    return { user, workspace };
  }

  return {
    listProviders() {
      return trackers.describe();
    },

    async listConnections() {
      const store = await readStore();
      return Promise.all(store.connections.map(publicConnection));
    },

    /**
     * Check a key with the provider, then store it. Connecting a workspace
     * that is already connected replaces its key instead of adding a twin.
     */
    connect(providerId, secret) {
      return exclusive(async () => {
        const def = providerOf(providerId);
        const key = String(secret || '').trim();
        if (!key) throw trackerError('AUTH', 'The API key is empty');
        const { user, workspace } = await identify(def, key);

        const store = await readStore();
        const existing = store.connections.find((c) => c.provider === def.id && c.workspace?.id === workspace.id);
        const entry = {
          id: existing ? existing.id : `${def.id}-${crypto.randomBytes(6).toString('hex')}`,
          provider: def.id,
          workspace,
          user,
          connectedAt: existing ? existing.connectedAt : now(),
        };

        await secrets.set(keychainAccount(entry.id), key);
        store.version = STORE_VERSION;
        store.connections = existing
          ? store.connections.map((c) => (c.id === entry.id ? entry : c))
          : [...store.connections, entry];
        try {
          await writeStore(store);
        } catch (err) {
          if (!existing) await secrets.delete(keychainAccount(entry.id)).catch(() => {});
          throw err;
        }
        clients.delete(entry.id);
        return publicConnection(entry);
      });
    },

    disconnect(connectionId) {
      return exclusive(async () => {
        const store = await readStore();
        const remaining = store.connections.filter((c) => c.id !== connectionId);
        if (remaining.length !== store.connections.length) {
          store.connections = remaining;
          await writeStore(store);
        }
        clients.delete(connectionId);
        await secrets.delete(keychainAccount(connectionId)).catch(() => {});
      });
    },

    /** Re-check a stored key and refresh the names it reports. */
    test(connectionId) {
      return exclusive(async () => {
        const store = await readStore();
        const entry = store.connections.find((c) => c.id === connectionId);
        if (!entry) throw trackerError('NOT_FOUND', `No connection ${connectionId}`);
        const secret = await secrets.get(keychainAccount(connectionId));
        if (!secret) throw trackerError('AUTH', 'No API key is stored for this connection');
        const { user, workspace } = await identify(providerOf(entry.provider), secret);
        if (workspace.id !== entry.workspace.id) {
          throw trackerError('AUTH', `This key now belongs to ${workspace.name}, not ${entry.workspace.name}`);
        }
        Object.assign(entry, { user, workspace });
        await writeStore(store);
        return publicConnection(entry);
      });
    },

    /** The adapter client for a connection, created once and reused. */
    async client(connectionId) {
      if (clients.has(connectionId)) return clients.get(connectionId);
      const store = await readStore();
      const entry = store.connections.find((c) => c.id === connectionId);
      if (!entry) throw trackerError('NOT_FOUND', `No connection ${connectionId}`);
      const secret = await secrets.get(keychainAccount(connectionId));
      if (!secret) throw trackerError('AUTH', 'No API key is stored for this connection');
      const client = providerOf(entry.provider).createClient({ secret, fetch });
      clients.set(connectionId, client);
      return client;
    },
  };
}

const service = createIssueTrackerService({
  storePath: STORE_FILE,
  secrets: keytarSecrets,
  registry,
  // Read at call time, so the global is whatever it is when the request goes out.
  fetch: (...args) => globalThis.fetch(...args),
});

module.exports = service;
module.exports.createIssueTrackerService = createIssueTrackerService;
module.exports.maskKey = maskKey;
