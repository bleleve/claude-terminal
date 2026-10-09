/**
 * The Tickets screen, wired to the real IssueTrackerService and Linear adapter
 * over the fixture's invented workspace: what the panel asks for is answered
 * the way main would answer it. Only the markdown renderer is stubbed, since
 * the detail pane's job is to hand it text, not to render mermaid.
 */

'use strict';

jest.mock('../../src/renderer/services/MarkdownRenderer', () => ({
  render: (md) => `<p class="md">${String(md).replace(/</g, '&lt;')}</p>`,
  postProcess: jest.fn(),
  attachInteractivity: jest.fn(),
}));

const mockSettings = { ticketsView: undefined };
jest.mock('../../src/renderer/state/settings.state', () => ({
  getSetting: (key) => mockSettings[key],
  setSetting: jest.fn((key, value) => { mockSettings[key] = value; }),
}));

const fs = require('fs');
// jsdom has no setImmediate global, and the fake clock must not own this one.
const { setImmediate: realImmediate } = require('timers');
const os = require('os');
const path = require('path');
const { t } = require('../../src/renderer/i18n');
const { setSetting } = require('../../src/renderer/state/settings.state');
const panel = require('../../src/renderer/ui/panels/IssuesPanel');
const { createIssueTrackerService } = require('../../src/main/services/IssueTrackerService');
const { describeTrackers } = require('../../src/main/issue-trackers/_registry');
const linear = require('../../src/main/issue-trackers/linear.tracker');
const fixture = require('../issue-trackers/fixtures/linear.fixture');

/** window.electron_api.issueTrackers, the way issue-trackers.ipc.js answers. */
function bridgeFor(service) {
  const wrap = (fn, key) => async (...args) => {
    try {
      const value = await fn(...args);
      return key ? { ok: true, [key]: value } : { ok: true, ...value };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code || 'PROVIDER' };
    }
  };
  return {
    providers: wrap(async () => service.listProviders(), 'providers'),
    connections: wrap(() => service.listConnections(), 'connections'),
    metadata: wrap((id) => service.metadata(id), 'metadata'),
    listIssues: jest.fn(wrap((id, q, c) => service.listIssues(id, q, c))),
    getIssue: wrap((id, key) => service.getIssue(id, key), 'issue'),
  };
}

let dir;
let service;
let api;
let deps;
let root;

async function setup({ connect = true } = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-issues-panel-'));
  const secrets = new Map();
  service = createIssueTrackerService({
    storePath: path.join(dir, 'issue-trackers.json'),
    secrets: { get: async (a) => secrets.get(a) ?? null, set: async (a, v) => { secrets.set(a, v); }, delete: async (a) => secrets.delete(a) },
    registry: { get: (id) => (id === 'linear' ? linear : null), describe: () => describeTrackers([linear]) },
    fetch: fixture.fetch,
  });
  if (connect) await service.connect('linear', fixture.secret);
  api = { issueTrackers: bridgeFor(service), dialog: { openExternal: jest.fn() } };
  deps = { api, showToast: jest.fn(), openSettings: jest.fn() };
  panel.init(deps);
  document.body.innerHTML = '<div id="tickets-panel-root"></div>';
  root = document.getElementById('tickets-panel-root');
  await panel.loadPanel(root);
}

/**
 * Advance the fake clock, then let real I/O finish: the service reads its
 * store from disk, and those callbacks only run on a real turn of the event
 * loop, which setImmediate (left unfaked) gives them.
 */
const flush = async (ms = 0) => {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 25; i++) await new Promise((resolve) => realImmediate(resolve));
};
const rowKeys = () => [...root.querySelectorAll('.issues-list > .issue-group .issue-row')].map((r) => r.dataset.key);
const lastQuery = () => api.issueTrackers.listIssues.mock.calls.at(-1)[1];

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  fixture.reset();
  mockSettings.ticketsView = undefined;
  setSetting.mockClear();
  panel._reset();
});

