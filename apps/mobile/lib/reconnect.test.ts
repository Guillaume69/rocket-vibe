import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Reconnector } from './reconnect.ts';

/** Horloge simulée : les minuteries partent quand ON le décide. */
function fausseHorloge() {
  let prochainId = 1;
  const prevues = new Map<number, { fn: () => void; ms: number }>();
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = prochainId++;
      prevues.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (m: ReturnType<typeof setTimeout>) => void prevues.delete(m as unknown as number),
    /** Fait partir la prochaine minuterie et rend son délai. */
    async avancer(): Promise<number | null> {
      const [id, entree] = [...prevues.entries()][0] ?? [];
      if (id === undefined || entree === undefined) return null;
      prevues.delete(id);
      entree.fn();
      // Laisser la promesse de `essayer` se dérouler.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      return entree.ms;
    },
    pending: () => prevues.size,
  };
}

describe('Reconnecteur', () => {
  test('première tentative immédiate, puis backoff exponentiel plafonné', async () => {
    const horloge = fausseHorloge();
    const delais: number[] = [];
    let reussirApres = 99;
    let essais = 0;
    const r = new Reconnector({
      connect: async () => {
        essais++;
        if (essais <= reussirApres) throw new Error('pas encore');
      },
      random: () => 1, // gigue déterministe : plein délai
      schedule: horloge.schedule,
      cancel: horloge.cancel,
    });

    r.trigger();
    for (let i = 0; i < 8; i++) {
      const ms = await horloge.avancer();
      if (ms !== null) delais.push(ms);
    }
    // 0 (immédiat), puis 1 s, 2 s, 4 s, 8 s, 16 s, puis plafond 30 s.
    assert.deepEqual(delais, [0, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);

    // Un succès remet le compteur à zéro.
    reussirApres = 0;
    await horloge.avancer();
    r.trigger();
    const apresSucces = await horloge.avancer();
    assert.equal(apresSucces, 0, 'après un succès, la tentative suivante est immédiate');
  });

  test('la gigue borne le délai entre la moitié et le plein', async () => {
    for (const [alea, attendu] of [
      [0, 500],
      [1, 1000],
    ] as const) {
      const horloge = fausseHorloge();
      const r = new Reconnector({
        connect: async () => {
          throw new Error('non');
        },
        random: () => alea,
        schedule: horloge.schedule,
        cancel: horloge.cancel,
      });
      r.trigger();
      await horloge.avancer(); // tentative 0, immédiate, échoue
      const ms = await horloge.avancer(); // tentative 1 : 1 s plein
      assert.equal(ms, attendu);
    }
  });

  test('declencher est idempotent : une seule tentative programmée à la fois', () => {
    const horloge = fausseHorloge();
    const r = new Reconnector({
      connect: async () => {},
      schedule: horloge.schedule,
      cancel: horloge.cancel,
    });
    r.trigger();
    r.trigger();
    r.trigger();
    assert.equal(horloge.pending(), 1);
  });

  test('arreter annule la tentative prévue et bloque les suivantes', async () => {
    const horloge = fausseHorloge();
    let essais = 0;
    const r = new Reconnector({
      connect: async () => {
        essais++;
      },
      schedule: horloge.schedule,
      cancel: horloge.cancel,
    });
    r.trigger();
    r.stop();
    assert.equal(horloge.pending(), 0, 'la minuterie est annulée');
    r.trigger();
    assert.equal(horloge.pending(), 0, 'plus rien ne se programme');
    assert.equal(essais, 0);
  });

  test('un declencher pendant une tentative qui RÉUSSIT est rejoué, pas avalé', async () => {
    // Scénario réel : la socket retombe pendant le rechargement REST d'une
    // tentative qui va « réussir ». Sans relance, le signal était perdu et
    // plus rien ne reconnectait jamais — cache figé jusqu'au redémarrage.
    const horloge = fausseHorloge();
    const vanne: { open: (() => void) | null } = { open: null };
    let essais = 0;
    const r = new Reconnector({
      connect: () =>
        new Promise<void>((resoudre) => {
          essais++;
          vanne.open = resoudre;
        }),
      schedule: horloge.schedule,
      cancel: horloge.cancel,
    });
    r.trigger();
    await horloge.avancer(); // tentative 1 en vol, bloquée sur la vanne
    r.trigger(); // la socket vient de retomber : à MÉMORISER
    vanne.open?.();
    await new Promise((s) => setImmediate(s));
    await new Promise((s) => setImmediate(s));
    assert.equal(horloge.pending(), 1, 'une nouvelle tentative est programmée');
    await horloge.avancer();
    assert.equal(essais, 2);
  });

  test('suspendre annule la minuterie prévue et bloque les demandes', () => {
    // En arrière-plan, le handler AppState ferme volontairement la socket et
    // « le push prend le relais ». Sans suspension, une minuterie de backoff
    // déjà armée tire quand même : chaque tentative rouvre une socket que
    // Doze tuera, et entraîne un rattraperTout() REST rate-limité.
    const horloge = fausseHorloge();
    let essais = 0;
    const r = new Reconnector({
      connect: async () => {
        essais++;
      },
      schedule: horloge.schedule,
      cancel: horloge.cancel,
    });
    r.trigger();
    assert.equal(horloge.pending(), 1);

    r.suspend();
    assert.equal(horloge.pending(), 0, 'la minuterie armée est désarmée');
    r.trigger();
    assert.equal(horloge.pending(), 0, 'plus aucune demande ne programme');
    assert.equal(essais, 0);
  });

  test("l'échec d'une tentative EN VOL ne relance pas la boucle après suspendre", async () => {
    // L'autre chemin : la minuterie a déjà tiré, la tentative est partie, et
    // c'est son `catch` qui rappellera `declencher()`. Le drapeau doit tenir
    // là aussi, sinon le passage en arrière-plan ne suspend qu'une moitié.
    const horloge = fausseHorloge();
    const vanne: { fail: ((e: Error) => void) | null } = { fail: null };
    const r = new Reconnector({
      connect: () =>
        new Promise<void>((_, rejeter) => {
          vanne.fail = rejeter;
        }),
      schedule: horloge.schedule,
      cancel: horloge.cancel,
    });
    r.trigger();
    await horloge.avancer(); // tentative en vol

    r.suspend(); // l'app passe en arrière-plan pendant la tentative
    vanne.fail?.(new Error('réseau coupé'));
    await new Promise((s) => setImmediate(s));
    await new Promise((s) => setImmediate(s));

    assert.equal(horloge.pending(), 0, 'rien ne se reprogramme en fond');
  });

  test('une relance mémorisée pendant une tentative RÉUSSIE ne survit pas à suspendre', async () => {
    const horloge = fausseHorloge();
    const vanne: { open: (() => void) | null } = { open: null };
    const r = new Reconnector({
      connect: () =>
        new Promise<void>((resoudre) => {
          vanne.open = resoudre;
        }),
      schedule: horloge.schedule,
      cancel: horloge.cancel,
    });
    r.trigger();
    await horloge.avancer();
    r.trigger(); // la socket retombe : relance mémorisée
    r.suspend(); // …puis l'app part en arrière-plan
    vanne.open?.();
    await new Promise((s) => setImmediate(s));
    await new Promise((s) => setImmediate(s));

    assert.equal(horloge.pending(), 0);
  });

  test('reprendre réarme, et la tentative est IMMÉDIATE — pas au bout du backoff', async () => {
    // Le backoff accumulé décrit un réseau observé écran éteint. Au retour au
    // premier plan la situation est neuve, et c'est un geste de l'utilisateur :
    // le faire attendre 30 s serait la punition que ce chantier veut lever.
    const horloge = fausseHorloge();
    let essais = 0;
    const r = new Reconnector({
      connect: async () => {
        essais++;
        throw new Error('non');
      },
      random: () => 1,
      schedule: horloge.schedule,
      cancel: horloge.cancel,
    });
    r.trigger();
    for (let i = 0; i < 6; i++) await horloge.avancer(); // le backoff monte
    assert.equal(essais, 6);

    r.suspend();
    r.resume();
    r.trigger();
    assert.equal(await horloge.avancer(), 0, 'immédiate au retour');
    assert.equal(essais, 7);
  });

  test('reprendre ne ressuscite pas un pilote arrêté', () => {
    const horloge = fausseHorloge();
    const r = new Reconnector({
      connect: async () => {},
      schedule: horloge.schedule,
      cancel: horloge.cancel,
    });
    r.stop(); // démontage : définitif
    r.resume();
    r.trigger();
    assert.equal(horloge.pending(), 0);
  });

  test('un declencher PENDANT une tentative en vol ne double pas', async () => {
    const horloge = fausseHorloge();
    const vanne: { open: (() => void) | null } = { open: null };
    let essais = 0;
    const r = new Reconnector({
      connect: () =>
        new Promise<void>((resoudre) => {
          essais++;
          vanne.open = resoudre;
        }),
      schedule: horloge.schedule,
      cancel: horloge.cancel,
    });
    r.trigger();
    await horloge.avancer(); // lance la tentative, qui bloque sur la vanne
    r.trigger(); // en vol : ne doit rien programmer
    assert.equal(horloge.pending(), 0);
    vanne.open?.();
    await new Promise((s) => setImmediate(s));
    assert.equal(essais, 1);
  });
});
