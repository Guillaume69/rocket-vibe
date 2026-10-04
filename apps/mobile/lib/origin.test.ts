import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { sameOrigin, originOf } from './origin.ts';

describe('origineDe', () => {
  test('scheme + authority, sans le chemin', () => {
    assert.equal(originOf('https://chat.barrut.me/file-upload/abc/x.pdf'), 'https://chat.barrut.me');
    assert.equal(originOf('http://10.0.2.2:3300/api/v1/me'), 'http://10.0.2.2:3300');
  });

  test('le port fait partie de l’origine', () => {
    assert.notEqual(originOf('http://h:3300/x'), originOf('http://h:3301/x'));
  });

  test('la casse de l’hôte ne compte pas', () => {
    assert.equal(originOf('https://Chat.Barrut.ME/x'), originOf('https://chat.barrut.me/x'));
  });

  test('sans chemin, avec ou sans barre finale', () => {
    assert.equal(originOf('https://chat.barrut.me'), 'https://chat.barrut.me');
    assert.equal(originOf('https://chat.barrut.me/'), 'https://chat.barrut.me');
  });

  test('query ou fragment collés à l’hôte ne débordent pas dans l’origine', () => {
    assert.equal(originOf('https://chat.barrut.me?x=1'), 'https://chat.barrut.me');
    assert.equal(originOf('https://chat.barrut.me#a'), 'https://chat.barrut.me');
  });

  test('ce qui n’est pas du web rend null', () => {
    for (const u of ['javascript:alert(1)', 'file:///etc/passwd', 'intent://x', 'ftp://h/x', '', '/x']) {
      assert.equal(originOf(u), null, u);
    }
  });

  test('le userinfo reste DANS l’autorité — sinon il masquerait le vrai hôte', () => {
    // Piège classique : `https://chat.barrut.me@evil.com/x` est servi par
    // evil.com. Réduire son origine à `https://chat.barrut.me` autoriserait la
    // fuite qu’on cherche justement à fermer.
    assert.equal(originOf('https://chat.barrut.me@evil.com/x'), 'https://chat.barrut.me@evil.com');
  });
});

describe('memeOrigine', () => {
  test('vrai sur le même serveur, chemin et query quelconques', () => {
    assert.equal(sameOrigin('https://h/file-upload/a/b.pdf?rc_uid=1', 'https://h'), true);
    assert.equal(sameOrigin('https://h/x', 'https://h/api/v1/'), true);
  });

  test('un hôte dont le nôtre est un PRÉFIXE est refusé', () => {
    // `startsWith` aurait dit oui : c’est le défaut que ce module évite.
    assert.equal(sameOrigin('https://h.evil.com/x', 'https://h'), false);
    assert.equal(sameOrigin('https://chat.barrut.me.evil.com/x', 'https://chat.barrut.me'), false);
  });

  test('scheme et port comptent', () => {
    assert.equal(sameOrigin('http://h/x', 'https://h'), false);
    assert.equal(sameOrigin('https://h:8443/x', 'https://h'), false);
  });

  test('un userinfo qui imite notre hôte est refusé', () => {
    assert.equal(sameOrigin('https://chat.barrut.me@evil.com/x', 'https://chat.barrut.me'), false);
  });

  test('une URL non web n’est jamais de notre origine', () => {
    assert.equal(sameOrigin('javascript:alert(1)', 'https://h'), false);
    assert.equal(sameOrigin('about:blank', 'https://h'), false);
  });

  test('une origine de référence illisible ne valide rien', () => {
    assert.equal(sameOrigin('https://h/x', 'pas-une-url'), false);
  });
});
