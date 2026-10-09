/**
 * Tickets screen: every ticket of the connected workspace, filtered, grouped,
 * and opened in a side pane. Read-only for now; the board and the writes come
 * with the next step.
 *
 * Lazy-loaded (see `_LAZY_PANELS` in renderer.js). The pure half - view state
 * to query, issues to groups, all the HTML - is `issues/issueView.js`. This
 * file owns the DOM, the menus, the requests and the refresh timer.
 *
 * The state survives leaving the tab: coming back draws what was there at once
 * and refreshes behind it, instead of starting from an empty list.
 */

'use strict';

const { t } = require('../../i18n');
const { escapeHtml } = require('../../utils');
const { copyText } = require('../../utils/clipboard');
const MarkdownRenderer = require('../../services/MarkdownRenderer');
const { getSetting, setSetting } = require('../../state/settings.state');
const view = require('./issues/issueView');

const POLL_MS = 60_000;
const SEARCH_DEBOUNCE_MS = 250;
const RELOAD_DEBOUNCE_MS = 150;
const SAVE_DEBOUNCE_MS = 400;

let deps = { api: null, openSettings: () => {}, showToast: () => {} };
let root = null;
let state = null;
let listeners = [];
const timers = { poll: null, search: null, reload: null, save: null };
let seq = 0;
let detailSeq = 0;

function init(injected) {
  deps = { ...deps, ...injected };
}

const bridge = () => deps.api.issueTrackers;

function freshState() {
  return {
    view: view.restoreView(getSetting('ticketsView')),
    providers: [],
    connections: [],
    connection: null,
    provider: null,
    metadata: null,
    issues: [],
    next: null,
    loading: false,
    loadingMore: false,
    error: null,
    selectedRef: null,
    detail: null,
    detailError: null,
    collapsed: new Set(),
    lastLoadedAt: null,
    menu: null,
  };
}

// ── Errors ───────────────────────────────────────────────────────────────────

function errorText(res) {
  const provider = state.provider?.name || '';
  switch (res?.code) {
    case 'AUTH': return t('tickets.errors.auth', { provider });
    case 'RATE_LIMITED': return t('tickets.errors.rateLimited', { provider });
    case 'NETWORK': return t('tickets.errors.network', { provider });
    case 'NOT_FOUND': return t('tickets.errors.notFound', { provider });
    default: return t('tickets.errors.provider', { provider, message: res?.error || '' });
  }
}

// ── Loading ──────────────────────────────────────────────────────────────────

async function loadConnections() {
  const [providers, connections] = await Promise.all([bridge().providers(), bridge().connections()]);
  if (!providers?.ok || !connections?.ok) {
    state.error = providers?.ok ? connections : providers;
    renderAll();
    return;
  }
  state.providers = providers.providers;
  state.connections = connections.connections.filter((c) => c.available);
  const keep = state.connections.find((c) => c.id === (state.connection?.id || state.view.connectionId));
  await useConnection(keep || state.connections[0] || null);
}

async function useConnection(connection) {
  const changed = connection?.id !== state.connection?.id;
  state.connection = connection;
  state.provider = connection ? state.providers.find((p) => p.id === connection.provider) || null : null;
  if (changed) {
    state.metadata = null;
    state.issues = [];
    state.next = null;
    state.selectedRef = null;
    state.detail = null;
  }
  state.error = null;
  renderAll();
  if (!connection) return;
  if (changed) {
    state.view.connectionId = connection.id;
    persistView();
  }
  if (!state.metadata) {
    const res = await bridge().metadata(connection.id);
    if (state.connection !== connection) return;
    if (!res?.ok) {
      state.error = res;
      renderAll();
      return;
    }
    state.metadata = res.metadata;
    renderToolbar();
  }
  await loadIssues();
}

/**
 * Fetch the first page for the current view. A response that arrives after a
 * newer request was sent is dropped, so typing fast never shows stale results.
 */
