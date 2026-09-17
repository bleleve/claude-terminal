'use strict';
/**
 * Bilingual, synonym-aware matching for the settings filter.
 *
 * `applySettingsFilter` matches on the localized label and description with a
 * plain substring pass, which is also what drives the highlight. This is the
 * second pass, for the two queries that pass cannot answer:
 *
 *   - a word in the other language. Settings are the one screen people look for
 *     by the name they read in a changelog or an issue - which is English -
 *     while their UI is in their own language. Every localized string is paired
 *     with the en.json original it was translated from, so `shortcut` finds
 *     "Raccourcis" and `raccourci` finds "Shortcuts".
 *   - a word that is simply not the one we shipped. "autorisations" and
 *     "permissions" name the same setting to everyone except a substring match.
 *
 * Labels only, deliberately: nothing here reads a control's value, so a token
 * or a password typed into a settings field never becomes searchable.
 */

const { t, getCurrentLanguage } = require('../../i18n');
const english = require('../../i18n/locales/en.json');

/** Accents, case and separators removed, so "Démarrage" and "demarrage" meet. */
function normalize(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Words users reach for that are not the word on screen. Each group is
// interchangeable in both directions; all entries are already normalized.
const SYNONYMS = [
  ['startup', 'demarrage', 'launch', 'lancement'],
  ['shortcut', 'shortcuts', 'raccourci', 'raccourcis'],
  ['permissions', 'permission', 'autorisation', 'autorisations'],
  ['model', 'modele'],
  ['notification', 'notifications', 'alertes'],
  ['font', 'police', 'typographie'],
  ['account', 'accounts', 'compte', 'comptes'],
  ['language', 'langue', 'langues'],
  ['editor', 'editeur'],
  ['theme', 'appearance', 'apparence'],
  ['backup', 'sauvegarde'],
];

/**
 * Every word of `query` present in `text`, each word free to arrive as any of
 * its synonyms. AND across words so a second word narrows rather than widens.
 * @param {string} text - already normalized
 * @param {string} query - raw user input
 */
function matches(text, query) {
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return false;
  return words.every(word => {
    const alternatives = SYNONYMS.find(group => group.includes(word)) || [word];
    return alternatives.some(term => text.includes(term));
  });
}

/** Walk a locale subtree, pairing each key's current translation with its English. */
function collectPairs(object, prefix, out) {
  for (const [key, value] of Object.entries(object)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.push([normalize(t(full)), normalize(value)]);
    else if (value && typeof value === 'object') collectPairs(value, full, out);
  }
  return out;
}

// Built once per set of translations in effect. Keying this on the language
// name alone is not enough, and the way it fails is silent: t() answers out of
// the built-in English defaults before a locale file has been loaded, while
// getCurrentLanguage() already reports the target language. The pairs would be
// built English-to-English, and loading French afterwards would change no
// language name, so nothing would ever invalidate them.
//
// The probe's own translation is what actually moves in both cases - a late
// load and a real switch - so it is the key, with the language beside it for
// the locales that might translate it identically.
let _pairs = null;
let _pairsKey = null;

/** Present in every locale, and short enough to read on every call. */
const LOADED_PROBE_KEY = 'settings.language';

function pairs() {
  const probe = t(LOADED_PROBE_KEY);
  // t() echoes the key back when nothing at all is loaded. Indexing that would
  // pair every setting with a literal key string.
  if (probe === LOADED_PROBE_KEY) return [];

  const key = `${getCurrentLanguage()}\u0000${probe}`;
  if (_pairs && _pairsKey === key) return _pairs;
  _pairsKey = key;
  _pairs = collectPairs({
    settings: english.settings,
    shortcuts: english.shortcuts,
    accounts: english.accounts,
  }, '', []);
  return _pairs;
}

/**
 * The English originals of whatever localized strings this text is built from.
 *
 * Short translations are skipped: a two-letter string is a substring of half the
 * settings screen, and one false pair makes every row match.
 *
 * @param {string} normalizedText
 * @returns {string[]} normalized English labels
 */
function englishAliases(normalizedText) {
  if (!normalizedText) return [];
  return pairs()
    .filter(([localized]) => localized.length >= 4 && normalizedText.includes(localized))
    .map(([, en]) => en);
}

/**
 * Does `text` match `query` once synonyms and the English originals are allowed?
 * The caller runs this only after its own substring pass has failed.
 */
function bilingualMatch(text, query) {
  const normalized = normalize(text);
  if (!normalized) return false;
  return matches(normalize([normalized, ...englishAliases(normalized)].join(' ')), query);
}

/** Test seam: drop the per-language cache. */
function resetAliasCache() {
  _pairs = null;
  _pairsKey = null;
}

module.exports = { normalize, matches, englishAliases, bilingualMatch, resetAliasCache };
