/**
 * The chat's Git tab: where this session's branch stands.
 *
 * Beside Changes, not instead of it. Changes is what Claude edited in this
 * session; Git is the repository's side: branch and its drift from upstream,
 * the base it is measured against, uncommitted files, the branch's own
 * commits, and its pull request with checks and reviews.
 *
 * Everything comes from one read-only call (`git.sessionSummary`, served by
 * SessionGitService). It is fetched when the tab is shown, every 30 s while it
 * stays shown and the window is focused, and shortly after a tool result,
 * since a tool is what commits and pushes. Hidden, it costs nothing.
 *
 * Two sessions on the same folder share a branch, so they show the same thing.
 * That is the repository's truth; isolating sessions is what worktrees are for.
 */

'use strict';

const { t, getCurrentLanguage } = require('../../../i18n');
const { escapeHtml } = require('../../../utils');
const { formatRelativeTimeIntl } = require('../../../utils/format');

const POLL_MS = 30_000;
const STALE_DEBOUNCE_MS = 1500;
const FRESH_MS = 10_000;

const ICONS = {
  branch: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11.5 8.5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>',
  pr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-4"/><path d="M13 3l-2 3 2 3"/></svg>',
};

function prStateLabel(pr) {
  if (pr.state === 'merged') return t('chat.git.prMerged');
  if (pr.state === 'closed') return t('chat.git.prClosed');
  return pr.draft ? t('chat.git.prDraft') : t('chat.git.prOpen');
}

function syncHtml(s) {
  if (!s.branch) return `<span class="session-git-muted">${escapeHtml(t('chat.git.detached', { sha: s.head || '' }))}</span>`;
  if (!s.upstream) return `<span class="session-git-warn">${escapeHtml(t('chat.git.unpublished'))}</span>`;
  if (!s.ahead && !s.behind) return `<span class="session-git-muted">${escapeHtml(t('chat.git.upToDate', { upstream: s.upstream }))}</span>`;
  return `<span class="session-git-drift" title="${escapeHtml(s.upstream)}">
      <span class="session-git-pill${s.ahead ? ' accent' : ''}">↑ ${s.ahead}</span>
      <span class="session-git-pill${s.behind ? ' warn' : ''}">↓ ${s.behind}</span>
      <span class="session-git-muted">${escapeHtml(s.upstream)}</span>
    </span>`;
}

function dirtyHtml(dirty) {
  const total = dirty.staged + dirty.unstaged + dirty.untracked;
  if (!total && !dirty.conflicts) return `<span class="session-git-muted">${escapeHtml(t('chat.git.clean'))}</span>`;
  return `
    <span>${escapeHtml(t('chat.git.dirty', { count: total }))}</span>
    <span class="session-git-muted">${escapeHtml(t('chat.git.dirtyDetail', { staged: dirty.staged, unstaged: dirty.unstaged, untracked: dirty.untracked }))}</span>
    ${dirty.conflicts ? `<span class="session-git-pill fail">${escapeHtml(t('chat.git.conflicts', { count: dirty.conflicts }))}</span>` : ''}`;
}

function checksHtml(checks) {
  if (!checks.total) return `<span class="session-git-muted">${escapeHtml(t('chat.git.noChecks'))}</span>`;
  return [
    checks.success ? `<span class="session-git-pill ok">✓ ${escapeHtml(t('chat.git.checksOk', { count: checks.success }))}</span>` : '',
    checks.failure ? `<span class="session-git-pill fail">✕ ${escapeHtml(t('chat.git.checksFailed', { count: checks.failure }))}</span>` : '',
    checks.pending ? `<span class="session-git-pill warn">◷ ${escapeHtml(t('chat.git.checksPending', { count: checks.pending }))}</span>` : '',
  ].join('');
}

function reviewsHtml(reviews) {
  if (reviews.changesRequested) return `<span class="session-git-pill fail">${escapeHtml(t('chat.git.changesRequested'))}</span>`;
  if (reviews.approved) return `<span class="session-git-pill ok">${escapeHtml(t('chat.git.approved', { count: reviews.approved }))}</span>`;
  return `<span class="session-git-muted">${escapeHtml(t('chat.git.reviewPending'))}</span>`;
}

/**
 * @param {object} pr the summary's `pr` field
 * @param {(text: string) => string} [decorateTitle] adds ticket chips to the title (Tickets feature)
 */
