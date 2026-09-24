import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { estLienWeb, peutSortirDuProcessus, porteUnIdentifiant } from './lienExterne.ts';

describe('estLienWeb', () => {
  test('http et https, quelle que soit la casse', () => {
    assert.equal(estLienWeb('https://exemple.org/a'), true);
    assert.equal(estLienWeb('HTTP://exemple.org'), true);
  });

  test('tout autre schéma est refusé', () => {
    for (const u of [
      'javascript:alert(1)',
      'intent://scan#Intent;scheme=zxing;end',
      'file:///data/data/com.rocketvibe.app/databases/x.db',
      'content://media/external/images/1',
      'data:text/html,<script>x</script>',
      'rocketvibe://salon/abc',
      '//exemple.org/a',
      ' https://exemple.org',
    ]) {
      assert.equal(estLienWeb(u), false, u);
    }
  });

  test('ce qui n’est pas une chaîne est refusé', () => {
    for (const v of [null, undefined, 42, {}, ['https://x']]) {
      assert.equal(estLienWeb(v), false, JSON.stringify(v));
    }
  });
});

describe('porteUnIdentifiant', () => {
  test('reconnaît nos deux paramètres, où qu’ils soient dans la query', () => {
    assert.equal(porteUnIdentifiant('https://h/f?rc_uid=u&rc_token=t'), true);
    assert.equal(porteUnIdentifiant('https://h/f?etag=1&rc_token=t'), true);
    assert.equal(porteUnIdentifiant('https://h/f?RC_TOKEN=t'), true);
  });

  test('une URL ordinaire n’en porte pas', () => {
    assert.equal(porteUnIdentifiant('https://h/f?etag=abc'), false);
    assert.equal(porteUnIdentifiant('https://github.com/RocketChat/Rocket.Chat'), false);
  });
});

describe('peutSortirDuProcessus', () => {
  test('un lien web ordinaire peut sortir', () => {
    assert.equal(peutSortirDuProcessus('https://github.com/RocketChat/Rocket.Chat'), true);
  });

  test('AUCUNE URL portant le jeton ne sort — c’est l’invariant du chantier', () => {
    // La forme exacte que produisait `urlFichierProtege` avant la correction :
    // elle partait dans un intent VIEW, donc dans Chrome et son historique.
    const fuite =
      'https://chat.barrut.me/file-upload/BsN3iJ/rapport.pdf?rc_uid=uid-alice&rc_token=jeton-alice';
    assert.equal(estLienWeb(fuite), true, 'c’est bien du web…');
    assert.equal(peutSortirDuProcessus(fuite), false, '…et pourtant elle ne sort pas');
  });

  test('un schéma non web ne sort pas non plus', () => {
    assert.equal(peutSortirDuProcessus('file:///sdcard/x.pdf'), false);
  });
});
