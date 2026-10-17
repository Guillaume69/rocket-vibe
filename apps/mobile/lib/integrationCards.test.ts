import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type CardAction, cardActionRoute, filterMenuOptions, menuLabel, pressCardAction } from './integrationCards.ts';

function recorder() {
  const seen: string[] = [];
  return {
    seen,
    then: {
      note: (text: string) => seen.push(`note:${text}`),
      open: (url: string) => seen.push(`open:${url}`),
      failed: () => seen.push('failed'),
    },
  };
}

describe('pressCardAction', () => {
  test('a refused or unreachable press says the action failed, nothing else', async () => {
    const r = recorder();
    await pressCardAction(() => Promise.reject(new Error('400')), r.then);
    assert.deepEqual(r.seen, ['failed']);
  });

  test('the answer becomes a note and opens only an http(s) link', async () => {
    const r = recorder();
    await pressCardAction(async () => ({ ephemeralText: 'Done', gotoLocation: 'https://example.com/x' }), r.then);
    await pressCardAction(async () => ({ ephemeralText: null, gotoLocation: 'javascript:alert(1)' }), r.then);
    await pressCardAction(async () => ({ ephemeralText: null, gotoLocation: null }), r.then);
    assert.deepEqual(r.seen, ['note:Done', 'open:https://example.com/x']);
  });
});

describe('cardActionRoute', () => {
  test('an id that could leave the route is refused', () => {
    assert.equal(cardActionRoute('p1', 'confirm_2'), '/posts/p1/actions/confirm_2');
    assert.equal(cardActionRoute('p1', '../../users/me/sessions/revoke/all'), null);
    assert.equal(cardActionRoute('p1', '..'), null);
    assert.equal(cardActionRoute('p1', '%2e%2e'), null);
    assert.equal(cardActionRoute('', 'a'), null);
  });
});

describe('card menus', () => {
  const options = [{ label: 'Élevée', value: 'high' }, { label: 'Basse', value: 'low' }];
  const menu = (initial: string | null): CardAction => ({ id: 'm', name: 'Priority', style: null, cookie: null, menu: { source: 'options', options, initial } });

  test('a menu shows the choice made, else its listed default, else its name', () => {
    assert.equal(menuLabel(menu('low'), 'Élevée'), 'Élevée');
    assert.equal(menuLabel(menu('low'), null), 'Basse');
    assert.equal(menuLabel(menu('gone'), null), 'Priority');
    assert.equal(menuLabel(menu(null), null), 'Priority');
  });

  test('typing filters the listed choices, case and accents ignored', () => {
    assert.deepEqual(filterMenuOptions(options, ' elev '), [options[0]]);
    assert.deepEqual(filterMenuOptions(options, ''), options);
    assert.deepEqual(filterMenuOptions(options, 'zz'), []);
  });

  test('a press that fails reports false, one that answers true', async () => {
    const r = recorder();
    assert.equal(await pressCardAction(() => Promise.reject(new Error('no')), r.then), false);
    assert.equal(await pressCardAction(() => Promise.resolve({ ephemeralText: null, gotoLocation: null }), r.then), true);
  });
});
