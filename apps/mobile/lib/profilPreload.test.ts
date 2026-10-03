/**
 * La mécanique d'ouverture de fiche : la course entre `users.info`, la sonde
 * d'appel et le plafond de 2 s, l'indicateur différé anti-flash, la garde de
 * réentrance. Testable depuis que le module est du lib/ PUR (chantier 15) : la
 * navigation est injectée (`definirNavigateurProfil`), plus d'expo-router.
 *
 * Timers et `Date` mockés (`t.mock.timers`) : aucune attente réelle. Entre
 * chaque `tick`, on draine les microtâches — les chaînes de `then` du module
 * avancent d'un cran par tour.
 *
 * PIÈGE du mock (vérifié sur Node 24) : `tick(n)` pose `Date.now()` à la CIBLE
 * avant d'exécuter les callbacks en route — un callback armé à 450 lirait 2000
 * dans un `tick(2000)`, et l'anti-flash calculerait une attente de plus jamais
 * tickée (pendaison). On tick donc PAR ÉCHÉANCE, jamais d'un bloc.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test, type TestContext } from 'node:test';

import { oublierDisponibiliteAppel } from './appel.ts';
import {
  definirClientProfil,
  definirLecteurProfil,
  definirNavigateurProfil,
  lireProfilPrecharge,
  oublierFichesProfil,
  ouvrirFicheProfil,
  sabonnerOuvertureProfil,
  type ParamsProfil,
} from './profilPreload.ts';
import type { ClientRest } from './rest.ts';

const UTILISATEUR = { _id: 'u1', username: 'alice' };

test('native preload uses its provider, and an account change fences late cache and navigation',async(t)=>{
  t.mock.timers.enable({apis:['setTimeout','Date']});
  const c={genre:'rocketvibe',baseUrl:'http://native.local',get:()=>{throw new Error('Unexpected RC request');}} as unknown as ClientRest;
  const other={...c,baseUrl:'http://other.local'} as unknown as ClientRest;
  const navigations:ParamsProfil[]=[];
  definirNavigateurProfil(p=>navigations.push(p));definirClientProfil(c);
  let pending=differee<Record<string,unknown>>();
  const un=definirLecteurProfil(c,async()=>pending.promesse);
  try{
    const first=ouvrirFicheProfil({uid:'u1'});pending.resoudre(UTILISATEUR);await drainer();await first;
    assert.deepEqual(lireProfilPrecharge({uid:'u1'})?.user,UTILISATEUR);assert.equal(navigations.length,1);
    pending=differee<Record<string,unknown>>();const late=ouvrirFicheProfil({username:'alice'});
    definirClientProfil(other);pending.resoudre(UTILISATEUR);await drainer();await late;
    assert.equal(lireProfilPrecharge({uid:'u1'}),undefined);assert.equal(lireProfilPrecharge({username:'alice'}),undefined);
    assert.equal(navigations.length,1);
  }finally{un();definirClientProfil(null);definirNavigateurProfil(null);}
});

function differee<T>(): { promesse: Promise<T>; resoudre: (v: T) => void } {
  let resoudre!: (v: T) => void;
  const promesse = new Promise<T>((r) => {
    resoudre = r;
  });
  return { promesse, resoudre };
}

function fauxClient(poignees: {
  usersInfo: () => Promise<unknown>;
  capacites: () => Promise<unknown>;
}): ClientRest {
  return {
    baseUrl: 'http://banc.local',
    get: (chemin: string) =>
      chemin === 'users.info' ? poignees.usersInfo() : poignees.capacites(),
  } as unknown as ClientRest;
}

/** Assez de tours pour épuiser les chaînes de `then`/`await` du module. */
async function drainer(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

describe('ouvrirFicheProfil', () => {
  let navigations: ParamsProfil[];

  beforeEach(() => {
    navigations = [];
    oublierFichesProfil();
    oublierDisponibiliteAppel();
    definirNavigateurProfil((p) => navigations.push(p));
  });

  test('réponse rapide : fiche en cache, navigation, indicateur jamais montré', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    definirClientProfil(
      fauxClient({
        usersInfo: () => Promise.resolve({ user: UTILISATEUR }),
        capacites: () => Promise.resolve({}),
      }),
    );
    const busy: boolean[] = [];
    const desabonner = sabonnerOuvertureProfil((v) => busy.push(v));

    const fin = ouvrirFicheProfil({ username: 'alice' });
    await drainer();
    await fin;

    assert.deepEqual(navigations, [{ username: 'alice' }]);
    assert.deepEqual(lireProfilPrecharge({ username: 'alice' }), {
      user: UTILISATEUR,
      erreur: null,
    });
    // `sabonnerOuvertureProfil` rejoue l'état courant (false) à l'abonnement ;
    // rien d'autre ne doit s'être affiché sous le seuil.
    assert.deepEqual(busy, [false]);
    desabonner();
  });

  test("la sonde d'appel participe au plafond : elle traîne, on ouvre à 2 s sans fiche", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    // `users.info` répond tout de suite — c'est la SONDE qui pend : le
    // `Promise.all` ne doit pas résoudre, et seul le plafond ouvre.
    definirClientProfil(
      fauxClient({
        usersInfo: () => Promise.resolve({ user: UTILISATEUR }),
        capacites: () => differee<unknown>().promesse,
      }),
    );

    const fin = ouvrirFicheProfil({ username: 'alice' });
    await drainer();
    assert.deepEqual(navigations, [], 'rien ne doit ouvrir avant le plafond');

    t.mock.timers.tick(450); // l'indicateur, à SON heure (voir l'en-tête)
    t.mock.timers.tick(1550); // puis le plafond
    await drainer();
    await fin;

    assert.deepEqual(navigations, [{ username: 'alice' }]);
    // Plafond dépassé : l'entrée est PURGÉE — l'écran refera son chargement,
    // plutôt que de servir une fiche dont la hauteur mentirait.
    assert.equal(lireProfilPrecharge({ username: 'alice' }), undefined);
  });

  test("tout traîne : l'indicateur s'affiche à 450 ms et s'éteint à l'ouverture", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    definirClientProfil(
      fauxClient({
        usersInfo: () => differee<unknown>().promesse,
        capacites: () => differee<unknown>().promesse,
      }),
    );
    const busy: boolean[] = [];
    const desabonner = sabonnerOuvertureProfil((v) => busy.push(v));

    const fin = ouvrirFicheProfil({ username: 'alice' });
    await drainer();
    t.mock.timers.tick(450);
    await drainer();
    assert.deepEqual(busy, [false, true], 'le seuil passé, la pastille est là');

    t.mock.timers.tick(1550);
    await drainer();
    await fin;

    // Affichée depuis 1 550 ms > minimum 400 : extinction immédiate, ouverture.
    assert.deepEqual(busy, [false, true, false]);
    assert.deepEqual(navigations, [{ username: 'alice' }]);
    desabonner();
  });

  test('anti-flash : une réponse juste après le seuil retient la pastille 400 ms', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const fiche = differee<unknown>();
    definirClientProfil(
      fauxClient({
        usersInfo: () => fiche.promesse,
        capacites: () => Promise.resolve({}),
      }),
    );
    const busy: boolean[] = [];
    const desabonner = sabonnerOuvertureProfil((v) => busy.push(v));

    const fin = ouvrirFicheProfil({ username: 'alice' });
    await drainer();
    t.mock.timers.tick(450);
    t.mock.timers.tick(50);
    fiche.resoudre({ user: UTILISATEUR });
    await drainer();

    // Réponse à 500 ms, pastille née à 450 : elle doit tenir jusqu'à 850.
    assert.deepEqual(busy, [false, true]);
    assert.deepEqual(navigations, [], "l'ouverture attend la fin de la pastille");

    t.mock.timers.tick(349);
    await drainer();
    assert.deepEqual(busy, [false, true]);

    t.mock.timers.tick(1);
    await drainer();
    await fin;
    assert.deepEqual(busy, [false, true, false]);
    assert.deepEqual(navigations, [{ username: 'alice' }]);
    desabonner();
  });

  test('réentrance : même cible fondue dans le vol en cours, autre cible non bloquée', async (t: TestContext) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const fiche = differee<unknown>();
    definirClientProfil(
      fauxClient({
        usersInfo: () => fiche.promesse,
        capacites: () => Promise.resolve({}),
      }),
    );

    const premiere = ouvrirFicheProfil({ username: 'alice' });
    await drainer();
    // Second tap sur la MÊME fiche pendant le vol : absorbé par la garde.
    const doublon = ouvrirFicheProfil({ username: 'alice' });
    // Un tap sur une AUTRE fiche, lui, part — un verrou global l'avalerait.
    const autre = ouvrirFicheProfil({ username: 'bob' });
    await drainer();

    fiche.resoudre({ user: UTILISATEUR });
    await drainer();
    await Promise.all([premiere, doublon, autre]);

    // Alice d'abord : sa chaîne s'est abonnée la première à la fiche partagée —
    // l'ordre suit les microtâches, pas la « prise de main » de la garde.
    assert.deepEqual(navigations, [{ username: 'alice' }, { username: 'bob' }]);

    // Le vol fini, la garde est rendue : rouvrir navigue à nouveau.
    await ouvrirFicheProfil({ username: 'alice' });
    await drainer();
    assert.equal(navigations.length, 3);
  });
});
