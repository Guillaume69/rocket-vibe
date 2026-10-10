import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CATALOGUES,
  LANGUAGES,
  timeFormatter,
  dayFormatter,
  listTimeFormatter,
  deviceLanguage,
  translate,
} from './messages.ts';

describe('translate', () => {
  test('substitutes the {param}s', () => {
    assert.equal(translate('fr', 'messageRow.profileOf', { name: 'alice' }), 'Profil de alice');
    assert.equal(translate('en', 'messageRow.profileOf', { name: 'alice' }), 'Profile of alice');
  });

  test('a {param} without a value is left as is (to spot an omission)', () => {
    assert.equal(translate('fr', 'messageRow.profileOf'), 'Profil de {name}');
  });

  test('FR plural: singular for 0 and 1, plural from 2', () => {
    assert.equal(translate('fr', 'messageRow.replies', { n: 0 }), '0 réponse');
    assert.equal(translate('fr', 'messageRow.replies', { n: 1 }), '1 réponse');
    assert.equal(translate('fr', 'messageRow.replies', { n: 2 }), '2 réponses');
  });

  test('EN plural: singular for 1 only (0 is plural)', () => {
    assert.equal(translate('en', 'messageRow.replies', { n: 0 }), '0 replies');
    assert.equal(translate('en', 'messageRow.replies', { n: 1 }), '1 reply');
    assert.equal(translate('en', 'messageRow.replies', { n: 2 }), '2 replies');
  });
});

describe('catalogue', () => {
  test('both languages have EXACTLY the same keys', () => {
    // The type already enforces this at compile time; this test proves it at
    // runtime and catches a divergence slipped in through a forced cast.
    const frKeys = Object.keys(CATALOGUES.fr).sort();
    const enKeys = Object.keys(CATALOGUES.en).sort();
    assert.deepEqual(enKeys, frKeys);
  });

  test('no empty value', () => {
    for (const language of LANGUAGES) {
      for (const [key, value] of Object.entries(CATALOGUES[language])) {
        assert.notEqual(value.trim(), '', `${language}/${key} is empty`);
      }
    }
  });
});

describe('timeFormatter', () => {
  // Assert the SHAPE, not the value: the formatter follows the runner's local
  // time zone, which we do not pin. The `\s` in the EN pattern covers the
  // narrow no-break space (U+202F) ICU puts before AM/PM.
  test('FR in 24 h two-digit format, EN in 12 h AM/PM format', () => {
    const ms = Date.UTC(2026, 0, 15, 14, 5, 0);
    assert.match(timeFormatter('fr')(ms), /^\d{2}:\d{2}$/u);
    assert.match(timeFormatter('en')(ms), /^\d{1,2}:\d{2}\s[AP]M$/u);
  });
});

describe('dayFormatter', () => {
  // Dates built in LOCAL TIME (noon: far from day boundaries) and `now`
  // injected: nothing depends on the runner's time zone or clock.
  const now = new Date(2026, 7, 1, 12).getTime(); // Saturday 1 August 2026

  test("today and yesterday go through the catalogue, not the date", () => {
    assert.equal(dayFormatter('fr')(now, now), "Aujourd'hui");
    assert.equal(dayFormatter('fr')(new Date(2026, 6, 31, 9).getTime(), now), 'Hier');
    assert.equal(dayFormatter('en')(now, now), 'Today');
    assert.equal(dayFormatter('en')(new Date(2026, 6, 31, 9).getTime(), now), 'Yesterday');
  });

  test("the current year carries the weekday, another year carries the year", () => {
    assert.equal(dayFormatter('fr')(new Date(2026, 6, 30, 12).getTime(), now), 'jeudi 30 juillet');
    assert.equal(dayFormatter('fr')(new Date(2025, 6, 30, 12).getTime(), now), '30 juillet 2025');
    assert.equal(dayFormatter('en')(new Date(2026, 6, 30, 12).getTime(), now), 'Thursday, July 30');
    assert.equal(dayFormatter('en')(new Date(2025, 6, 30, 12).getTime(), now), 'July 30, 2025');
  });
});

describe('listTimeFormatter', () => {
  const now = new Date(2026, 7, 1, 12).getTime(); // Saturday 1 August 2026

  test('the hour today, the weekday this week, the date beyond', () => {
    assert.match(listTimeFormatter('fr')(new Date(2026, 7, 1, 9, 5).getTime(), now), /^09:05$/u);
    assert.equal(listTimeFormatter('fr')(new Date(2026, 6, 30, 12).getTime(), now), 'jeu.');
    assert.equal(listTimeFormatter('en')(new Date(2026, 6, 30, 12).getTime(), now), 'Thu');
    assert.equal(listTimeFormatter('fr')(new Date(2026, 6, 20, 12).getTime(), now), '20/07/2026');
    assert.equal(listTimeFormatter('en')(new Date(2026, 6, 20, 12).getTime(), now), '07/20/2026');
  });

  test('no time without a message', () => {
    assert.equal(listTimeFormatter('en')(0, now), '');
  });
});

describe('deviceLanguage', () => {
  test('returns a covered language, never anything else', () => {
    assert.ok(LANGUAGES.includes(deviceLanguage()));
  });
});