function prSectionHtml(s, decorateTitle) {
  const head = `<h4 class="session-git-section-title">${ICONS.pr}${escapeHtml(t('chat.git.prTitle'))}</h4>`;
  if (s.onBase || !s.branch) return `<section class="session-git-section">${head}<p class="session-git-muted">${escapeHtml(t('chat.git.prOnBase'))}</p></section>`;
  const pr = s.pr;
  if (!pr) return `<section class="session-git-section">${head}<p class="session-git-muted">${escapeHtml(t('chat.git.prNoGitHub'))}</p></section>`;
  if (!pr.authenticated) {
    return `<section class="session-git-section">${head}
      <p class="session-git-muted">${escapeHtml(t('chat.git.prLoginNeeded'))}</p>
      <div class="session-git-actions"><button type="button" class="btn-sm btn-secondary" data-action="connect-github">${escapeHtml(t('chat.git.prConnect'))}</button></div>
    </section>`;
  }
  if (!pr.pullRequest) {
    return `<section class="session-git-section">${head}
      <p class="session-git-muted">${escapeHtml(t('chat.git.prNone'))}</p>
      ${pr.createUrl ? `<div class="session-git-actions"><button type="button" class="btn-sm btn-secondary" data-action="create-pr">${escapeHtml(t('chat.git.prCreate'))}</button></div>` : ''}
    </section>`;
  }
  const p = pr.pullRequest;
  const title = decorateTitle ? decorateTitle(p.title) : escapeHtml(p.title);
  return `<section class="session-git-section">${head}
    <div class="session-git-pr">
      <div class="session-git-pr-title">
        <button type="button" class="session-git-link" data-action="open-pr">#${p.number}</button>
        <span class="session-git-pr-text">${title}</span>
      </div>
      <div class="session-git-pills">
        <span class="session-git-pill state ${escapeHtml(p.draft && p.state === 'open' ? 'draft' : p.state)}">${escapeHtml(prStateLabel(p))}</span>
        ${checksHtml(p.checks)}
        ${reviewsHtml(p.reviews)}
      </div>
      ${p.checks.failing.length ? `<ul class="session-git-failing">${p.checks.failing.map((c, i) => `
        <li><button type="button" class="session-git-link" data-action="open-check" data-index="${i}">${escapeHtml(c.name)}</button></li>`).join('')}</ul>` : ''}
    </div>
  </section>`;
}

function commitsHtml(s, sessionStartedAt) {
  const label = s.onBase ? t('chat.git.commitsRecent') : t('chat.git.commitsBranch', { base: s.base || '' });
  const language = getCurrentLanguage();
  const rows = s.commits.map((c) => {
    const ms = Date.parse(c.date);
    const ours = Number.isFinite(ms) && ms >= sessionStartedAt;
    return `<li class="session-git-commit">
      <span class="session-git-sha">${escapeHtml(c.short)}</span>
      <span class="session-git-subject">${escapeHtml(c.subject)}</span>
      ${ours ? `<span class="session-git-pill accent">${escapeHtml(t('chat.git.thisSession'))}</span>` : ''}
      <span class="session-git-muted session-git-when" title="${escapeHtml(c.author)}">${escapeHtml(formatRelativeTimeIntl(c.date, { language }))}</span>
    </li>`;
  }).join('');
  return `<section class="session-git-section">
    <h4 class="session-git-section-title">${escapeHtml(label)} <span class="session-git-count">${s.commits.length}</span></h4>
    ${rows ? `<ul class="session-git-commits">${rows}</ul>` : `<p class="session-git-muted">${escapeHtml(t('chat.git.noCommits'))}</p>`}
  </section>`;
}

/** The whole tab for one summary. Pure, so it is tested on its own. */
function gitTabHtml(s, { sessionStartedAt = Date.now(), decoratePrTitle = null } = {}) {
  const canPush = !!s.branch && (!s.upstream || s.ahead > 0);
  return `<div class="chat-git">
    <section class="session-git-section session-git-branch-card">
      <div class="session-git-branch">
        ${ICONS.branch}
        <span class="session-git-branch-name">${escapeHtml(s.branch || s.head || '')}</span>
        ${s.worktree ? `<span class="session-git-pill">${escapeHtml(t('chat.git.worktree'))}</span>` : ''}
        ${s.base && !s.onBase ? `<span class="session-git-muted">${escapeHtml(t('chat.git.onBase', { base: s.base }))}</span>` : ''}
        <span class="session-git-spacer"></span>
        <button type="button" class="session-git-icon-btn" data-action="refresh" title="${escapeHtml(t('chat.git.refresh'))}" aria-label="${escapeHtml(t('chat.git.refresh'))}">${ICONS.refresh}</button>
      </div>
      <div class="session-git-line">${syncHtml(s)}</div>
      <div class="session-git-line">${dirtyHtml(s.dirty)}</div>
      <div class="session-git-actions">
        ${canPush ? `<button type="button" class="btn-sm session-git-primary" data-action="push">${escapeHtml(s.upstream ? t('chat.git.push') : t('chat.git.publish'))}</button>` : ''}
        <button type="button" class="btn-sm btn-secondary" data-action="open-git">${escapeHtml(t('chat.git.openGit'))}</button>
      </div>
    </section>
    ${prSectionHtml(s, decoratePrTitle)}
    ${commitsHtml(s, sessionStartedAt)}
  </div>`;
}

