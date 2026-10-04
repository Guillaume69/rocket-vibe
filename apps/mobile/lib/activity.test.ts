import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ActivityEngine } from './activity.ts';

/** Une promesse qu'on résout à la main, pour tenir un fetch « en vol ». */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('MoteurActivite', () => {
  test('la portée est allumée le temps du fetch, éteinte à sa résolution', async () => {
    const m = new ActivityEngine();
    const d = deferred();

    assert.equal(m.active('global'), false, 'au repos');
    const tracking = m.track('global', d.promise);
    assert.equal(m.active('global'), true, 'allumé dès le lancement (synchrone)');

    d.resolve();
    await tracking;
    assert.equal(m.active('global'), false, 'éteint à la fin');
  });

  test('un fetch qui échoue éteint quand même la portée, et rejette', async () => {
    const m = new ActivityEngine();
    const d = deferred();

    const tracking = m.track('r1', d.promise);
    d.reject(new Error('réseau'));

    await assert.rejects(tracking, /réseau/);
    assert.equal(m.active('r1'), false, 'pas de compteur bloqué en l’air');
  });

  test('deux fetches concurrents : la portée reste allumée tant qu’il en reste un', async () => {
    const m = new ActivityEngine();
    const a = deferred();
    const b = deferred();

    const its = m.track('r1', a.promise);
    const sb = m.track('r1', b.promise);
    assert.equal(m.active('r1'), true);

    a.resolve();
    await its;
    assert.equal(m.active('r1'), true, 'il en reste un — toujours allumé');

    b.resolve();
    await sb;
    assert.equal(m.active('r1'), false, 'le dernier éteint');
  });

  test('les portées sont indépendantes', async () => {
    const m = new ActivityEngine();
    const d = deferred();
    const tracking = m.track('global', d.promise);

    assert.equal(m.active('global'), true);
    assert.equal(m.active('r1'), false, 'une autre portée n’est pas touchée');

    d.resolve();
    await tracking;
  });

  test('n’avertit qu’aux BASCULES booléennes (0→1, 1→0), pas sur un concurrent', async () => {
    const m = new ActivityEngine();
    let notices = 0;
    m.onChange(() => {
      notices++;
    });

    const a = deferred();
    const b = deferred();
    m.track('r1', a.promise); // 0→1 : un avis
    m.track('r1', b.promise); // 1→2 : aucun
    assert.equal(notices, 1);

    a.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(notices, 1, '2→1 : toujours allumé, aucun avis');

    b.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(notices, 2, '1→0 : un avis d’extinction');
  });

  test('surChangement rend un désabonnement qui coupe les avis', async () => {
    const m = new ActivityEngine();
    let notices = 0;
    const detacher = m.onChange(() => {
      notices++;
    });
    detacher();

    const d = deferred();
    const tracking = m.track('global', d.promise);
    d.resolve();
    await tracking;
    assert.equal(notices, 0, 'plus abonné');
  });
});