async function loadIssues({ silent = false } = {}) {
  if (!state.connection || !state.metadata) return;
  const mine = ++seq;
  state.loading = true;
  if (!silent) renderList();
  const res = await bridge().listIssues(state.connection.id, view.buildQuery(state.view, state.metadata), null);
  if (mine !== seq) return;
  state.loading = false;
  if (!res?.ok) {
    state.error = res;
  } else {
    state.error = null;
    state.issues = res.issues;
    state.next = res.next;
    state.lastLoadedAt = Date.now();
  }
  renderHeader();
  renderList();
}

async function loadMore() {
  if (!state.next || state.loadingMore) return;
  const mine = seq;
  state.loadingMore = true;
  renderList();
  const res = await bridge().listIssues(state.connection.id, view.buildQuery(state.view, state.metadata), state.next);
  state.loadingMore = false;
  if (mine !== seq) return;
  if (res?.ok) {
    const seen = new Set(state.issues.map((i) => i.ref));
    state.issues = state.issues.concat(res.issues.filter((i) => !seen.has(i.ref)));
    state.next = res.next;
  } else {
    deps.showToast({ type: 'error', title: errorText(res) });
  }
  renderHeader();
  renderList();
}

async function selectIssue(key) {
  const issue = state.issues.find((i) => i.key === key) || state.detail?.children?.find((i) => i.key === key);
  state.selectedRef = issue ? issue.ref : `${state.connection.provider}:${key}`;
  state.detail = null;
  state.detailError = null;
  renderList();
  renderDetail();
  const mine = ++detailSeq;
  const res = await bridge().getIssue(state.connection.id, key);
  if (mine !== detailSeq) return;
  if (res?.ok) state.detail = res.issue;
  else state.detailError = res;
  renderDetail();
}

function closeDetail() {
  detailSeq++;
  state.selectedRef = null;
  state.detail = null;
  state.detailError = null;
  renderList();
  renderDetail();
}

// ── View changes ─────────────────────────────────────────────────────────────

function persistView() {
  clearTimeout(timers.save);
  timers.save = setTimeout(() => {
    // The search text is per visit, not a preference.
    const { text: _text, ...kept } = state.view;
    setSetting('ticketsView', kept);
  }, SAVE_DEBOUNCE_MS);
}

function viewChanged({ reload = true } = {}) {
  persistView();
  renderToolbar();
  if (!reload) {
    renderList();
    return;
  }
  clearTimeout(timers.reload);
  timers.reload = setTimeout(() => loadIssues(), RELOAD_DEBOUNCE_MS);
}

