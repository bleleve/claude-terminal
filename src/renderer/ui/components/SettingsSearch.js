'use strict';
const { t } = require('../../i18n');
const english = require('../../i18n/locales/en.json');
const normalize = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
const synonyms = [
  ['startup', 'demarrage', 'launch', 'lancement'], ['shortcut', 'shortcuts', 'raccourci', 'raccourcis'],
  ['permissions', 'permission', 'autorisation', 'autorisations'], ['model', 'modele'],
  ['notification', 'notifications', 'alertes'], ['font', 'police', 'typographie'],
  ['account', 'accounts', 'compte', 'comptes'], ['language', 'langue', 'langues'],
  ['editor', 'editeur'], ['theme', 'appearance', 'apparence'], ['backup', 'sauvegarde'],
];
function translations(object, prefix = '', result = []) {
  for (const [key, value] of Object.entries(object)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') result.push([normalize(t(full)), normalize(value)]);
    else if (value && typeof value === 'object') translations(value, full, result);
  }
  return result;
}
function matches(text, query) {
  return normalize(query).split(' ').filter(Boolean).every(word => {
    const alternatives = synonyms.find(group => group.includes(word)) || [word];
    return alternatives.some(term => text.includes(term));
  });
}
function install(container) {
  const wrapper = container.querySelector('.settings-inline-wrapper');
  if (!wrapper) return;
  const search = document.createElement('div'); search.className = 'settings-search';
  const input = document.createElement('input'); input.type = 'search'; input.className = 'form-input';
  input.placeholder = t('settings.searchPlaceholder'); input.setAttribute('aria-label', input.placeholder);
  input.setAttribute('aria-controls', 'settings-search-results'); input.maxLength = 100;
  const results = document.createElement('div'); results.id = 'settings-search-results'; results.hidden = true;
  const status = document.createElement('div'); status.className = 'settings-search-status'; status.setAttribute('role', 'status');
  search.append(input, status, results); wrapper.prepend(search);
  const bilingual = translations({ settings: english.settings, shortcuts: english.shortcuts, accounts: english.accounts });
  const clear = () => { input.value = ''; results.replaceChildren(); results.hidden = true; status.textContent = ''; };
  input.addEventListener('input', () => {
    results.replaceChildren(); status.textContent = ''; results.hidden = !input.value.trim();
    if (results.hidden) return;
    const targets = [...container.querySelectorAll('.settings-row, .settings-toggle-row, .shortcut-row, .agent-color-row, .settings-group-title')];
    let count = 0;
    for (const target of targets) {
      const panel = target.closest('[data-panel]'); if (!panel) continue;
      // Labels only: never index text fields, passwords, tokens or user values.
      const label = target.querySelector('.settings-label, .settings-toggle-label, .shortcut-label, .shortcut-name, .agent-color-name')?.textContent ||
        (target.classList.contains('settings-group-title') ? target.textContent : target.querySelector('label')?.textContent);
      if (!label?.trim()) continue;
      const normalized = normalize(label);
      const enLabels = bilingual.filter(([local]) => local.length >= 4 && normalized.includes(local)).map(([, en]) => en);
      const ids = [...target.querySelectorAll('[id]')].map(el => el.id).join(' ');
      if (!matches(normalize([normalized, ids, ...enLabels].join(' ')), input.value)) continue;
      count++;
      const button = document.createElement('button'); button.type = 'button';
      const tab = [...container.querySelectorAll('.settings-tab')].find(el => el.dataset.tab === panel.dataset.panel);
      button.textContent = `${tab?.textContent || panel.dataset.panel} · ${label.trim().replace(/\s+/g, ' ')}`;
      button.addEventListener('click', () => {
        tab?.click(); clear();
        container.querySelectorAll('.settings-search-target').forEach(el => el.classList.remove('settings-search-target'));
        target.classList.add('settings-search-target'); target.scrollIntoView?.({ block: 'center' });
        const focus = target.querySelector('input:not([type="hidden"]), select, textarea, button, .settings-dropdown-trigger') || target;
        if (!focus.matches('input, select, textarea, button')) focus.tabIndex = -1;
        focus.focus({ preventScroll: true });
        focus.addEventListener('blur', () => target.classList.remove('settings-search-target'), { once: true });
      });
      results.append(button);
    }
    status.textContent = count ? t('settings.searchCount', { count }) : t('settings.searchEmpty');
  });
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); clear(); input.focus(); }
    if (event.target === input && ['ArrowDown', 'Enter'].includes(event.key)) {
      event.preventDefault(); const first = results.querySelector('button');
      if (event.key === 'Enter') first?.click(); else first?.focus();
    }
    if (event.target.matches('button') && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault(); (event.key === 'ArrowDown' ? event.target.nextElementSibling : event.target.previousElementSibling)?.focus();
    }
  });
}
module.exports = { install, matches };
