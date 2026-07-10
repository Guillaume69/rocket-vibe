import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AbonnementLocal, MessageLocal, SalonLocal } from '../lib/normaliser.ts';
import {
  INSERER_SORTIE,
  LISTER_SORTIE_A_ENVOYER,
  MARQUER_SORTIE_ECHEC,
  SUPPRIMER_MESSAGE,
  SUPPRIMER_MESSAGE_OPTIMISTE,
  SUPPRIMER_SORTIE,
  UPSERT_ABONNEMENT,
  UPSERT_CURSEUR,
  UPSERT_MESSAGE,
  UPSERT_SALON,
  paramsAbonnement,
  paramsMessage,
  paramsSalon,
} from './upserts.ts';

const DOSSIER = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * `node:sqlite` renvoie des objets à prototype `null`, que `assert.deepEqual`
 * en mode strict refuse de comparer à un littéral. On les remet à plat.
 */
function ligne(v: unknown): Record<string, unknown> {
  return { ...(v as Record<string, unknown>) };
}

function baseMigree(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(DOSSIER).filter((x) => x.endsWith('.sql')).sort()) {
    for (const r of readFileSync(join(DOSSIER, f), 'utf8').split('--> statement-breakpoint')) {
      if (r.trim() !== '') db.exec(r.trim());
    }
  }
  return db;
}

/**
 * On construit les paramètres avec `paramsMessage` de `db/upserts.ts`, la
 * fonction même qu'utilise l'application : un ordre de colonnes qui divergerait
 * de l'ordre des valeurs ferait échouer ces tests, au lieu de corrompre la base
 * en silence.
 */
function msg(o: Partial<MessageLocal> & { id: string; misAJourLe: number }) {
  return paramsMessage({
    rid: 'rid-1',
    texte: 'bonjour',
    horodatage: 1000,
    auteurId: 'u1',
    auteurNom: 'alice',
    typeSysteme: null,
    filId: null,
    filReponses: 0,
    filDernier: null,
    filAffiche: false,
    modifieLe: null,
    md: null,
    piecesJointes: null,
    reactions: null,
    ...o,
  });
}

function salon(o: Partial<SalonLocal> & { rid: string; misAJourLe: number }) {
  return paramsSalon({
    type: 'c',
    nom: 'nom',
    nomAffiche: 'nom',
    chiffre: false,
    lectureSeule: false,
    dernierMessage: null,
    horodatageDernierMessage: null,
    ...o,
  });
}

function abo(o: Partial<AbonnementLocal> & { rid: string; misAJourLe: number }) {
  return paramsAbonnement({
    subId: null,
    nonLus: 0,
    mentions: 0,
    mentionsGroupe: 0,
    alerte: false,
    ouvert: true,
    favori: false,
    luJusquA: null,
    ...o,
  });
}

let db: DatabaseSync;
beforeEach(() => {
  db = baseMigree();
});