function toggle(list, value) {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function resetFilters() {
  const keepConnection = state.view.connectionId;
  state.view = { ...view.restoreView(null), connectionId: keepConnection, groupBy: state.view.groupBy, sort: state.view.sort };
  const search = root.querySelector('.issues-search');
  if (search) search.value = '';
  viewChanged();
}

// ── Menus ────────────────────────────────────────────────────────────────────

/** The items of a filter menu, as { value, label, icon?, indent?, header? }. */
function menuItems(id) {
  const meta = state.metadata || {};
  if (id === 'status') {
    return view.statusOptions(meta).flatMap((group) => [
      { value: `cat:${group.category}`, label: view.categoryLabel(group.category), header: true },
      ...group.states.map((s) => ({ value: s.key, label: s.name, icon: view.stateDot({ color: s.color, category: group.category, name: s.name }), indent: true })),
    ]);
  }
  if (id === 'assignee') {
    return [
      { value: 'me', label: t('tickets.filters.me') },
      { value: 'none', label: t('tickets.groupBy.noAssignee') },
      ...(meta.people || []).map((p) => ({ value: p.id, label: p.name, icon: view.avatarHtml(p, 'issue-avatar-sm') })),
    ];
  }
  if (id === 'priority') {
    return [1, 2, 3, 4, 0].map((p) => ({ value: p, label: view.priorityLabel(p), icon: view.priorityIcon(p) }));
  }
  if (id === 'labels') {
    return (meta.labels || []).map((l) => ({
      value: l.id, label: l.name, icon: `<span class="issue-label-dot"${l.color ? ` style="--label-color: ${l.color}"` : ''}></span>`,
    }));
  }
  if (id === 'groupBy') return view.groupByOptions(meta, state.provider?.capabilities).map((o) => ({ value: o.id, label: o.label }));
  if (id === 'sort') {
    return ['updated', 'created', 'priority', 'due']
      .filter((s) => s !== 'priority' || state.provider?.capabilities?.priority)
      .map((s) => ({ value: s, label: sortLabel(s) }));
  }
  if (id.startsWith('facet:')) {
    const facet = (meta.facets || []).find((f) => f.id === id.slice(6));
    return (facet?.options || []).map((o) => ({ value: o.value, label: o.label }));
  }
  return [];
}

function menuSelection(id) {
  const v = state.view;
  if (id === 'status') return v.status;
  if (id === 'assignee') return v.assigneeIds;
  if (id === 'priority') return v.priorities;
  if (id === 'labels') return v.labelIds;
  if (id === 'groupBy') return [v.groupBy];
  if (id === 'sort') return [v.sort];
  if (id.startsWith('facet:')) return v.facets[id.slice(6)] || [];
  return [];
}

function applyMenuChoice(id, value) {
  const v = state.view;
  if (id === 'status') v.status = toggle(v.status, value);
  else if (id === 'assignee') v.assigneeIds = toggle(v.assigneeIds, value);
  else if (id === 'priority') v.priorities = toggle(v.priorities, value);
  else if (id === 'labels') v.labelIds = toggle(v.labelIds, value);
  else if (id === 'groupBy') v.groupBy = value;
  else if (id === 'sort') v.sort = value;
  else if (id.startsWith('facet:')) {
    const facetId = id.slice(6);
    const next = toggle(v.facets[facetId] || [], value);
    v.facets = { ...v.facets };
    if (next.length) v.facets[facetId] = next;
    else delete v.facets[facetId];
  }
  viewChanged({ reload: id !== 'groupBy' });
}

const SINGLE_CHOICE = new Set(['groupBy', 'sort']);

function sortLabel(sort) {
  switch (sort) {
    case 'created': return t('tickets.sort.created');
    case 'priority': return t('tickets.sort.priority');
    case 'due': return t('tickets.sort.due');
    default: return t('tickets.sort.updated');
  }
}

function openMenu(id, anchor) {
  closeMenu();
  const single = SINGLE_CHOICE.has(id);
  const items = menuItems(id);
  const menu = document.createElement('div');
  menu.className = 'issues-menu';
  menu.dataset.menu = id;
  menu.setAttribute('role', 'menu');
  const searchable = items.length > 8;
  menu.innerHTML = `
    ${searchable ? `<input type="text" class="issues-menu-search" placeholder="${escapeHtml(t('tickets.filters.search'))}" spellcheck="false">` : ''}
    <div class="issues-menu-items"></div>`;
  root.querySelector('.issues-panel').appendChild(menu);
  const panelBox = root.querySelector('.issues-panel').getBoundingClientRect();
  const box = anchor.getBoundingClientRect();
  menu.style.top = `${box.bottom - panelBox.top + 4}px`;
  menu.style.left = `${Math.max(0, box.left - panelBox.left)}px`;
  state.menu = { id, single, anchor, filter: '' };
  anchor.setAttribute('aria-expanded', 'true');
  renderMenuItems();
  (menu.querySelector('.issues-menu-search') || menu.querySelector('.issues-menu-item'))?.focus();
}

function renderMenuItems() {
  const menu = root?.querySelector('.issues-menu');
  if (!menu || !state.menu) return;
  const { id, single, filter } = state.menu;
  const selected = menuSelection(id);
  const needle = filter.toLowerCase();
  const items = menuItems(id).filter((item) => !needle || item.label.toLowerCase().includes(needle));
  menu.querySelector('.issues-menu-items').innerHTML = items.length
    ? items.map((item) => {
      const on = selected.includes(item.value);
      return `<button type="button" class="issues-menu-item${item.header ? ' header' : ''}${item.indent ? ' indent' : ''}"
          role="${single ? 'menuitemradio' : 'menuitemcheckbox'}" aria-checked="${on}" data-value="${escapeHtml(String(item.value))}" data-type="${typeof item.value}">
          <span class="issues-menu-check" aria-hidden="true">${on ? '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>' : ''}</span>
          ${item.icon || ''}
          <span class="issues-menu-label">${escapeHtml(item.label)}</span>
        </button>`;
    }).join('')
    : `<div class="issues-menu-empty">${escapeHtml(t('tickets.filters.noMatch'))}</div>`;
}

function closeMenu() {
  const menu = root?.querySelector('.issues-menu');
  if (menu) menu.remove();
  if (state?.menu?.anchor) state.menu.anchor.setAttribute('aria-expanded', 'false');
  if (state) state.menu = null;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderAll() {
  if (!root) return;
  root.innerHTML = `
    <div class="issues-panel">
      <div class="issues-header"></div>
      <div class="issues-toolbar"></div>
      <div class="issues-body">
        <div class="issues-list" role="grid" aria-label="${escapeHtml(t('tickets.panel.title'))}"></div>
        <aside class="issues-detail" hidden></aside>
      </div>
    </div>`;
  MarkdownRenderer.attachInteractivity(root.querySelector('.issues-detail'));
  renderHeader();
  renderToolbar();
  renderList();
  renderDetail();
}

function renderHeader() {
  const el = root?.querySelector('.issues-header');
  if (!el) return;
  const conn = state.connection;
  const switcher = state.connections.length > 1
    ? `<button type="button" class="issues-filter-btn issues-connection-btn" data-menu-connection aria-haspopup="menu">${escapeHtml(conn?.workspace?.name || '')} <span aria-hidden="true">&#9662;</span></button>`
    : conn ? `<span class="issues-workspace">${escapeHtml(conn.providerName)} · ${escapeHtml(conn.workspace?.name || '')}</span>` : '';
  const count = conn && !state.error && state.lastLoadedAt
    ? `<span class="issues-count">${state.issues.length}${state.next ? '+' : ''}</span>` : '';
  const updated = state.lastLoadedAt
    ? `<span class="issues-updated">${escapeHtml(t('tickets.panel.updatedAt', { time: view.relativeTime(new Date(state.lastLoadedAt).toISOString()) }))}</span>` : '';
  el.innerHTML = `
    <h2 class="issues-title">${escapeHtml(t('tickets.panel.title'))}</h2>
    ${switcher}
    ${count}
    <span class="issues-header-spacer"></span>
    ${updated}
    ${conn ? `<button type="button" class="issues-icon-btn issues-refresh" title="${escapeHtml(t('tickets.panel.refresh'))}" aria-label="${escapeHtml(t('tickets.panel.refresh'))}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/></svg>
    </button>` : ''}`;
}

function filterButton(id, label, count) {
  return `<button type="button" class="issues-filter-btn${count ? ' active' : ''}" data-menu="${escapeHtml(id)}" aria-haspopup="menu" aria-expanded="false">
    ${escapeHtml(label)}${count ? ` <span class="issues-filter-count">${count}</span>` : ''} <span aria-hidden="true">&#9662;</span>
  </button>`;
}

function renderToolbar() {
  const el = root?.querySelector('.issues-toolbar');
  if (!el) return;
  if (!state.connection || !state.metadata) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const v = state.view;
  const caps = state.provider?.capabilities || {};
  const quick = [[null, 'tickets.quick.all'], ['assigned', 'tickets.quick.assigned'], ['created', 'tickets.quick.created'], ['subscribed', 'tickets.quick.subscribed']]
    .map(([value, key]) => `<button type="button" class="issues-quick-btn${v.mine === value ? ' active' : ''}" data-mine="${value || ''}" aria-pressed="${v.mine === value}">${escapeHtml(t(key))}</button>`)
    .join('');
  const facets = (state.metadata.facets || [])
    .map((f) => filterButton(`facet:${f.id}`, view.facetLabel(f), (v.facets[f.id] || []).length))
    .join('');
  const groupLabel = view.groupByOptions(state.metadata, caps).find((o) => o.id === v.groupBy)?.label || '';

  let search = el.querySelector('.issues-search');
  const searchValue = search ? search.value : v.text;
  el.innerHTML = `
    <div class="issues-quick" role="group">${quick}</div>
    <input type="search" class="issues-search" placeholder="${escapeHtml(t('tickets.panel.searchPlaceholder'))}" spellcheck="false" aria-label="${escapeHtml(t('tickets.panel.searchPlaceholder'))}">
    <div class="issues-filter-buttons">
      ${filterButton('status', t('tickets.filters.status'), v.status.length)}
      ${filterButton('assignee', t('tickets.filters.assignee'), v.assigneeIds.length)}
      ${caps.priority ? filterButton('priority', t('tickets.filters.priority'), v.priorities.length) : ''}
      ${caps.labels ? filterButton('labels', t('tickets.filters.labels'), v.labelIds.length) : ''}
      ${facets}
      ${view.isDefaultView(v) ? '' : `<button type="button" class="issues-reset">${escapeHtml(t('tickets.panel.resetFilters'))}</button>`}
    </div>
    <div class="issues-display-buttons">
      ${filterButton('groupBy', t('tickets.filters.groupByValue', { value: groupLabel }), 0)}
      ${filterButton('sort', t('tickets.filters.sortValue', { value: sortLabel(v.sort) }), 0)}
    </div>`;
  search = el.querySelector('.issues-search');
  search.value = searchValue;
  if (state.menu) {
    const anchor = [...el.querySelectorAll('[data-menu]')].find((b) => b.dataset.menu === state.menu.id);
    if (anchor) {
      state.menu.anchor = anchor;
      anchor.setAttribute('aria-expanded', 'true');
    }
  }
}

function renderList() {
  const el = root?.querySelector('.issues-list');
  if (!el) return;

  if (state.error && !state.issues.length) {
    const auth = state.error.code === 'AUTH';
    el.innerHTML = `
      <div class="issues-state issues-state-error" role="alert">
        <p>${escapeHtml(state.error.code ? errorText(state.error) : t('tickets.errors.provider', { provider: '', message: state.error.error || '' }))}</p>
        ${auth ? `<button type="button" class="btn-sm btn-secondary issues-open-settings">${escapeHtml(t('tickets.errors.openSettings'))}</button>`
    : `<button type="button" class="btn-sm btn-secondary issues-retry">${escapeHtml(t('tickets.panel.retry'))}</button>`}
      </div>`;
    return;
  }
  if (!state.connection) {
    el.innerHTML = `
      <div class="issues-state">
        <svg class="issues-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 5v12" stroke-dasharray="2 2"/></svg>
        <p class="issues-state-title">${escapeHtml(t('tickets.panel.noConnection'))}</p>
        <p>${escapeHtml(t('tickets.panel.noConnectionHint'))}</p>
        <button type="button" class="btn-sm issues-open-settings issues-primary">${escapeHtml(t('tickets.panel.connect'))}</button>
      </div>`;
    return;
  }
  if (!state.metadata || (state.loading && !state.issues.length)) {
    el.innerHTML = `<div class="issues-state"><p>${escapeHtml(t('tickets.panel.loading'))}</p></div>`;
    return;
  }
  if (!state.issues.length) {
    el.innerHTML = `
      <div class="issues-state">
        <p>${escapeHtml(t('tickets.panel.empty'))}</p>
        <button type="button" class="btn-sm btn-secondary issues-reset">${escapeHtml(t('tickets.panel.resetFilters'))}</button>
      </div>`;
    return;
  }

  const groups = view.groupIssues(state.issues, state.view.groupBy, state.metadata);
  const focusedKey = el.contains(document.activeElement) ? document.activeElement.closest('.issue-row')?.dataset.key : null;
  el.classList.toggle('loading', state.loading);
  el.innerHTML = view.groupsHtml(groups, { selectedRef: state.selectedRef, collapsed: state.collapsed })
    + (state.next
      ? `<div class="issues-more"><button type="button" class="btn-sm btn-secondary issues-load-more"${state.loadingMore ? ' disabled' : ''}>${escapeHtml(state.loadingMore ? t('tickets.panel.loading') : t('tickets.panel.loadMore'))}</button></div>`
      : '');
  // A redraw replaces the rows; give keyboard focus back to the one that had it.
  if (focusedKey) [...el.querySelectorAll('.issue-row')].find((r) => r.dataset.key === focusedKey)?.focus();
}

function renderDetail() {
  const el = root?.querySelector('.issues-detail');
  if (!el) return;
  if (!state.selectedRef) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }
  el.hidden = false;
  if (state.detailError) {
    el.innerHTML = `<div class="issues-state issues-state-error"><p>${escapeHtml(t('tickets.detail.loadFailed', { message: errorText(state.detailError) }))}</p></div>`;
    return;
  }
  if (!state.detail) {
    el.innerHTML = `<div class="issues-state"><p>${escapeHtml(t('tickets.panel.loading'))}</p></div>`;
    return;
  }
  el.innerHTML = view.detailHtml(state.detail, {
    renderMarkdown: (md) => MarkdownRenderer.render(md),
    providerName: state.provider?.name || state.connection?.providerName || '',
    metadata: state.metadata,
  });
  MarkdownRenderer.postProcess(el);
}

// ── Events ───────────────────────────────────────────────────────────────────

function on(target, type, handler) {
  target.addEventListener(type, handler);
  listeners.push(() => target.removeEventListener(type, handler));
}

async function onClick(event) {
  const target = event.target;

  const menuItem = target.closest('.issues-menu-item');
  if (menuItem && state.menu) {
    const raw = menuItem.dataset.value;
    const value = menuItem.dataset.type === 'number' ? Number(raw) : raw;
    if (state.menu.id === 'connection') {
      const conn = state.connections.find((c) => c.id === value);
      closeMenu();
      if (conn) await useConnection(conn);
      return;
    }
    const { single } = state.menu;
    applyMenuChoice(state.menu.id, value);
    if (single) closeMenu();
    else renderMenuItems();
    return;
  }
  if (target.closest('.issues-menu')) return;

  const menuBtn = target.closest('[data-menu]');
  if (menuBtn) {
    if (state.menu?.id === menuBtn.dataset.menu) closeMenu();
    else openMenu(menuBtn.dataset.menu, menuBtn);
    return;
  }
  if (target.closest('[data-menu-connection]')) {
    const btn = target.closest('[data-menu-connection]');
    if (state.menu?.id === 'connection') {
      closeMenu();
      return;
    }
    openConnectionMenu(btn);
    return;
  }
  closeMenu();

  const quick = target.closest('.issues-quick-btn');
  if (quick) {
    state.view.mine = quick.dataset.mine || null;
    viewChanged();
    return;
  }
  if (target.closest('.issues-reset')) return resetFilters();
  if (target.closest('.issues-refresh')) return loadConnections();
  if (target.closest('.issues-retry')) return state.connection ? loadIssues() : loadConnections();
  if (target.closest('.issues-open-settings')) return deps.openSettings('tickets');
  if (target.closest('.issues-load-more')) return loadMore();
  if (target.closest('.issue-detail-close')) return closeDetail();

  const action = target.closest('.issue-action');
  if (action && state.detail) {
    if (action.dataset.action === 'open') deps.api.dialog.openExternal(state.detail.url);
    else {
      const text = action.dataset.action === 'copy-branch' ? state.detail.branchName : state.detail.key;
      const ok = await copyText(text);
      deps.showToast({ type: ok ? 'success' : 'error', title: ok ? t('tickets.detail.copied') : t('common.errorOccurred'), message: ok ? text : '' });
    }
    return;
  }

  const header = target.closest('.issue-group-header');
  if (header) {
    const key = header.dataset.group;
    if (state.collapsed.has(key)) state.collapsed.delete(key);
    else state.collapsed.add(key);
    renderList();
    return;
  }

  const row = target.closest('.issue-row');
  if (row) selectIssue(row.dataset.key);
}

function openConnectionMenu(anchor) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'issues-menu';
  menu.dataset.menu = 'connection';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `<div class="issues-menu-items">${state.connections.map((c) => `
    <button type="button" class="issues-menu-item" role="menuitemradio" aria-checked="${c.id === state.connection?.id}" data-value="${escapeHtml(c.id)}" data-type="string">
      <span class="issues-menu-check" aria-hidden="true">${c.id === state.connection?.id ? '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" fill="currentColor"/></svg>' : ''}</span>
      <span class="issues-menu-label">${escapeHtml(`${c.providerName} · ${c.workspace?.name || c.id}`)}</span>
    </button>`).join('')}</div>`;
  root.querySelector('.issues-panel').appendChild(menu);
  const panelBox = root.querySelector('.issues-panel').getBoundingClientRect();
  const box = anchor.getBoundingClientRect();
  menu.style.top = `${box.bottom - panelBox.top + 4}px`;
  menu.style.left = `${Math.max(0, box.left - panelBox.left)}px`;
  state.menu = { id: 'connection', single: true, anchor, filter: '' };
}

