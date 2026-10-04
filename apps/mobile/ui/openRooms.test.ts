import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createOpenRoomsStack } from './openRooms.ts';

describe('salonsOuverts', () => {
  test('sans écran salon monté, il n’y a rien à rattraper', () => {
    assert.equal(createOpenRoomsStack().top(), undefined);
  });

  test('un seul écran : c’est lui', () => {
    const stack = createOpenRoomsStack();
    stack.declare('r1');
    assert.equal(stack.top(), 'r1');
  });

  test('DEUX écrans empilés : le rattrapage vise celui du dessus', () => {
    const stack = createOpenRoomsStack();
    stack.declare('r1');
    stack.declare('r2');
    assert.equal(stack.top(), 'r2');
  });

  test('au retour arrière, le salon du DESSOUS redevient la cible', () => {
    // Le défaut corrigé : le cleanup de l'écran du dessus posait `null` alors
    // qu'un salon restait affiché, et plus aucun raccordement ne rattrapait
    // quoi que ce soit — pour toute la durée de vie de l'écran restant.
    const stack = createOpenRoomsStack();
    stack.declare('r1');
    const renderR2 = stack.declare('r2');

    renderR2();

    assert.equal(stack.top(), 'r1');
  });

  test('deux écrans sur le MÊME salon : dépiler l’un laisse l’autre', () => {
    // Un lien profond peut rouvrir un salon déjà ouvert. Retirer « la première
    // occurrence de r1 » marcherait ici par accident ; retirer la déclaration
    // exacte marche toujours.
    const stack = createOpenRoomsStack();
    const renderFirst = stack.declare('r1');
    stack.declare('r1');

    renderFirst();

    assert.equal(stack.top(), 'r1', 'il en reste un');
  });

  test('démontages dans le DÉSORDRE : le sommet reste juste', () => {
    // React ne garantit pas l'ordre des cleanups entre écrans d'une même
    // transition (`replace` démonte l'ancien et monte le nouveau).
    const stack = createOpenRoomsStack();
    const renderR1 = stack.declare('r1');
    stack.declare('r2');

    renderR1(); // c'est celui du DESSOUS qui s'en va

    assert.equal(stack.top(), 'r2');
  });

  test('rendre deux fois la même déclaration n’enlève pas celle d’un autre', () => {
    const stack = createOpenRoomsStack();
    const renderR1 = stack.declare('r1');
    stack.declare('r2');

    renderR1();
    renderR1();

    assert.equal(stack.top(), 'r2');
  });

  test('chaque session a SA pile', () => {
    const a = createOpenRoomsStack();
    const b = createOpenRoomsStack();
    a.declare('r1');
    assert.equal(b.top(), undefined);
  });
});
