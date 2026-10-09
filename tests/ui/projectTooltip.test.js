/**
 * The compact hover card of a project row. Its terminal count was written as
 * the literal "terminaux", so every language but French read a French word.
 */

'use strict';

const { setLanguage } = require('../../src/renderer/i18n');
const { ProjectList } = require('../../src/renderer/ui/components/ProjectList');

function tooltipOf(stats) {
  const list = new ProjectList(document.createElement('div'));
  list.setCallbacks({ getTerminalStatsForProject: () => stats });
  const html = list._renderProjectHtml({ id: 'p-acme', name: 'acme-app', path: '/work/acme-app', type: 'general' }, 0);
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.querySelector('.project-tooltip-terminals')?.textContent ?? null;
}

afterAll(() => setLanguage('fr'));

test.each([
  ['en', '1/3 terminals'],
  ['fr', '1/3 terminaux'],
  ['es', '1/3 terminales'],
])('the terminal count speaks %s', (lang, expected) => {
  setLanguage(lang);
  expect(tooltipOf({ total: 3, working: 1 })).toBe(expected);
});

test('a project without terminals has no count line', () => {
  setLanguage('en');
  expect(tooltipOf({ total: 0, working: 0 })).toBeNull();
});
