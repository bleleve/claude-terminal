const { initI18n } = require('../../src/renderer/i18n');
const { install } = require('../../src/renderer/ui/components/SettingsSearch');
beforeEach(() => {
  initI18n('fr');
  document.body.innerHTML = `<div class="settings-inline-wrapper">
    <button class="settings-tab active" data-tab="general">Général</button><button class="settings-tab" data-tab="claude">Claude</button>
    <div class="settings-content"><div data-panel="general" class="settings-panel active"></div>
    <div data-panel="claude" class="settings-panel"><div class="settings-toggle-row"><div class="settings-toggle-label">Permissions</div><input type="checkbox" id="permissions"></div>
    <div class="settings-row"><div class="settings-label">Comptes</div><input type="password" value="secret-not-searchable"></div></div></div></div>`;
  document.querySelectorAll('.settings-tab').forEach(tab => tab.onclick = () => {
    document.querySelectorAll('.settings-tab, .settings-panel').forEach(el => el.classList.remove('active'));
    tab.classList.add('active'); document.querySelector(`[data-panel="${tab.dataset.tab}"]`).classList.add('active');
  });
  install(document.body);
});
const search = query => { const input = document.querySelector('input[type="search"]'); input.value = query; input.dispatchEvent(new Event('input')); return input; };
test('FR synonyms find the setting in another tab and Enter focuses its control without changing it', () => {
  const input = search('autorisations');
  expect(document.querySelectorAll('#settings-search-results button')).toHaveLength(1);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(document.querySelector('[data-panel="claude"]').classList.contains('active')).toBe(true);
  expect(document.activeElement.id).toBe('permissions');
  expect(document.activeElement.checked).toBe(false);
  expect(input.value).toBe('');
});
test('English aliases match French labels while secret field values are excluded', () => {
  search('account'); expect(document.querySelectorAll('#settings-search-results button')).toHaveLength(1);
  search('secret-not-searchable'); expect(document.querySelectorAll('#settings-search-results button')).toHaveLength(0);
});