describe('upserts idempotents', () => {
  test('rejouer le même message ne crée pas de doublon', () => {
    const p = msg({ id: 'm1', misAJourLe: 100 });
    db.prepare(UPSERT_MESSAGE).run(...p);
    db.prepare(UPSERT_MESSAGE).run(...p);
    db.prepare(UPSERT_MESSAGE).run(...p);
    const n = db.prepare('SELECT count(*) c FROM messages').get() as { c: number };
    assert.equal(n.c, 1);
  });

  test('un événement plus récent met bien à jour le message', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'v1', misAJourLe: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'v2', misAJourLe: 200 }));
    const m = ligne(db.prepare('SELECT texte, mis_a_jour_le FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(m, { texte: 'v2', mis_a_jour_le: 200 });
  });

  test('un événement PLUS ANCIEN n’écrase pas un état plus récent', () => {
    // Scénario réel : un rattrapage REST, lancé après une reconnexion, livre la
    // version d'un message que le WebSocket a déjà mise à jour depuis.
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'récent', misAJourLe: 200 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'ancien', misAJourLe: 100 }));
    const m = ligne(db.prepare('SELECT texte, mis_a_jour_le FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(m, { texte: 'récent', mis_a_jour_le: 200 }, 'le passé ne doit pas gagner');
  });

  test('fils (8.3) : fil_dernier et fil_affiche font l’aller-retour, valeurs NON par défaut', () => {
    // Garde contre l'interversion silencieuse de deux paramètres voisins de
    // même type dans paramsMessage : seules des valeurs distinctes et non
    // par défaut la détectent.
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({
        id: 'm1',
        filId: 'racine',
        filReponses: 7,
        filDernier: 4242,
        filAffiche: true,
        modifieLe: 9999,
        misAJourLe: 100,
      }),
    );
    const m = ligne(
      db
        .prepare(
          'SELECT fil_id, fil_reponses, fil_dernier, fil_affiche, modifie_le FROM messages WHERE id = ?',
        )
        .get('m1'),
    );
    assert.deepEqual(m, {
      fil_id: 'racine',
      fil_reponses: 7,
      fil_dernier: 4242,
      fil_affiche: 1,
      modifie_le: 9999,
    });
  });

  test('un événement de même horodatage est appliqué (rejeu idempotent)', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'a', misAJourLe: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'b', misAJourLe: 100 }));
    const m = ligne(db.prepare('SELECT texte FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(m, { texte: 'b' }, '>= et non > : deux écritures dans la même ms');
  });

  test('les salons suivent la même règle d’antériorité', () => {
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r1', nom: 'récent', misAJourLe: 200 }));
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r1', nom: 'ancien', misAJourLe: 100 }));
    const s = ligne(db.prepare('SELECT nom FROM salons WHERE rid = ?').get('r1'));
    assert.deepEqual(s, { nom: 'récent' });
  });

  test('un document partiel PLUS RÉCENT n’efface ni le nom ni l’aperçu', () => {
    // `rooms-changed` livre parfois un document sans `usernames` ni
    // `lastMessage` : versSalon rend alors des null. Ils signifient « absent »,
    // pas « efface » — le nom dérivé d'un DM doit survivre.
    db.prepare(UPSERT_SALON).run(
      ...salon({
        rid: 'r1',
        nomAffiche: 'bob',
        dernierMessage: 'salut',
        horodatageDernierMessage: 50,
        misAJourLe: 100,
      }),
    );
    db.prepare(UPSERT_SALON).run(
      ...salon({
        rid: 'r1',
        nomAffiche: null,
        dernierMessage: null,
        horodatageDernierMessage: null,
        misAJourLe: 200,
      }),
    );
    const s = ligne(
      db
        .prepare(
          'SELECT nom_affiche, dernier_message, horodatage_dernier_message, mis_a_jour_le FROM salons WHERE rid = ?',
        )
        .get('r1'),
    );
    assert.deepEqual(s, {
      nom_affiche: 'bob',
      dernier_message: 'salut',
      horodatage_dernier_message: 50,
      mis_a_jour_le: 200,
    });
  });

  test('un nom non-null plus récent remplace bien l’ancien', () => {
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r1', nomAffiche: 'avant', misAJourLe: 100 }));
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r1', nomAffiche: 'après', misAJourLe: 200 }));
    const s = ligne(db.prepare('SELECT nom_affiche FROM salons WHERE rid = ?').get('r1'));
    assert.deepEqual(s, { nom_affiche: 'après' });
  });

  test('les abonnements aussi : des non-lus remis à zéro ne réapparaissent pas', () => {
    db.prepare(UPSERT_ABONNEMENT).run(...abo({ rid: 'r1', nonLus: 0, misAJourLe: 200 })); // je viens de lire
    db.prepare(UPSERT_ABONNEMENT).run(...abo({ rid: 'r1', nonLus: 7, misAJourLe: 100 })); // rattrapage
    const a = ligne(db.prepare('SELECT non_lus FROM abonnements WHERE rid = ?').get('r1'));
    assert.deepEqual(a, { non_lus: 0 });
  });

  test('un curseur de rattrapage ne recule jamais', () => {
    db.prepare(UPSERT_CURSEUR).run('r1', 'messages', 500);
    db.prepare(UPSERT_CURSEUR).run('r1', 'messages', 300);
    const c = ligne(
      db
        .prepare('SELECT mis_a_jour_depuis FROM etat_synchro WHERE portee = ? AND flux = ?')
        .get('r1', 'messages'),
    );
    assert.deepEqual(c, { mis_a_jour_depuis: 500 }, 'un curseur qui régresse re-télécharge tout');

    db.prepare(UPSERT_CURSEUR).run('r1', 'messages', 700);
    const d = ligne(
      db
        .prepare('SELECT mis_a_jour_depuis FROM etat_synchro WHERE portee = ? AND flux = ?')
        .get('r1', 'messages'),
    );
    assert.deepEqual(d, { mis_a_jour_depuis: 700 });
  });

  test('deux flux du même salon ont des curseurs indépendants', () => {
    db.prepare(UPSERT_CURSEUR).run('r1', 'messages', 500);
    db.prepare(UPSERT_CURSEUR).run('r1', 'abonnements', 100);
    const n = db.prepare('SELECT count(*) c FROM etat_synchro').get() as { c: number };
    assert.equal(n.c, 2);
  });

  test('la suppression est idempotente', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', misAJourLe: 100 }));
    db.prepare(SUPPRIMER_MESSAGE).run('m1');
    db.prepare(SUPPRIMER_MESSAGE).run('m1'); // ne doit pas lever
    const n = db.prepare('SELECT count(*) c FROM messages').get() as { c: number };
    assert.equal(n.c, 0);
  });

  test('un message optimiste (mis_a_jour_le = 0) est TOUJOURS écrasé par le serveur', () => {
    // L'UI optimiste insère avec 0 : n'importe quelle version serveur (>= 0)
    // doit gagner, et l'optimiste ne doit jamais écraser une version réelle.
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'optimiste', misAJourLe: 0 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'serveur', misAJourLe: 5 }));
    let m = ligne(db.prepare('SELECT texte FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(m, { texte: 'serveur' });

    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'optimiste-rejoué', misAJourLe: 0 }));
    m = ligne(db.prepare('SELECT texte FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(m, { texte: 'serveur' }, "l'optimiste ne régresse jamais le réel");
  });

  test('le `ts` du serveur corrige l’horodatage optimiste (horloge locale suspecte)', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', horodatage: 9999, misAJourLe: 0 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', horodatage: 5000, misAJourLe: 7 }));
    const m = ligne(db.prepare('SELECT horodatage FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(m, { horodatage: 5000 }, 'sans cela, le tri resterait faux pour toujours');
  });

  test('l’abandon n’efface qu’un message encore optimiste', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', misAJourLe: 0 }));
    db.prepare(SUPPRIMER_MESSAGE_OPTIMISTE).run('m1');
    assert.equal(db.prepare('SELECT count(*) c FROM messages').get()!.c, 0);

    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm2', misAJourLe: 42 })); // livré
    db.prepare(SUPPRIMER_MESSAGE_OPTIMISTE).run('m2');
    assert.equal(
      db.prepare('SELECT count(*) c FROM messages').get()!.c,
      1,
      'un message livré n’est pas abandonnable',
    );
  });
});