/**
 * @param {object} deps
 * @param {object} deps.api window.electron_api
 * @param {HTMLElement} deps.panelEl the tab's panel
 * @param {() => string} deps.getCwd the session's working directory
 * @param {number} deps.sessionStartedAt commits after this are marked as this session's
 * @param {() => void} deps.onAvailable called once the folder turns out to be a repository
 * @param {() => void} deps.openGitScreen
 * @param {(subTab: string) => void} deps.openSettings
 * @param {(opts: object) => void} deps.showToast
 * @param {(title: string) => string} [deps.decoratePrTitle]
 */
function createGitTab(deps) {
  const { api, panelEl } = deps;
  let summary = null;
  let loadedAt = 0;
  let stale = true;
  let visible = false;
  let destroyed = false;
  let available = false;
  let seq = 0;
  let pollTimer = null;
  let staleTimer = null;

  async function load() {
    if (destroyed) return;
    const mine = ++seq;
    let res;
    try {
      res = await api.git.sessionSummary({ projectPath: deps.getCwd() });
    } catch (err) {
      res = { isRepo: false, error: err.message };
    }
    if (destroyed || mine !== seq) return;
    summary = res;
    loadedAt = Date.now();
    stale = false;
    if (summary?.isRepo && !available) {
      available = true;
      deps.onAvailable?.();
    }
    if (visible) render();
  }

  function render() {
    if (!summary) {
      panelEl.innerHTML = `<div class="session-git-state">${escapeHtml(t('chat.git.loading'))}</div>`;
      return;
    }
    if (!summary.isRepo) {
      panelEl.innerHTML = `<div class="session-git-state">${escapeHtml(t('chat.git.notRepo'))}</div>`;
      return;
    }
    panelEl.innerHTML = gitTabHtml(summary, { sessionStartedAt: deps.sessionStartedAt, decoratePrTitle: deps.decoratePrTitle });
  }

  async function push(button) {
    button.disabled = true;
    const projectPath = deps.getCwd();
    const res = summary.upstream
      ? await api.git.push({ projectPath })
      : await api.git.pushBranch({ projectPath, branch: summary.branch });
    if (destroyed) return;
    deps.showToast(res?.success
      ? { type: 'success', title: t('chat.git.pushed') }
      : { type: 'error', title: t('chat.git.pushFailed'), message: res?.error || '' });
    await load();
  }

  function onClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el || !summary) return;
    const pr = summary.pr?.pullRequest;
    switch (el.dataset.action) {
      case 'refresh': load(); break;
      case 'push': push(el); break;
      case 'open-git': deps.openGitScreen(); break;
      case 'connect-github': deps.openSettings('github'); break;
      case 'create-pr': if (summary.pr?.createUrl) api.dialog.openExternal(summary.pr.createUrl); break;
      case 'open-pr': if (pr?.url) api.dialog.openExternal(pr.url); break;
      case 'open-check': {
        const check = pr?.checks.failing[Number(el.dataset.index)];
        if (check?.url) api.dialog.openExternal(check.url);
        break;
      }
      default:
    }
  }
  panelEl.addEventListener('click', onClick);

  return {
    /** Find out once, quietly, whether there is a repository to show. */
    probe: () => load(),

    show() {
      visible = true;
      render();
      if (stale || Date.now() - loadedAt > FRESH_MS) load();
      clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        if (visible && document.hasFocus()) load();
      }, POLL_MS);
    },

    hide() {
      visible = false;
      clearInterval(pollTimer);
      pollTimer = null;
    },

    /** A tool just finished: it may have committed, pushed or edited. */
    markStale() {
      stale = true;
      if (!visible) return;
      clearTimeout(staleTimer);
      staleTimer = setTimeout(load, STALE_DEBOUNCE_MS);
    },

    /** The last summary, for the features that read the branch (Tickets). */
    getSummary: () => summary,

    destroy() {
      destroyed = true;
      clearInterval(pollTimer);
      clearTimeout(staleTimer);
      panelEl.removeEventListener('click', onClick);
    },
  };
}

module.exports = { createGitTab, gitTabHtml };
