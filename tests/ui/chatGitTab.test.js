/**
 * The chat's Git tab. What it must get right: say where the branch stands
 * without being asked twice, cost nothing while hidden, and push the way the
 * branch is set up (plain push when it tracks something, publish otherwise).
 */

'use strict';

const { createGitTab, gitTabHtml } = require('../../src/renderer/ui/components/chat/gitTab');
const { t } = require('../../src/renderer/i18n');

const SESSION_START = Date.parse('2026-10-09T08:00:00Z');

const summary = (over = {}) => ({
  isRepo: true,
  root: '/repo',
  branch: 'feat/x',
  detached: false,
  head: 'abc1234',
  worktree: false,
  upstream: 'fork/feat/x',
  remote: 'fork',
  ahead: 1,
  behind: 0,
  base: 'fork/main',
  onBase: false,
  dirty: { staged: 1, unstaged: 1, untracked: 1, conflicts: 0 },
  commits: [
    { sha: 'e'.repeat(40), short: 'eeeeeee', subject: 'E not pushed yet', author: 'Ada', date: '2026-10-09T09:00:00Z' },
    { sha: 'c'.repeat(40), short: 'ccccccc', subject: 'C <b>before</b>', author: 'Ada', date: '2026-10-08T09:00:00Z' },
  ],
  pr: {
    authenticated: true,
    createUrl: 'https://github.com/acme/app/compare/main...feat%2Fx?expand=1',
    pullRequest: {
      number: 57, title: 'ENG-142: session tab', state: 'open', draft: false, url: 'https://github.com/acme/app/pull/57',
      checks: { total: 3, success: 1, failure: 1, pending: 1, skipped: 0, failing: [{ name: 'test', url: 'https://ci/test' }] },
      reviews: { approved: 1, changesRequested: 0, decisions: [] },
    },
  },
  ...over,
});

describe('gitTabHtml', () => {
  const render = (s, opts) => {
    document.body.innerHTML = gitTabHtml(s, { sessionStartedAt: SESSION_START, ...opts });
    return document.body;
  };

  test('branch, drift against its upstream, and uncommitted work', () => {
    const el = render(summary());
    expect(el.querySelector('.session-git-branch-name').textContent).toBe('feat/x');
    expect(el.textContent).toContain(t('chat.git.onBase', { base: 'fork/main' }));
    expect(el.querySelector('.session-git-drift').textContent).toMatch(/↑ 1\s+↓ 0\s+fork\/feat\/x/);
    expect(el.textContent).toContain(t('chat.git.dirty', { count: 3 }));
    expect(el.querySelector('[data-action="push"]').textContent).toBe(t('chat.git.push'));
  });

  test('nothing to push: no push button; never published: publish', () => {
    expect(render(summary({ ahead: 0 })).querySelector('[data-action="push"]')).toBeNull();
    expect(render(summary({ upstream: null, ahead: 0 })).querySelector('[data-action="push"]').textContent).toBe(t('chat.git.publish'));
    expect(render(summary({ upstream: null })).textContent).toContain(t('chat.git.unpublished'));
  });

  test('commits made since the session opened are marked, text is escaped', () => {
    const el = render(summary());
    const rows = el.querySelectorAll('.session-git-commit');
    expect(rows[0].textContent).toContain(t('chat.git.thisSession'));
    expect(rows[1].textContent).not.toContain(t('chat.git.thisSession'));
    expect(el.querySelector('.session-git-commit b')).toBeNull();
  });

  test('the pull request: state, checks, reviews, failing checks', () => {
    const el = render(summary());
    expect(el.querySelector('.session-git-pr-title').textContent).toContain('#57');
    expect(el.querySelector('.session-git-pill.state.open').textContent).toBe(t('chat.git.prOpen'));
    expect(el.textContent).toContain(t('chat.git.checksFailed', { count: 1 }));
    expect(el.textContent).toContain(t('chat.git.approved', { count: 1 }));
    expect(el.querySelector('[data-action="open-check"]').textContent).toBe('test');
  });

  test('the PR title can be decorated (ticket chips) without losing escaping elsewhere', () => {
    const el = render(summary(), { decoratePrTitle: (title) => `<span class="chip">${title.slice(0, 7)}</span>` });
    expect(el.querySelector('.session-git-pr-text .chip').textContent).toBe('ENG-142');
  });

  test.each([
    ['no pull request yet', { pr: { authenticated: true, pullRequest: null, createUrl: 'https://x' } }, 'create-pr', 'chat.git.prNone'],
    ['no GitHub login', { pr: { authenticated: false, createUrl: 'https://x' } }, 'connect-github', 'chat.git.prLoginNeeded'],
    ['on the base branch', { onBase: true, pr: null }, null, 'chat.git.prOnBase'],
    ['not a GitHub repository', { pr: null }, null, 'chat.git.prNoGitHub'],
  ])('%s', (_label, over, action, key) => {
    const el = render(summary(over));
    expect(el.textContent).toContain(t(key));
    if (action) expect(el.querySelector(`[data-action="${action}"]`)).not.toBeNull();
  });
});

