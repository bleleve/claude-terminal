/**
 * The chat's Tickets tab, wired to the real IssueLinkService and
 * IssueTrackerService over the Linear fixture. And the @tickets mention
 * source, whose chip becomes the ticket's content when the message is sent.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { setImmediate: realImmediate } = require('timers');

const { createTicketsTab } = require('../../src/renderer/ui/components/chat/ticketsTab');
const issueSource = require('../../src/renderer/services/mention-sources/issue.source');
const { t } = require('../../src/renderer/i18n');
const { createIssueTrackerService } = require('../../src/main/services/IssueTrackerService');
const { createIssueLinkService } = require('../../src/main/services/IssueLinkService');
const { describeTrackers } = require('../../src/main/issue-trackers/_registry');
const linear = require('../../src/main/issue-trackers/linear.tracker');
const fixture = require('../issue-trackers/fixtures/linear.fixture');

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => realImmediate(r));
};

/**
 * Wait until `check` holds. These tests drive real file I/O (the link store is
 * read and rewritten on every change), so a fixed number of turns is a guess;
 * a condition is not. Gives up after 2 s and lets the assertion say why.
 */
async function waitFor(check) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    try {
      if (check()) return;
    } catch { /* not there yet */ }
    await new Promise((r) => realImmediate(r));
  }
}

let dir;
let api;
let changedListeners;
let conn;

function wrap(fn, key) {
  return jest.fn(async (...args) => {
    try {
      const value = await fn(...args);
      return key ? { ok: true, [key]: value } : { ok: true, ...value };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || 'PROVIDER' };
    }
  });
}

