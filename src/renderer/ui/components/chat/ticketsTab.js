/**
 * The chat's Tickets tab: the tickets this session works on, with their live
 * status.
 *
 * Links live in main (IssueLinkService), keyed by session. A tab has no CLI
 * session id before its first message, so it starts under a provisional
 * `tab:<id>` key and moves to the real id when the CLI reports it
 * (`onSessionId`); a fork copies its parent's links instead.
 *
 * Linking here is explicit: the "Link a ticket" search, or an `@ENG-142`
 * mention in a message. Automatic detection only ever suggests, through the
 * confirmation card in the conversation, never from this tab.
 *
 * Statuses are fetched from the tracker when the tab is shown, at most every
 * 30 s, one request per linked ticket; a session links a handful, not dozens.
 */

'use strict';

const { t } = require('../../../i18n');
const { escapeHtml } = require('../../../utils');
const issueView = require('../../panels/issues/issueView');

const ISSUE_TTL_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 8;

function sourceLabel(source) {
  switch (source) {
    case 'mention': return t('chat.tickets.sourceMention');
    case 'start': return t('chat.tickets.sourceStart');
    case 'tool': return t('chat.tickets.sourceTool');
    case 'prompt': return t('chat.tickets.sourcePrompt');
    case 'branch': return t('chat.tickets.sourceBranch');
    case 'pr': return t('chat.tickets.sourcePr');
    default: return t('chat.tickets.sourceManual');
  }
}

/**
 * @param {object} deps
 * @param {object} deps.api window.electron_api
 * @param {HTMLElement} deps.panelEl
 * @param {HTMLElement} deps.tabBtn the tab button, shown once a tracker is connected
 * @param {HTMLElement|null} deps.badgeEl
 * @param {() => void} deps.onAvailable
 * @param {string} deps.initialKey `tab:<id>` for a new tab, the CLI session id for a resumed one
 * @param {() => string|null} deps.getProjectId
 * @param {(opts: object) => void} deps.showToast
 */
