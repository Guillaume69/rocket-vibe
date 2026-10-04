import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Reconnector } from './reconnect.ts';

/** Horloge simulée : les minuteries partent quand ON le décide. */
function fakeClock() {
  let nextId = 1;
  const scheduled = new Map<number, { fn: () => void; ms: number }>();
  return {
    schedule: (fn: () => void, ms: number) => {
      const id = nextId++;
      scheduled.set(id, { fn, ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (m: ReturnType<typeof setTimeout>) => void scheduled.delete(m as unknown as number),
    /** Fait partir la prochaine minuterie et rend son délai. */
    async advance(): Promise<number | null> {
      const [id, entry] = [...scheduled.entries()][0] ?? [];
      if (id === undefined || entry === undefined) return null;
      scheduled.delete(id);
      entry.fn();
      // Laisser la promesse de `essayer` se dérouler.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      return entry.ms;
    },
    pending: () => scheduled.size,
  };
}

describe('Reconnecteur', () => {
  test('première tentative immédiate, puis backoff exponentiel plafonné', async () => {
    const clock = fakeClock();
    const delays: number[] = [];
    let succeedAfter = 99;
    let attempts = 0;
    const r = new Reconnector({
      connect: async () => {
        attempts++;
        if (attempts <= succeedAfter) throw new Error('pas encore');
      },
      random: () => 1, // gigue déterministe : plein délai
      schedule: clock.schedule,
      cancel: clock.cancel,
    });

    r.trigger();
    for (let i = 0; i < 8; i++) {
      const ms = await clock.advance();
      if (ms !== null) delays.push(ms);
    }
    // 0 (immédiat), puis 1 s, 2 s, 4 s, 8 s, 16 s, puis plafond 30 s.
    assert.deepEqual(delays, [0, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);

    // Un succès remet le compteur à zéro.
    succeedAfter = 0;
    await clock.advance();
    r.trigger();
    const afterSuccess = await clock.advance();
    assert.equal(afterSuccess, 0, 'après un succès, la tentative suivante est immédiate');
  });

  test('la gigue borne le délai entre la moitié et le plein', async () => {
    for (const [random, expected] of [
      [0, 500],
      [1, 1000],
    ] as const) {
      const clock = fakeClock();
      const r = new Reconnector({
        connect: async () => {
          throw new Error('non');
        },
        random: () => random,
        schedule: clock.schedule,
        cancel: clock.cancel,
      });
      r.trigger();
      await clock.advance(); // tentative 0, immédiate, échoue
      const ms = await clock.advance(); // tentative 1 : 1 s plein
      assert.equal(ms, expected);
    }
  });

  test('declencher est idempotent : une seule tentative programmée à la fois', () => {
    const clock = fakeClock();
    const r = new Reconnector({
      connect: async () => {},
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    r.trigger();
    r.trigger();
    assert.equal(clock.pending(), 1);
  });

  test('arreter annule la tentative prévue et bloque les suivantes', async () => {
    const clock = fakeClock();
    let attempts = 0;
    const r = new Reconnector({
      connect: async () => {
        attempts++;
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    r.stop();
    assert.equal(clock.pending(), 0, 'la minuterie est annulée');
    r.trigger();
    assert.equal(clock.pending(), 0, 'plus rien ne se programme');
    assert.equal(attempts, 0);
  });

  test('un declencher pendant une tentative qui RÉUSSIT est rejoué, pas avalé', async () => {
    // Scénario réel : la socket retombe pendant le rechargement REST d'une
    // tentative qui va « réussir ». Sans relance, le signal était perdu et
    // plus rien ne reconnectait jamais — cache figé jusqu'au redémarrage.
    const clock = fakeClock();
    const valve: { open: (() => void) | null } = { open: null };
    let attempts = 0;
    const r = new Reconnector({
      connect: () =>
        new Promise<void>((resolve) => {
          attempts++;
          valve.open = resolve;
        }),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    await clock.advance(); // tentative 1 en vol, bloquée sur la vanne
    r.trigger(); // la socket vient de retomber : à MÉMORISER
    valve.open?.();
    await new Promise((s) => setImmediate(s));
    await new Promise((s) => setImmediate(s));
    assert.equal(clock.pending(), 1, 'une nouvelle tentative est programmée');
    await clock.advance();
    assert.equal(attempts, 2);
  });

  test('suspendre annule la minuterie prévue et bloque les demandes', () => {
    // En arrière-plan, le handler AppState ferme volontairement la socket et
    // « le push prend le relais ». Sans suspension, une minuterie de backoff
    // déjà armée tire quand même : chaque tentative rouvre une socket que
    // Doze tuera, et entraîne un rattraperTout() REST rate-limité.
    const clock = fakeClock();
    let attempts = 0;
    const r = new Reconnector({
      connect: async () => {
        attempts++;
      },
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    assert.equal(clock.pending(), 1);

    r.suspend();
    assert.equal(clock.pending(), 0, 'la minuterie armée est désarmée');
    r.trigger();
    assert.equal(clock.pending(), 0, 'plus aucune demande ne programme');
    assert.equal(attempts, 0);
  });

  test("l'échec d'une tentative EN VOL ne relance pas la boucle après suspendre", async () => {
    // L'autre chemin : la minuterie a déjà tiré, la tentative est partie, et
    // c'est son `catch` qui rappellera `declencher()`. Le drapeau doit tenir
    // là aussi, sinon le passage en arrière-plan ne suspend qu'une moitié.
    const clock = fakeClock();
    const valve: { fail: ((e: Error) => void) | null } = { fail: null };
    const r = new Reconnector({
      connect: () =>
        new Promise<void>((_, reject) => {
          valve.fail = reject;
        }),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    await clock.advance(); // tentative en vol

    r.suspend(); // l'app passe en arrière-plan pendant la tentative
    valve.fail?.(new Error('réseau coupé'));
    await new Promise((s) => setImmediate(s));
    await new Promise((s) => setImmediate(s));

    assert.equal(clock.pending(), 0, 'rien ne se reprogramme en fond');
  });

  test('une relance mémorisée pendant une tentative RÉUSSIE ne survit pas à suspendre', async () => {
    const clock = fakeClock();
    const valve: { open: (() => void) | null } = { open: null };
    const r = new Reconnector({
      connect: () =>
        new Promise<void>((resolve) => {
          valve.open = resolve;
        }),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    await clock.advance();
    r.trigger(); // la socket retombe : relance mémorisée
    r.suspend(); // …puis l'app part en arrière-plan
    valve.open?.();
    await new Promise((s) => setImmediate(s));
    await new Promise((s) => setImmediate(s));

    assert.equal(clock.pending(), 0);
  });

  test('reprendre réarme, et la tentative est IMMÉDIATE — pas au bout du backoff', async () => {
    // Le backoff accumulé décrit un réseau observé écran éteint. Au retour au
    // premier plan la situation est neuve, et c'est un geste de l'utilisateur :
    // le faire attendre 30 s serait la punition que ce chantier veut lever.
    const clock = fakeClock();
    let attempts = 0;
    const r = new Reconnector({
      connect: async () => {
        attempts++;
        throw new Error('non');
      },
      random: () => 1,
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    for (let i = 0; i < 6; i++) await clock.advance(); // le backoff monte
    assert.equal(attempts, 6);

    r.suspend();
    r.resume();
    r.trigger();
    assert.equal(await clock.advance(), 0, 'immédiate au retour');
    assert.equal(attempts, 7);
  });

  test('reprendre ne ressuscite pas un pilote arrêté', () => {
    const clock = fakeClock();
    const r = new Reconnector({
      connect: async () => {},
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.stop(); // démontage : définitif
    r.resume();
    r.trigger();
    assert.equal(clock.pending(), 0);
  });

  test('un declencher PENDANT une tentative en vol ne double pas', async () => {
    const clock = fakeClock();
    const valve: { open: (() => void) | null } = { open: null };
    let attempts = 0;
    const r = new Reconnector({
      connect: () =>
        new Promise<void>((resolve) => {
          attempts++;
          valve.open = resolve;
        }),
      schedule: clock.schedule,
      cancel: clock.cancel,
    });
    r.trigger();
    await clock.advance(); // lance la tentative, qui bloque sur la vanne
    r.trigger(); // en vol : ne doit rien programmer
    assert.equal(clock.pending(), 0);
    valve.open?.();
    await new Promise((s) => setImmediate(s));
    assert.equal(attempts, 1);
  });
});
