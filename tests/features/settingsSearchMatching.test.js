/**
 * The settings filter's second pass.
 *
 * The first pass is a literal substring match on the localized strings; these
 * are the queries it cannot answer, and which used to be served by a separate
 * search component with its own results list. That component is gone, so this
 * suite is what keeps its two reasons for existing alive:
 * a word in the other language, and a word we never shipped.
 */

const { initI18n } = require('../../src/renderer/i18n');
const {
  normalize,
  matches,
  englishAliases,
  bilingualMatch,
  resetAliasCache,
} = require('../../src/renderer/ui/components/settingsSearchMatching');

beforeEach(() => {
  resetAliasCache();
  initI18n('fr');
});

describe('normalize', () => {
  test('folds accents, case and separators so one spelling reaches the other', () => {
    expect(normalize('Démarrage')).toBe('demarrage');
    expect(normalize('Auto-Update')).toBe('auto update');
    expect(normalize('  spaced   out  ')).toBe('spaced out');
  });
});

describe('synonyms', () => {
  test('a word we never shipped still finds the setting', () => {
    expect(matches('permissions', 'autorisations')).toBe(true);
    expect(matches('raccourcis clavier', 'shortcut')).toBe(true);
  });

  test('several words narrow rather than widen', () => {
    expect(matches('raccourcis clavier', 'shortcut clavier')).toBe(true);
    expect(matches('raccourcis clavier', 'shortcut souris')).toBe(false);
  });

  test('an empty query matches nothing, so the caller decides what "no filter" means', () => {
    expect(matches('raccourcis', '')).toBe(false);
  });
});

describe('English originals', () => {
  // 'reset' is deliberately not in the synonym table, and "Réinitialiser" does
  // not contain it - so only the en.json pairing can match this one.
  const RESET_ALL = 'Réinitialiser tous les raccourcis';   // shortcuts.resetAll

  test('a French label carries the English original it was translated from', () => {
    expect(englishAliases(normalize(RESET_ALL))).toContain('reset all shortcuts');
  });

  test('so the English word reaches the French label', () => {
    expect(bilingualMatch(RESET_ALL, 'reset')).toBe(true);
  });

  test('and an unrelated word still does not', () => {
    expect(bilingualMatch(RESET_ALL, 'mermaid')).toBe(false);
  });

  test('a label too short to pair safely yields no alias', () => {
    // Guards the length floor: without it a two-letter translation would be a
    // substring of half the screen and every row would match everything.
    expect(englishAliases('ok')).toEqual([]);
  });

  test('an empty label never matches', () => {
    expect(bilingualMatch('', 'account')).toBe(false);
  });
});

describe('the alias cache follows the language', () => {
  test('switching language rebuilds the pairs instead of serving the old ones', () => {
    const RESET_ALL = 'Réinitialiser tous les raccourcis';
    expect(englishAliases(normalize(RESET_ALL))).toContain('reset all shortcuts');

    initI18n('en');
    // The pairs now map English onto itself, so no English value is a substring
    // of that French text. A stale cache would still answer "reset all shortcuts".
    expect(englishAliases(normalize(RESET_ALL))).toEqual([]);
  });
});