afterEach(() => {
  panel._reset();
  jest.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

test('without a connection it says so and leads to the settings', async () => {
  await setup({ connect: false });
  expect(root.querySelector('.issues-state-title').textContent).toBe(t('tickets.panel.noConnection'));
  expect(root.querySelector('.issues-toolbar').hidden).toBe(true);
  root.querySelector('.issues-open-settings').click();
  expect(deps.openSettings).toHaveBeenCalledWith('tickets');
});

test('a first visit lists every open ticket of the workspace, grouped by status', async () => {
  await setup();
  expect(lastQuery()).toMatchObject({ mine: null, stateCategories: ['backlog', 'todo', 'started'] });
  expect(rowKeys()).toHaveLength(13);
  expect(rowKeys()).not.toContain('ENG-117'); // done
  expect(root.querySelector('.issues-count').textContent).toBe('13');
  expect(root.querySelector('.issues-reset')).toBeNull();
});

test('"My tickets" narrows to what is assigned to me', async () => {
  await setup();
  root.querySelector('.issues-quick-btn[data-mine="assigned"]').click();
  await flush(200);
  expect(lastQuery().mine).toBe('assigned');
  expect(rowKeys().sort()).toEqual(['ENG-137', 'ENG-139', 'ENG-142', 'ENG-151']);
  expect(root.querySelector('.issues-reset')).not.toBeNull();
});

test('search waits for the typing to stop, then queries once', async () => {
  await setup();
  const calls = api.issueTrackers.listIssues.mock.calls.length;
  const input = root.querySelector('.issues-search');
  for (const text of ['p', 'pr', 'pru', 'pruner']) {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush(50);
  }
  await flush(300);
  expect(api.issueTrackers.listIssues.mock.calls.length).toBe(calls + 1);
  expect(lastQuery().text).toBe('pruner');
  expect(rowKeys()).toEqual(['ENG-139']);
});

test('a status picked in the menu is sent as the ids of every team that has it', async () => {
  await setup();
  root.querySelector('[data-menu="status"]').click();
  const item = [...root.querySelectorAll('.issues-menu-item')].find((b) => b.dataset.value === 'state:done:Done');
  item.click();
  await flush(200);
  expect(lastQuery().stateIds.sort()).toEqual(['s-des-done', 's-eng-done', 's-ops-done']);
  expect(rowKeys()).toEqual(expect.arrayContaining(['ENG-117', 'OPS-9']));
  expect(root.querySelector('.issues-menu')).not.toBeNull(); // multi-select stays open
});

test('grouping changes the groups without asking the tracker again', async () => {
  await setup();
  const calls = api.issueTrackers.listIssues.mock.calls.length;
  root.querySelector('[data-menu="groupBy"]').click();
  [...root.querySelectorAll('.issues-menu-item')].find((b) => b.dataset.value === 'assignee').click();
  await flush(200);
  expect(api.issueTrackers.listIssues.mock.calls.length).toBe(calls);
  expect(root.querySelector('.issues-menu')).toBeNull();
  expect(root.querySelector('.issue-group-label').textContent).toBe('Ada Lovelace');
});

test('a slower, older answer never replaces a newer one', async () => {
  await setup();
  const real = api.issueTrackers.listIssues.getMockImplementation();
  let releaseSlow;
  api.issueTrackers.listIssues
    .mockImplementationOnce((...args) => new Promise((resolve) => { releaseSlow = () => resolve(real(...args)); }))
    .mockImplementationOnce(real);
  root.querySelector('.issues-quick-btn[data-mine="created"]').click();
  await flush(200);
  root.querySelector('.issues-quick-btn[data-mine="assigned"]').click();
  await flush(200);
  releaseSlow();
  await flush();
  expect(rowKeys().sort()).toEqual(['ENG-137', 'ENG-139', 'ENG-142', 'ENG-151']);
});

test('a row opens its detail; Escape closes it', async () => {
  await setup();
  root.querySelector('.issue-row[data-key="ENG-142"]').click();
  await flush();
  const detail = root.querySelector('.issues-detail');
  expect(detail.hidden).toBe(false);
  expect(detail.querySelector('.issue-detail-title').textContent).toBe('Session tickets tab');
  expect(detail.querySelectorAll('.issue-comment')).toHaveLength(2);
  expect(root.querySelector('.issue-row.selected').dataset.key).toBe('ENG-142');

  detail.querySelector('[data-action="open"]').click();
  expect(api.dialog.openExternal).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/linear\.app\/acme\/issue\/ENG-142\//));

  // In the app the redraw takes the focused row away, so Escape lands on <body>.
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(detail.hidden).toBe(true);
});

test('a modal above the screen keeps its own Escape', async () => {
  await setup();
  root.querySelector('.issue-row[data-key="ENG-142"]').click();
  await flush();
  document.body.insertAdjacentHTML('beforeend', '<div id="modal-overlay" class="active"></div>');
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  expect(root.querySelector('.issues-detail').hidden).toBe(false);
});

test('Enter on a focused row opens it, and focus survives the redraw', async () => {
  await setup();
  const row = root.querySelector('.issue-row[data-key="ENG-139"]');
  row.focus();
  row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  expect(root.querySelector('.issue-detail-title').textContent).toBe('Transcript pruner loses its position on remount');
  expect(document.activeElement.dataset.key).toBe('ENG-139');
});

test('a sub-issue in the detail opens in its place', async () => {
  await setup();
  root.querySelector('.issue-row[data-key="ENG-142"]').click();
  await flush();
  root.querySelector('.issue-detail-children .issue-row[data-key="ENG-151"]').click();
  await flush();
  expect(root.querySelector('.issue-detail-title').textContent).toBe('Persist ticket filters per screen');
});

test('a rejected key is explained, with the way to fix it', async () => {
  await setup();
  api.issueTrackers.listIssues.mockResolvedValueOnce({ ok: false, code: 'AUTH', error: 'x' });
  panel._reset();
  panel.init(deps);
  await panel.loadPanel(root);
  expect(root.querySelector('.issues-state-error').textContent).toContain(t('tickets.errors.auth', { provider: 'Linear' }));
  root.querySelector('.issues-open-settings').click();
  expect(deps.openSettings).toHaveBeenCalledWith('tickets');
});

test('the view is remembered without the search text', async () => {
  await setup();
  root.querySelector('.issues-quick-btn[data-mine="assigned"]').click();
  const input = root.querySelector('.issues-search');
  input.value = 'pruner';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flush(1000);
  const saved = setSetting.mock.calls.at(-1);
  expect(saved[0]).toBe('ticketsView');
  expect(saved[1]).toMatchObject({ mine: 'assigned', connectionId: expect.stringMatching(/^linear-/) });
  expect(saved[1]).not.toHaveProperty('text');
});

test('leaving the tab stops the refresh; coming back draws at once', async () => {
  await setup();
  panel.cleanup();
  const calls = api.issueTrackers.listIssues.mock.calls.length;
  await flush(5 * 60_000);
  expect(api.issueTrackers.listIssues.mock.calls.length).toBe(calls);

  root.innerHTML = '';
  const back = panel.loadPanel(root);
  expect(rowKeys()).toHaveLength(13); // drawn from memory before the refresh lands
  await back;
});