function onInput(event) {
  if (event.target.matches('.issues-menu-search') && state.menu) {
    state.menu.filter = event.target.value;
    renderMenuItems();
    return;
  }
  if (event.target.matches('.issues-search')) {
    clearTimeout(timers.search);
    const value = event.target.value.trim();
    timers.search = setTimeout(() => {
      if (state.view.text === value) return;
      state.view.text = value;
      loadIssues();
      renderToolbarResetOnly();
    }, SEARCH_DEBOUNCE_MS);
  }
}

/** The reset button follows the search text without redrawing the input being typed in. */
function renderToolbarResetOnly() {
  const buttons = root?.querySelector('.issues-filter-buttons');
  if (!buttons) return;
  const has = !!buttons.querySelector('.issues-reset');
  const wants = !view.isDefaultView(state.view);
  if (has === wants) return;
  if (wants) buttons.insertAdjacentHTML('beforeend', `<button type="button" class="issues-reset">${escapeHtml(t('tickets.panel.resetFilters'))}</button>`);
  else buttons.querySelector('.issues-reset').remove();
}

function onKeydown(event) {
  if (event.key === 'Enter' && event.target.matches('.issue-row')) {
    event.preventDefault();
    selectIssue(event.target.dataset.key);
  }
}

/**
 * Escape is heard on the document, not on the panel: opening a ticket redraws
 * the list, the focused row goes with it, and focus falls back to <body>. A
 * modal above the screen keeps its own Escape.
 */