beforeEach(async () => {
  fixture.reset();
  issueSource._reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-chat-tickets-'));
  const secrets = new Map();
  const trackers = createIssueTrackerService({
    storePath: path.join(dir, 'issue-trackers.json'),
    secrets: { get: async (a) => secrets.get(a) ?? null, set: async (a, v) => { secrets.set(a, v); }, delete: async (a) => secrets.delete(a) },
    registry: { get: (id) => (id === 'linear' ? linear : null), describe: () => describeTrackers([linear]) },
    fetch: fixture.fetch,
  });
  changedListeners = [];
  const links = createIssueLinkService({
    storePath: path.join(dir, 'issue-links.json'),
    broadcast: (sessionKey) => changedListeners.forEach((fn) => fn({ sessionKey })),
  });
  conn = await trackers.connect('linear', fixture.secret);
  api = {
    dialog: { openExternal: jest.fn() },
    issueTrackers: {
      providers: wrap(async () => trackers.listProviders(), 'providers'),
      connections: wrap(() => trackers.listConnections(), 'connections'),
      metadata: wrap((id) => trackers.metadata(id), 'metadata'),
      listIssues: wrap((id, q, c) => trackers.listIssues(id, q, c)),
      getIssue: wrap((id, key) => trackers.getIssue(id, key), 'issue'),
      updateIssue: wrap((id, key, patch) => trackers.updateIssue(id, key, patch), 'issue'),
    },
    issueLinks: {
      get: wrap((k) => links.get(k), 'links'),
      link: wrap((k, l, o) => links.link(k, l, o || {}), 'links'),
      dismiss: wrap((k, refs) => links.dismiss(k, refs), 'links'),
      confirm: wrap((k, refs) => links.confirm(k, refs), 'links'),
      suggest: (k, l) => links.suggest(k, l),
      rekey: wrap((a, b) => links.rekey(a, b), 'moved'),
      copy: wrap((a, b) => links.copy(a, b), 'copied'),
      onChanged: (fn) => {
        changedListeners.push(fn);
        return () => { changedListeners = changedListeners.filter((x) => x !== fn); };
      },
    },
  };
  global.window.electron_api = { ...(global.window.electron_api || {}), issueTrackers: api.issueTrackers };
  document.body.innerHTML = '<button class="tab" hidden><span class="badge" hidden></span></button><div class="panel"></div>';
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

function makeTab(over = {}) {
  const panelEl = document.querySelector('.panel');
  const tabBtn = document.querySelector('.tab');
  return createTicketsTab({
    api,
    panelEl,
    tabBtn,
    badgeEl: tabBtn.querySelector('.badge'),
    initialKey: 'tab:1',
    getProjectId: () => 'p1',
    onAvailable: () => { tabBtn.hidden = false; },
    showToast: jest.fn(),
    ...over,
  });
}

const panel = () => document.querySelector('.panel');
const badge = () => document.querySelector('.badge');
const rows = () => [...panel().querySelectorAll('.session-tickets-row')].map((r) => r.dataset.ref);

test('the tab only appears once a tracker is connected', async () => {
  api.issueTrackers.connections.mockResolvedValueOnce({ ok: true, connections: [] });
  const tab = makeTab();
  await tab.probe();
  expect(document.querySelector('.tab').hidden).toBe(true);
  tab.destroy();
});

test('linking from the search shows the ticket with its live status and fills the badge', async () => {
  const tab = makeTab();
  await tab.probe();
  tab.show();
  expect(panel().querySelector('.session-tickets-empty')).not.toBeNull();

  panel().querySelector('[data-action="toggle-search"]').click();
  const input = panel().querySelector('.session-tickets-search-input');
  expect(document.activeElement).toBe(input);
  input.value = 'pruner';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  await flush();
  await waitFor(() => panel().querySelector('.session-tickets-result[data-first]'));
  panel().querySelector('.session-tickets-result[data-first]').click();
  await waitFor(() => rows().length === 1 && panel().querySelector('.session-tickets-state').textContent.includes('In Progress'));

  expect(rows()).toEqual(['linear:ENG-139']);
  expect(badge().textContent).toBe('1');
  expect(badge().hidden).toBe(false);
  expect(panel().querySelector('.session-tickets-state').textContent).toContain('In Progress');
  expect(panel().querySelector('.session-tickets-source').textContent).toBe(t('chat.tickets.sourceManual'));
  tab.destroy();
});

test('changing the state from the tab writes it to the tracker', async () => {
  const tab = makeTab();
  await tab.probe();
  await tab.linkTicket({ ref: 'linear:ENG-142', connectionId: conn.id, title: 'Session tickets tab' }, 'start');
  tab.show();
  await waitFor(() => panel().querySelector('[data-action="state"]'));
  panel().querySelector('[data-action="state"]').click();
  await waitFor(() => panel().querySelector('[data-action="set-state"]'));
  [...panel().querySelectorAll('[data-action="set-state"]')].find((b) => b.dataset.state === 's-eng-review').click();
  await waitFor(() => panel().querySelector('.session-tickets-state').textContent.includes('In Review'));
  expect(api.issueTrackers.updateIssue).toHaveBeenCalledWith(conn.id, 'ENG-142', { stateId: 's-eng-review' });
  expect(panel().querySelector('.session-tickets-state').textContent).toContain('In Review');
  tab.destroy();
});

test('unlinking dismisses the ticket for this session', async () => {
  const tab = makeTab();
  await tab.probe();
  await tab.linkTicket({ ref: 'linear:ENG-142', connectionId: conn.id, title: 'x' }, 'manual');
  tab.show();
  await waitFor(() => panel().querySelector('[data-action="unlink"]'));
  panel().querySelector('[data-action="unlink"]').click();
  await waitFor(() => rows().length === 0);
  expect(rows()).toEqual([]);
  expect(badge().hidden).toBe(true);
  expect((await api.issueLinks.get('tab:1')).links[0].status).toBe('dismissed');
  tab.destroy();
});

test('the provisional tab key moves to the CLI session id; a fork copies', async () => {
  const tab = makeTab();
  await tab.probe();
  await tab.linkTicket({ ref: 'linear:ENG-142', connectionId: conn.id, title: 'x' }, 'manual');
  await tab.onSessionId('sess-A');
  expect(tab.getKey()).toBe('sess-A');
  expect((await api.issueLinks.get('tab:1')).links).toEqual([]);
  expect((await api.issueLinks.get('sess-A')).links.map((l) => l.ref)).toEqual(['linear:ENG-142']);

  await tab.onSessionId('sess-B'); // /clear or fork: the parent keeps its links
  expect((await api.issueLinks.get('sess-A')).links).toHaveLength(1);
  expect((await api.issueLinks.get('sess-B')).links).toHaveLength(1);
  expect(badge().textContent).toBe('1');
  tab.destroy();
});

test('a change broadcast for this session refreshes the tab', async () => {
  const tab = makeTab();
  await tab.probe();
  tab.show();
  await api.issueLinks.link('tab:1', { ref: 'linear:OPS-12', connectionId: conn.id, title: 'Rotate' });
  await waitFor(() => rows().length === 1);
  expect(rows()).toEqual(['linear:OPS-12']);
  tab.destroy();
  await api.issueLinks.link('tab:1', { ref: 'linear:ENG-1', connectionId: conn.id, title: 'later' });
  await flush();
  expect(rows()).toEqual(['linear:OPS-12']); // destroyed: no longer listening
});

describe('suggestions', () => {
  test('each new suggestion is announced once, and listed in the tab until answered', async () => {
    const tab = makeTab();
    const announced = [];
    tab.onSuggestions((list) => announced.push(list.map((l) => l.ref)));
    await tab.probe();
    tab.show();
    await api.issueLinks.suggest('tab:1', { ref: 'linear:ENG-155', connectionId: conn.id, title: 'Shared prefixes', source: 'tool', evidence: 'save_issue (create)' });
    await waitFor(() => announced.length === 1 && panel().querySelector('.session-tickets-row.suggested'));
    expect(announced).toEqual([['linear:ENG-155']]);
    expect(badge().textContent).toBe('0 +1');
    expect(badge().classList.contains('has-suggestions')).toBe(true);

    // Another change for the session does not announce the same suggestion twice.
    await api.issueLinks.link('tab:1', { ref: 'linear:OPS-12', connectionId: conn.id, title: 'Rotate' });
    await waitFor(() => rows().includes('linear:OPS-12'));
    expect(announced).toHaveLength(1);

    panel().querySelector('[data-action="confirm"]').click();
    await waitFor(() => !panel().querySelector('.session-tickets-row.suggested'));
    expect(rows().sort()).toEqual(['linear:ENG-155', 'linear:OPS-12']);
    expect(badge().textContent).toBe('2');
    tab.destroy();
  });

  test('the card\'s answers go through the tab', async () => {
    const tab = makeTab();
    await tab.probe();
    await api.issueLinks.suggest('tab:1', { ref: 'linear:ENG-142', connectionId: conn.id, source: 'branch' });
    await api.issueLinks.suggest('tab:1', { ref: 'linear:ENG-139', connectionId: conn.id, source: 'prompt' });
    await tab.confirm(['linear:ENG-142']);
    await tab.dismiss(['linear:ENG-139']);
    const byRef = Object.fromEntries(tab.getLinks().map((l) => [l.ref, l.status]));
    expect(byRef).toEqual({ 'linear:ENG-142': 'linked', 'linear:ENG-139': 'dismissed' });
    tab.destroy();
  });
});

describe('@tickets mention source', () => {
  test('lists open tickets, cached, labelled by key', async () => {
    const items = await issueSource.getData();
    expect(items.map((i) => i.issue.key)).toContain('ENG-142');
    expect(items.some((i) => i.issue.state.category === 'done')).toBe(false);
    await issueSource.getData();
    expect(api.issueTrackers.listIssues).toHaveBeenCalledTimes(1);
    const item = items.find((i) => i.issue.key === 'ENG-142');
    expect(issueSource.render(item)).toMatchObject({ label: 'ENG-142  Session tickets tab', color: '#f2c94c' });
    expect(issueSource.getChipData(item)).toMatchObject({ type: 'tickets', data: { chipLabel: '@ENG-142', ref: 'linear:ENG-142' } });
  });

  test('resolve fetches the ticket for Claude and links it to the session', async () => {
    const linkTicket = jest.fn();
    const text = await issueSource.resolve(
      { ref: 'linear:ENG-142', key: 'ENG-142', title: 'Session tickets tab', connectionId: conn.id },
      { linkTicket },
    );
    expect(linkTicket).toHaveBeenCalledWith({ ref: 'linear:ENG-142', connectionId: conn.id, title: 'Session tickets tab' }, 'mention');
    expect(text).toMatch(/^# ENG-142: Session tickets tab\nStatus: In Progress \| Priority: 1 \| Assignee: Ada Lovelace/);
    expect(text).toContain('## Why');
    expect(text).toContain('## Latest comments');
    expect(text).toContain('## Sub-issues\n- ENG-151 [Todo] Persist ticket filters per screen');
  });

  test('a ticket that cannot be loaded still sends something useful', async () => {
    const text = await issueSource.resolve({ ref: 'linear:ENG-99999', key: 'ENG-99999', title: 'Gone', connectionId: conn.id }, {});
    expect(text).toMatch(/^# ENG-99999: Gone\n\[Could not load the ticket:/);
  });
});