function createTicketsTab(deps) {
  const { api, panelEl } = deps;
  let key = deps.initialKey;
  let connections = [];
  let providers = [];
  let links = [];
  const issues = new Map(); // ref → { issue?, error?, at }
  const metadata = new Map(); // connectionId → metadata
  let visible = false;
  let destroyed = false;
  let searching = false;
  let searchText = '';
  let searchResults = null;
  let searchSeq = 0;
  let searchTimer = null;
  let menu = null; // { ref } of the open state menu

  const linked = () => links.filter((l) => l.status === 'linked');
  const connectionFor = (link) => connections.find((c) => c.id === link.connectionId) || null;
  const providerFor = (conn) => providers.find((p) => p.id === conn?.provider) || null;
  const keyOf = (ref) => ref.slice(ref.indexOf(':') + 1);

  function updateBadge() {
    if (!deps.badgeEl) return;
    const n = linked().length;
    deps.badgeEl.textContent = String(n);
    deps.badgeEl.hidden = n === 0;
  }

  async function refreshLinks() {
    const res = await api.issueLinks.get(key);
    if (destroyed) return;
    links = res?.ok ? res.links : [];
    updateBadge();
    if (visible) {
      render();
      fetchIssues();
    }
  }

  async function fetchIssues({ force = false } = {}) {
    const due = linked().filter((l) => {
      const hit = issues.get(l.ref);
      return force || !hit || Date.now() - hit.at > ISSUE_TTL_MS;
    });
    await Promise.all(due.map(async (l) => {
      const conn = connectionFor(l);
      if (!conn) {
        issues.set(l.ref, { error: { code: 'NOT_FOUND' }, at: Date.now() });
        return;
      }
      const res = await api.issueTrackers.getIssue(conn.id, keyOf(l.ref));
      issues.set(l.ref, res?.ok ? { issue: res.issue, at: Date.now() } : { error: res, at: Date.now() });
    }));
    if (!destroyed && visible && due.length) render();
  }

  async function search(text) {
    const mine = ++searchSeq;
    const conn = connections[0];
    if (!conn) return;
    const res = await api.issueTrackers.listIssues(conn.id, { text, limit: SEARCH_LIMIT, sort: 'updated' }, null);
    if (destroyed || mine !== searchSeq) return;
    searchResults = res?.ok ? res.issues.map((issue) => ({ issue, connectionId: conn.id })) : [];
    if (visible) renderSearchResults();
  }

  async function link(issue, connectionId, source = 'manual') {
    const res = await api.issueLinks.link(key, { ref: issue.ref, connectionId, title: issue.title, source }, { projectId: deps.getProjectId?.() || null });
    if (destroyed) return;
    if (!res?.ok) {
      deps.showToast({ type: 'error', title: res?.error || t('common.errorOccurred') });
      return;
    }
    issues.set(issue.ref, { issue, at: Date.now() });
    links = res.links;
    updateBadge();
    if (visible) render();
  }

  async function changeState(ref, stateId) {
    const hit = issues.get(ref);
    const conn = connectionFor(links.find((l) => l.ref === ref) || {});
    if (!hit?.issue || !conn) return;
    const res = await api.issueTrackers.updateIssue(conn.id, hit.issue.key, { stateId });
    if (destroyed) return;
    if (res?.ok) issues.set(ref, { issue: res.issue, at: Date.now() });
    else deps.showToast({ type: 'error', title: t('tickets.errors.updateFailed', { key: hit.issue.key }), message: res?.error || '' });
    if (visible) render();
  }

  // ── Rendering ──

  function rowHtml(l) {
    const hit = issues.get(l.ref);
    const conn = connectionFor(l);
    const provider = providerFor(conn);
    const writable = !!provider?.capabilities?.write?.includes('state');
    const issue = hit?.issue;
    const key = keyOf(l.ref);
    const state = issue
      ? `${writable ? `<button type="button" class="session-tickets-state" data-action="state" data-ref="${escapeHtml(l.ref)}" aria-haspopup="menu" title="${escapeHtml(t('tickets.detail.edit'))}">` : '<span class="session-tickets-state">'}
          ${issueView.stateDot(issue.state)} ${escapeHtml(issue.state.name)}
        ${writable ? '</button>' : '</span>'}`
      : `<span class="session-tickets-state session-tickets-muted">${escapeHtml(hit?.error ? t('chat.tickets.loadFailed') : t('tickets.panel.loading'))}</span>`;
    return `
      <li class="session-tickets-row" data-ref="${escapeHtml(l.ref)}">
        ${issue ? issueView.priorityIcon(issue.priority) : '<span class="issue-priority"></span>'}
        <span class="issue-key">${escapeHtml(key)}</span>
        <span class="session-tickets-title">
          <span class="session-tickets-name">${escapeHtml(issue?.title || l.title || key)}</span>
          <span class="session-tickets-source">${escapeHtml(sourceLabel(l.source))}${l.evidence ? ` · ${escapeHtml(l.evidence)}` : ''}</span>
        </span>
        ${state}
        ${issue ? issueView.avatarHtml(issue.assignee, 'issue-avatar-sm') : ''}
        ${issue?.url ? `<button type="button" class="session-tickets-icon" data-action="open" data-ref="${escapeHtml(l.ref)}" title="${escapeHtml(t('tickets.detail.openIn', { provider: provider?.name || '' }))}" aria-label="${escapeHtml(t('tickets.detail.openIn', { provider: provider?.name || '' }))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
        </button>` : ''}
        <button type="button" class="session-tickets-icon" data-action="unlink" data-ref="${escapeHtml(l.ref)}" title="${escapeHtml(t('chat.tickets.unlink'))}" aria-label="${escapeHtml(t('chat.tickets.unlink'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </li>`;
  }

  function renderSearchResults() {
    const el = panelEl.querySelector('.session-tickets-results');
    if (!el) return;
    if (searchResults === null) {
      el.innerHTML = '';
      return;
    }
    const known = new Set(linked().map((l) => l.ref));
    const rows = searchResults.filter((r) => !known.has(r.issue.ref));
    el.innerHTML = rows.length
      ? rows.map((r, i) => `
        <li><button type="button" class="session-tickets-result" data-action="pick" data-index="${searchResults.indexOf(r)}" ${i === 0 ? 'data-first="1"' : ''}>
          ${issueView.stateDot(r.issue.state)}
          <span class="issue-key">${escapeHtml(r.issue.key)}</span>
          <span class="session-tickets-name">${escapeHtml(r.issue.title)}</span>
        </button></li>`).join('')
      : `<li class="session-tickets-muted">${escapeHtml(t('chat.tickets.noResults'))}</li>`;
  }

  /** `focusSearch` only when the user opens the search: the composer below must keep its focus otherwise. */
  function render({ focusSearch = false } = {}) {
    const rows = linked();
    panelEl.innerHTML = `
      <div class="session-tickets">
        <div class="session-tickets-head">
          <h4 class="session-tickets-heading">${escapeHtml(t('chat.tickets.title'))} <span class="session-tickets-count">${rows.length}</span></h4>
          <button type="button" class="btn-sm btn-secondary" data-action="toggle-search">${escapeHtml(t('chat.tickets.link'))}</button>
        </div>
        ${searching ? `
          <div class="session-tickets-search">
            <input type="search" class="session-tickets-search-input" placeholder="${escapeHtml(t('chat.tickets.searchPlaceholder'))}" aria-label="${escapeHtml(t('chat.tickets.searchPlaceholder'))}" spellcheck="false" value="${escapeHtml(searchText)}">
            <ul class="session-tickets-results"></ul>
          </div>` : ''}
        ${rows.length
    ? `<ul class="session-tickets-list">${rows.map(rowHtml).join('')}</ul>`
    : `<p class="session-tickets-empty">${escapeHtml(t('chat.tickets.empty'))}</p>`}
      </div>`;
    if (searching) {
      renderSearchResults();
      if (focusSearch) panelEl.querySelector('.session-tickets-search-input').focus();
    }
  }

  async function openStateMenu(button) {
    closeMenu();
    const ref = button.dataset.ref;
    const issue = issues.get(ref)?.issue;
    const conn = connectionFor(links.find((l) => l.ref === ref) || {});
    if (!issue || !conn) return;
    if (!metadata.has(conn.id)) {
      const res = await api.issueTrackers.metadata(conn.id);
      if (destroyed || !res?.ok) return;
      metadata.set(conn.id, res.metadata);
    }
    const states = issueView.statesForIssue(issue, metadata.get(conn.id));
    const el = document.createElement('div');
    el.className = 'issues-menu session-tickets-menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = `<div class="issues-menu-items">${states.map((st) => `
      <button type="button" class="issues-menu-item" role="menuitemradio" aria-checked="${st.id === issue.state.id}" data-action="set-state" data-ref="${escapeHtml(ref)}" data-state="${escapeHtml(st.id)}">
        <span class="issues-menu-check" aria-hidden="true">${st.id === issue.state.id ? '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>' : ''}</span>
        ${issueView.stateDot(st)}
        <span class="issues-menu-label">${escapeHtml(st.name)}</span>
      </button>`).join('')}</div>`;
    panelEl.appendChild(el);
    const box = button.getBoundingClientRect();
    const host = panelEl.getBoundingClientRect();
    el.style.top = `${box.bottom - host.top + panelEl.scrollTop + 4}px`;
    // Kept inside the panel: the state button sits near the right edge.
    el.style.left = `${Math.max(0, Math.min(box.left - host.left, host.width - el.offsetWidth - 8))}px`;
    menu = { ref };
    button.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    panelEl.querySelector('.session-tickets-menu')?.remove();
    menu = null;
  }

  // ── Events ──

  function onClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el) {
      if (menu && !event.target.closest('.session-tickets-menu')) closeMenu();
      return;
    }
    const ref = el.dataset.ref;
    switch (el.dataset.action) {
      case 'toggle-search':
        searching = !searching;
        if (!searching) {
          searchText = '';
          searchResults = null;
        }
        render({ focusSearch: searching });
        if (searching && searchResults === null) search('');
        break;
      case 'pick': {
        const picked = searchResults?.[Number(el.dataset.index)];
        if (picked) {
          searching = false;
          searchText = '';
          searchResults = null;
          link(picked.issue, picked.connectionId, 'manual');
        }
        break;
      }
      case 'unlink':
        api.issueLinks.dismiss(key, [ref]).then((res) => {
          if (!destroyed && res?.ok) {
            links = res.links;
            updateBadge();
            if (visible) render();
          }
        });
        break;
      case 'open': {
        const url = issues.get(ref)?.issue?.url;
        if (url) api.dialog.openExternal(url);
        break;
      }
      case 'state':
        if (menu?.ref === ref) closeMenu();
        else openStateMenu(el);
        break;
      case 'set-state':
        closeMenu();
        changeState(ref, el.dataset.state);
        break;
      default:
    }
  }

  function onInput(event) {
    if (!event.target.matches('.session-tickets-search-input')) return;
    searchText = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(searchText.trim()), SEARCH_DEBOUNCE_MS);
  }

  function onKeydown(event) {
    if (event.key === 'Escape' && (menu || searching)) {
      if (menu) closeMenu();
      else {
        searching = false;
        render();
      }
      event.stopPropagation();
    }
    if (event.key === 'Enter' && event.target.matches('.session-tickets-search-input')) {
      event.preventDefault();
      panelEl.querySelector('.session-tickets-result[data-first]')?.click();
    }
  }

  panelEl.addEventListener('click', onClick);
  panelEl.addEventListener('input', onInput);
  panelEl.addEventListener('keydown', onKeydown);
  const offChanged = api.issueLinks?.onChanged?.((payload) => {
    if (payload?.sessionKey === key) refreshLinks();
  });

  return {
    /** Show the tab only when a tracker is connected, and fill the badge. */
    async probe() {
      let p;
      let c;
      try {
        [p, c] = await Promise.all([api.issueTrackers.providers(), api.issueTrackers.connections()]);
      } catch {
        return; // no tracker bridge: the tab simply never appears
      }
      if (destroyed) return;
      providers = p?.ok ? p.providers : [];
      connections = c?.ok ? c.connections.filter((x) => x.available) : [];
      if (!connections.length) return;
      deps.onAvailable?.();
      await refreshLinks();
    },

    show() {
      visible = true;
      render();
      fetchIssues();
    },

    hide() {
      visible = false;
      closeMenu();
    },

    /** The CLI named this session: its links follow (moved from a new tab, copied for a fork). */
    async onSessionId(id) {
      if (!id || id === key) return;
      const previous = key;
      key = id;
      if (previous.startsWith('tab:')) await api.issueLinks.rekey(previous, id);
      else await api.issueLinks.copy(previous, id);
      await refreshLinks();
    },

    /** Link from outside the tab: an @mention, or a session started from a ticket. */
    async linkTicket({ ref, connectionId, title }, source) {
      const res = await api.issueLinks.link(key, { ref, connectionId, title, source }, { projectId: deps.getProjectId?.() || null });
      if (destroyed || !res?.ok) return;
      links = res.links;
      updateBadge();
      if (visible) render();
    },

    getKey: () => key,
    getLinks: () => links.slice(),

    destroy() {
      destroyed = true;
      clearTimeout(searchTimer);
      offChanged?.();
      panelEl.removeEventListener('click', onClick);
      panelEl.removeEventListener('input', onInput);
      panelEl.removeEventListener('keydown', onKeydown);
    },
  };
}

module.exports = { createTicketsTab, sourceLabel };