describe('file d’envoi (outbox)', () => {
  test('le cycle en-attente → échec → renvoi → supprimé', () => {
    db.prepare(INSERER_SORTIE).run('a'.repeat(24), 'r1', 'bonjour', null, 1000);

    let attente = db.prepare(LISTER_SORTIE_A_ENVOYER).all().map(ligne);
    assert.equal(attente.length, 1);
    assert.equal(attente[0].statut, 'en-attente');

    db.prepare(MARQUER_SORTIE_ECHEC).run('500 oups', 'a'.repeat(24));
    attente = db.prepare(LISTER_SORTIE_A_ENVOYER).all().map(ligne);
    assert.equal(attente.length, 1, 'un échec reste candidat au rejeu');
    assert.equal(attente[0].statut, 'echec');
    assert.equal(attente[0].tentatives, 1);

    db.prepare(SUPPRIMER_SORTIE).run('a'.repeat(24));
    assert.equal(db.prepare(LISTER_SORTIE_A_ENVOYER).all().length, 0);
  });

  test('le rejeu liste dans l’ordre de création', () => {
    db.prepare(INSERER_SORTIE).run('b'.repeat(24), 'r1', 'deuxième', null, 2000);
    db.prepare(INSERER_SORTIE).run('c'.repeat(24), 'r1', 'premier', null, 1000);
    const ordres = db.prepare(LISTER_SORTIE_A_ENVOYER).all().map((l) => ligne(l).texte);
    assert.deepEqual(ordres, ['premier', 'deuxième']);
  });
});