function onDocumentKeydown(event) {
  // Registered only while the tab is shown: cleanup() removes it on deactivate.
  if (event.key !== 'Escape' || !root) return;
  if (document.querySelector('#modal-overlay.active')) return;
  if (state.menu) closeMenu();
  else if (state.selectedRef) closeDetail();
}

function onDocumentMousedown(event) {
  if (!state?.menu || !root) return;
  if (event.target.closest('.issues-menu') || event.target.closest('[data-menu], [data-menu-connection]')) return;
  closeMenu();
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

function startPolling() {
  clearInterval(timers.poll);
  timers.poll = setInterval(() => {
    // Only while someone can see it: the tab is shown and the window focused.
    if (!root || !root.isConnected || root.offsetParent === null || !document.hasFocus()) return;
    if (state.loading || state.menu) return;
    loadIssues({ silent: true });
  }, POLL_MS);
}

/**
 * Mount (or re-mount) the screen into `container`. State kept from a previous
 * visit is drawn at once, then refreshed.
 */
async function loadPanel(container) {
  cleanup();
  root = container;
  if (!state) state = freshState();
  renderAll();
  on(root, 'click', onClick);
  on(root, 'input', onInput);
  on(root, 'keydown', onKeydown);
  on(document, 'mousedown', onDocumentMousedown);
  on(document, 'keydown', onDocumentKeydown);
  startPolling();
  await loadConnections();
}

/** Leave the tab: stop the timers and the listeners, keep what was loaded. */
function cleanup() {
  clearInterval(timers.poll);
  clearTimeout(timers.search);
  clearTimeout(timers.reload);
  for (const off of listeners) off();
  listeners = [];
  if (state) closeMenu();
}

/** Tests only: forget everything, as a fresh start of the app would. */
function _reset() {
  cleanup();
  clearTimeout(timers.save);
  state = null;
  root = null;
  seq = 0;
  detailSeq = 0;
}

module.exports = { init, loadPanel, cleanup, _reset };
