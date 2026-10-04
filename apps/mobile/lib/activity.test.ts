import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ActivityEngine } from './activity.ts';

/** Une promesse qu'on résout à la main, pour tenir un fetch « en vol ». */
function differee<T = void>() {
  let resoudre!: (v: T) => void;
  let rejeter!: (e: unknown) => void;
  const promesse = new Promise<T>((res, rej) => {
    resoudre = res;
    rejeter = rej;
  });
  return { promesse, resoudre, rejeter };
}

describe('MoteurActivite', () => {
  test('la portée est allumée le temps du fetch, éteinte à sa résolution', async () => {
    const m = new ActivityEngine();
    const d = differee();

    assert.equal(m.active('global'), false, 'au repos');
    const suivi = m.track('global', d.promesse);
    assert.equal(m.active('global'), true, 'allumé dès le lancement (synchrone)');

    d.resoudre();
    await suivi;
    assert.equal(m.active('global'), false, 'éteint à la fin');
  });

  test('un fetch qui échoue éteint quand même la portée, et rejette', async () => {
    const m = new ActivityEngine();
    const d = differee();

    const suivi = m.track('r1', d.promesse);
    d.rejeter(new Error('réseau'));

    await assert.rejects(suivi, /réseau/);
    assert.equal(m.active('r1'), false, 'pas de compteur bloqué en l’air');
  });

  test('deux fetches concurrents : la portée reste allumée tant qu’il en reste un', async () => {
    const m = new ActivityEngine();
    const a = differee();
    const b = differee();

    const sa = m.track('r1', a.promesse);
    const sb = m.track('r1', b.promesse);
    assert.equal(m.active('r1'), true);

    a.resoudre();
    await sa;
    assert.equal(m.active('r1'), true, 'il en reste un — toujours allumé');

    b.resoudre();
    await sb;
    assert.equal(m.active('r1'), false, 'le dernier éteint');
  });

  test('les portées sont indépendantes', async () => {
    const m = new ActivityEngine();
    const d = differee();
    const suivi = m.track('global', d.promesse);

    assert.equal(m.active('global'), true);
    assert.equal(m.active('r1'), false, 'une autre portée n’est pas touchée');

    d.resoudre();
    await suivi;
  });

  test('n’avertit qu’aux BASCULES booléennes (0→1, 1→0), pas sur un concurrent', async () => {
    const m = new ActivityEngine();
    let avis = 0;
    m.onChange(() => {
      avis++;
    });

    const a = differee();
    const b = differee();
    m.track('r1', a.promesse); // 0→1 : un avis
    m.track('r1', b.promesse); // 1→2 : aucun
    assert.equal(avis, 1);

    a.resoudre();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(avis, 1, '2→1 : toujours allumé, aucun avis');

    b.resoudre();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(avis, 2, '1→0 : un avis d’extinction');
  });

  test('surChangement rend un désabonnement qui coupe les avis', async () => {
    const m = new ActivityEngine();
    let avis = 0;
    const detacher = m.onChange(() => {
      avis++;
    });
    detacher();

    const d = differee();
    const suivi = m.track('global', d.promesse);
    d.resoudre();
    await suivi;
    assert.equal(avis, 0, 'plus abonné');
  });
});