describe('createGitTab', () => {
  let panelEl;
  let api;
  let deps;

  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = '<div class="panel"></div>';
    panelEl = document.querySelector('.panel');
    api = {
      git: {
        sessionSummary: jest.fn(async () => summary()),
        push: jest.fn(async () => ({ success: true })),
        pushBranch: jest.fn(async () => ({ success: true })),
      },
      dialog: { openExternal: jest.fn() },
    };
    deps = {
      api,
      panelEl,
      getCwd: () => '/repo',
      sessionStartedAt: SESSION_START,
      onAvailable: jest.fn(),
      openGitScreen: jest.fn(),
      openSettings: jest.fn(),
      showToast: jest.fn(),
    };
  });

  test('the probe reveals the tab only for a repository, and draws nothing while hidden', async () => {
    const tab = createGitTab(deps);
    await tab.probe();
    expect(api.git.sessionSummary).toHaveBeenCalledWith({ projectPath: '/repo' });
    expect(deps.onAvailable).toHaveBeenCalledTimes(1);
    expect(panelEl.innerHTML).toBe('');

    api.git.sessionSummary.mockResolvedValueOnce({ isRepo: false });
    const other = createGitTab({ ...deps, onAvailable: jest.fn() });
    await other.probe();
    expect(other.getSummary()).toEqual({ isRepo: false });
  });

  test('showing draws the last summary at once and re-reads only when stale', async () => {
    const tab = createGitTab(deps);
    await tab.probe();
    tab.show();
    expect(panelEl.querySelector('.session-git-branch-name').textContent).toBe('feat/x');
    expect(api.git.sessionSummary).toHaveBeenCalledTimes(1); // fresh enough
    tab.destroy();
  });

  test('a tool result re-reads soon while shown, never while hidden', async () => {
    jest.useFakeTimers();
    const tab = createGitTab(deps);
    tab.markStale();
    await jest.advanceTimersByTimeAsync(5000);
    expect(api.git.sessionSummary).not.toHaveBeenCalled();

    tab.show(); // stale: loads now
    await jest.advanceTimersByTimeAsync(0);
    expect(api.git.sessionSummary).toHaveBeenCalledTimes(1);
    tab.markStale();
    tab.markStale();
    await jest.advanceTimersByTimeAsync(1600);
    expect(api.git.sessionSummary).toHaveBeenCalledTimes(2); // debounced into one
    tab.hide();
    tab.destroy();
  });

  test('push uses plain push for a tracked branch, publishes an untracked one', async () => {
    const tab = createGitTab(deps);
    await tab.probe();
    tab.show();
    panelEl.querySelector('[data-action="push"]').click();
    await flush();
    expect(api.git.push).toHaveBeenCalledWith({ projectPath: '/repo' });
    expect(deps.showToast).toHaveBeenCalledWith({ type: 'success', title: t('chat.git.pushed') });

    api.git.sessionSummary.mockResolvedValue(summary({ upstream: null }));
    panelEl.querySelector('[data-action="refresh"]').click();
    await flush();
    panelEl.querySelector('[data-action="push"]').click();
    await flush();
    expect(api.git.pushBranch).toHaveBeenCalledWith({ projectPath: '/repo', branch: 'feat/x' });
    tab.destroy();
  });

  test('a failed push says why', async () => {
    api.git.push.mockResolvedValueOnce({ success: false, error: 'rejected: non-fast-forward' });
    const tab = createGitTab(deps);
    await tab.probe();
    tab.show();
    panelEl.querySelector('[data-action="push"]').click();
    await flush();
    expect(deps.showToast).toHaveBeenCalledWith({ type: 'error', title: t('chat.git.pushFailed'), message: 'rejected: non-fast-forward' });
    tab.destroy();
  });

  test('links open outside the app, navigation goes through the callbacks', async () => {
    const tab = createGitTab(deps);
    await tab.probe();
    tab.show();
    panelEl.querySelector('[data-action="open-pr"]').click();
    panelEl.querySelector('[data-action="open-check"]').click();
    panelEl.querySelector('[data-action="open-git"]').click();
    expect(api.dialog.openExternal.mock.calls.map((c) => c[0])).toEqual(['https://github.com/acme/app/pull/57', 'https://ci/test']);
    expect(deps.openGitScreen).toHaveBeenCalled();
    tab.destroy();
  });

  test('a summary that arrives after destroy is dropped', async () => {
    let release;
    api.git.sessionSummary.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const tab = createGitTab(deps);
    const pending = tab.probe();
    tab.destroy();
    release(summary());
    await pending;
    expect(deps.onAvailable).not.toHaveBeenCalled();
  });
});
