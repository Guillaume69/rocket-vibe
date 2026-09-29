import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { versSalon } from '../lib/normaliser.ts';
import type { AbonnementLocal, MessageLocal, SalonLocal } from '../lib/normaliser.ts';
import {
  APPLIQUER_RETENTION,
  INSERER_EMOJI_CUSTOM,
  INSERER_SORTIE,
  INSERER_TELEVERSEMENT,
  LIRE_BROUILLON,
  LIRE_CURSEUR,
  LISTER_RIDS_CONNUS,
  SUPPRIMER_BROUILLON,
  SUPPRIMER_BROUILLONS_SALON,
  SUPPRIMER_CURSEURS_SALON,
  SUPPRIMER_SORTIE_SALON,
  SUPPRIMER_TELEVERSEMENTS_SALON,
  UPSERT_BROUILLON,
  LISTER_EMOJIS_CUSTOM,
  LISTER_SORTIE_A_ENVOYER,
  LISTER_TELEVERSEMENTS_A_ENVOYER,
  MARQUER_SORTIE_ECHEC,
  MARQUER_TELEVERSEMENT_ECHEC,
  MARQUER_TELEVERSEMENT_EN_VOL,
  MESSAGE_AVEC_FICHIER,
  NOTER_FILE_ID,
  REARMER_TELEVERSEMENT,
  REARMER_TELEVERSEMENTS_EN_VOL,
  SUPPRIMER_TELEVERSEMENT,
  PURGER_ABONNEMENTS_ABSENTS,
  PURGER_BROUILLONS_ABSENTS,
  PURGER_CURSEURS_ABSENTS,
  PURGER_MESSAGES_ABSENTS,
  PURGER_SALONS_ABSENTS,
  PURGER_SORTIE_ABSENTE,
  PURGER_TELEVERSEMENTS_ABSENTS,
  MAJ_APERCU_CHIFFRE,
  MASQUER_APERCU_CHIFFRE,
  MAJ_TEXTE_MESSAGE,
  MASQUER_MESSAGES_CHIFFRES,
  MAJ_AVATAR_SALON,
  MAJ_MARQUES_MESSAGE,
  MAJ_AVATAR_UTILISATEUR,
  SUPPRIMER_MESSAGE,
  SUPPRIMER_MESSAGE_OPTIMISTE,
  SUPPRIMER_SORTIE,
  UPSERT_ABONNEMENT,
  UPSERT_CURSEUR,
  UPSERT_IDENTITE,
  UPSERT_MESSAGE,
  UPSERT_SALON,
  UPSERT_UTILISATEUR,
  VIDER_EMOJIS_CUSTOM,
  paramsAbonnement,
  paramsEmojiCustom,
  paramsIdentite,
  paramsMessage,
  paramsSalon,
  paramsUtilisateur,
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
    urls: null,
    appelId: null,
    chiffreBrut: null,
    epingle: false,
    etoiles: null,
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
    dmAutreUid: null,
    dmAutreUsername: null,
    dernierMessage: null,
    dernierMessageType: null,
    horodatageDernierMessage: null,
    avatarEtag: null,
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
    e2eKey: null,
    e2eKeyId: null,
    roles: null,
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

  test('message d’appel : le callId fait l’aller-retour en base', () => {
    // Le `callId` n'est PAS le `_id` du message : il faut le persister à part
    // pour que le bouton « Rejoindre » sache quel appel ouvrir.
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', typeSysteme: 'videoconf', appelId: 'call-xyz', misAJourLe: 100 }),
    );
    const m = ligne(
      db.prepare('SELECT type_systeme, appel_id FROM messages WHERE id = ?').get('m1'),
    );
    assert.deepEqual(m, { type_systeme: 'videoconf', appel_id: 'call-xyz' });
  });

  test('épinglage et étoiles : aller-retour, puis pose locale écrasée par la version serveur suivante', () => {
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', epingle: true, etoiles: '["u1"]', misAJourLe: 100 }),
    );
    const lire = () =>
      ligne(db.prepare('SELECT epingle, etoiles, mis_a_jour_le FROM messages WHERE id = ?').get('m1'));
    assert.deepEqual(lire(), { epingle: 1, etoiles: '["u1"]', mis_a_jour_le: 100 });

    db.prepare(MAJ_MARQUES_MESSAGE).run(0, null, 'm1');
    assert.deepEqual(lire(), { epingle: 0, etoiles: null, mis_a_jour_le: 100 });

    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', epingle: true, etoiles: '["u2"]', misAJourLe: 101 }),
    );
    assert.deepEqual(lire(), { epingle: 1, etoiles: '["u2"]', mis_a_jour_le: 101 });
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

  test('un document partiel PLUS RÉCENT n’efface ni le nom ni l’horodatage', () => {
    // `rooms-changed` livre parfois un document sans `usernames` : versSalon
    // rend alors un `nomAffiche` null. Il signifie « absent », pas « efface » —
    // le nom dérivé d'un DM doit survivre. Idem pour l'horodatage, qui pilote
    // le tri de la liste.
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
        dernierMessage: 'salut',
        horodatageDernierMessage: null,
        misAJourLe: 200,
      }),
    );
    const s = ligne(
      db
        .prepare(
          'SELECT nom_affiche, horodatage_dernier_message, mis_a_jour_le FROM salons WHERE rid = ?',
        )
        .get('r1'),
    );
    assert.deepEqual(s, {
      nom_affiche: 'bob',
      horodatage_dernier_message: 50,
      mis_a_jour_le: 200,
    });
  });

  test('salon VIDÉ : un aperçu absent EFFACE l’aperçu, il ne le préserve pas', () => {
    // Supprimer le dernier message d'un salon retire `lastMessage` du document
    // Room — c'est le SEUL signal qu'un salon a été vidé (sondé sur 8.5, stream
    // et `rooms.get`). Le préserver figeait à vie le message supprimé dans la
    // liste : aucun rattrapage ne pouvait plus le déloger.
    db.prepare(UPSERT_SALON).run(
      ...salon({ rid: 'r1', dernierMessage: 'le dernier', misAJourLe: 100 }),
    );
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r1', dernierMessage: null, misAJourLe: 200 }));
    const s = ligne(db.prepare('SELECT dernier_message FROM salons WHERE rid = ?').get('r1'));
    assert.deepEqual(s, { dernier_message: null });
  });

  test('salon CHIFFRÉ : le serveur ne peut pas effacer un aperçu qu’il ignore', () => {
    // Le serveur ne détient que du ciphertext : `versSalon` rend toujours null
    // pour un salon chiffré. Son aperçu vient de MAJ_APERCU_CHIFFRE, sur les
    // messages déchiffrés localement — un `rooms-changed` ne doit pas le
    // balayer au passage.
    db.prepare(UPSERT_SALON).run(
      ...salon({ rid: 'r1', chiffre: true, dernierMessage: 'clair local', misAJourLe: 100 }),
    );
    db.prepare(UPSERT_SALON).run(
      ...salon({ rid: 'r1', chiffre: true, dernierMessage: null, misAJourLe: 200 }),
    );
    const s = ligne(db.prepare('SELECT dernier_message FROM salons WHERE rid = ?').get('r1'));
    assert.deepEqual(s, { dernier_message: 'clair local' });
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

  test('rôles du salon : un document sans rôles les garde, une liste vide les retire', () => {
    const lire = () => ligne(db.prepare('SELECT roles FROM abonnements WHERE rid = ?').get('r1'));
    db.prepare(UPSERT_ABONNEMENT).run(...abo({ rid: 'r1', roles: '["owner"]', misAJourLe: 100 }));
    db.prepare(UPSERT_ABONNEMENT).run(...abo({ rid: 'r1', roles: null, misAJourLe: 200 }));
    assert.deepEqual(lire(), { roles: '["owner"]' });
    db.prepare(UPSERT_ABONNEMENT).run(...abo({ rid: 'r1', roles: '[]', misAJourLe: 300 }));
    assert.deepEqual(lire(), { roles: '[]' });
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

/**
 * La file de FICHIERS n'était exécutée par aucun test — `db/depot.ts` rendait
 * `getAllAsync` directement comme `LigneTeleversement[]`, une assertion de type
 * que rien ne vérifiait : une colonne renommée dans le SQL aurait donné des
 * `undefined` silencieux jusque dans l'URI téléversée.
 *
 * On insère ici avec EXACTEMENT les paramètres que passe `db/depot.ts`, dans
 * le même ordre — un décalage entre l'ordre des colonnes et l'ordre des
 * valeurs fait échouer ces tests au lieu de corrompre la base.
 */
function televersement(o: Partial<Record<string, unknown>> & { id: string }) {
  const v = { rid: 'r1', uri: 'file:///a.png', nom: 'a.png', type: 'image/png', legende: null, creeLe: 1000, ...o };
  return [v.id, v.rid, v.uri, v.nom, v.type, v.legende, v.creeLe] as const;
}

describe('file de téléversements', () => {
  test('les colonnes relues sont EXACTEMENT celles du type `LigneTeleversement`', () => {
    db.prepare(INSERER_TELEVERSEMENT).run(
      ...televersement({ id: 't1', legende: 'ma légende', uri: 'file:///photo.jpg' }),
    );
    const lignes = db.prepare(LISTER_TELEVERSEMENTS_A_ENVOYER).all().map(ligne);
    assert.equal(lignes.length, 1);
    // deepEqual et non une série d'`equal` : une colonne EN TROP la fait
    // échouer aussi. C'est le seul garde-fou contre le cast de db/depot.ts.
    assert.deepEqual(lignes[0], {
      id: 't1',
      rid: 'r1',
      uri: 'file:///photo.jpg',
      nom: 'a.png',
      type: 'image/png',
      legende: 'ma légende',
      statut: 'en-attente',
      // Colonne SNAKE : `db/depot.ts` doit la remettre en `fileId`, comme il
      // le fait déjà pour `fil_id` dans la file de sortie.
      file_id: null,
    });
  });

  test('une légende absente reste NULL, pas la chaîne « null »', () => {
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 't1' }));
    const l = ligne(db.prepare(LISTER_TELEVERSEMENTS_A_ENVOYER).all()[0]);
    assert.equal(l.legende, null, 'le moteur passe `legende ?? undefined` au confirm');
  });

  /**
   * Le cœur du constat : un échec ne doit PLUS repartir tout seul. C'est ce
   * test qui interdit de revenir à `statut IN ('en-attente','echec')`.
   */
  test('un échec sort du rejeu automatique et n’y revient que par « Réessayer »', () => {
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 't1' }));
    assert.equal(db.prepare(LISTER_TELEVERSEMENTS_A_ENVOYER).all().length, 1);

    db.prepare(MARQUER_TELEVERSEMENT_ECHEC).run('413 trop gros', 't1');
    assert.equal(
      db.prepare(LISTER_TELEVERSEMENTS_A_ENVOYER).all().length,
      0,
      'sinon la vidéo refusée repousse tous ses octets à chaque raccordement',
    );
    // La ligne EXISTE toujours : c'est elle que le bandeau affiche.
    const restee = ligne(db.prepare('SELECT statut, derniere_erreur FROM televersements WHERE id = ?').get('t1'));
    assert.equal(restee.statut, 'echec');
    assert.equal(restee.derniere_erreur, '413 trop gros', "le motif est gardé pour l'UI");

    db.prepare(REARMER_TELEVERSEMENT).run('t1');
    const rearmee = db.prepare(LISTER_TELEVERSEMENTS_A_ENVOYER).all().map(ligne);
    assert.equal(rearmee.length, 1, '« Réessayer » la remet dans la file');
    assert.equal(rearmee[0].statut, 'en-attente');
    const apres = ligne(db.prepare('SELECT derniere_erreur FROM televersements WHERE id = ?').get('t1'));
    assert.equal(apres.derniere_erreur, null, 'une erreur périmée ne doit pas rester affichée');

    db.prepare(SUPPRIMER_TELEVERSEMENT).run('t1');
    assert.equal(db.prepare(LISTER_TELEVERSEMENTS_A_ENVOYER).all().length, 0);
  });

  test('une ligne prise en charge (`envoi`) sort du listage — jamais deux uploads du même fichier', () => {
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 't1' }));
    const pris = db.prepare(MARQUER_TELEVERSEMENT_EN_VOL).run('t1');
    assert.equal(pris.changes, 1);
    assert.equal(db.prepare(LISTER_TELEVERSEMENTS_A_ENVOYER).all().length, 0);
  });

  test('deux passes concurrentes : la seconde prise en charge ne change AUCUNE ligne', () => {
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 't1' }));
    assert.equal(db.prepare(MARQUER_TELEVERSEMENT_EN_VOL).run('t1').changes, 1);
    assert.equal(
      db.prepare(MARQUER_TELEVERSEMENT_EN_VOL).run('t1').changes,
      0,
      'la garde `AND statut = en-attente` rend la saisie atomique',
    );
  });

  test('un `envoi` orphelin d’un processus tué est ré-armé, pas perdu', () => {
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 't1' }));
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 't2' }));
    db.prepare(MARQUER_TELEVERSEMENT_EN_VOL).run('t1');
    db.prepare(MARQUER_TELEVERSEMENT_ECHEC).run('refusé', 't2');

    db.prepare(REARMER_TELEVERSEMENTS_EN_VOL).run(JSON.stringify([]));

    const ids = db.prepare(LISTER_TELEVERSEMENTS_A_ENVOYER).all().map((l) => ligne(l).id);
    assert.deepEqual(ids, ['t1'], 'le kill est réparé…');
    const t2 = ligne(db.prepare('SELECT statut FROM televersements WHERE id = ?').get('t2'));
    assert.equal(t2.statut, 'echec', '…sans ressusciter les échecs, qui restent un terminus');
  });

  /**
   * La borne du ré-armement. `SynchroProvider` peut construire un second
   * moteur sans arrêter le premier ; sans cette exclusion, le nouveau rendrait
   * au rejeu une ligne dont l'ancien pousse encore les octets — deux uploads,
   * deux confirms, et le serveur poste bien DEUX messages (sondé sur 8.5).
   */
  test('une ligne encore en vol dans CE runtime n’est PAS ré-armée', () => {
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 'enVol' }));
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 'orphelin' }));
    db.prepare(MARQUER_TELEVERSEMENT_EN_VOL).run('enVol');
    db.prepare(MARQUER_TELEVERSEMENT_EN_VOL).run('orphelin');

    db.prepare(REARMER_TELEVERSEMENTS_EN_VOL).run(JSON.stringify(['enVol']));

    const ids = db.prepare(LISTER_TELEVERSEMENTS_A_ENVOYER).all().map((l) => ligne(l).id);
    assert.deepEqual(ids, ['orphelin'], 'seul l’orphelin repart');
    const survivant = ligne(db.prepare('SELECT statut FROM televersements WHERE id = ?').get('enVol'));
    assert.equal(survivant.statut, 'envoi', 'la ligne en vol garde sa prise en charge');
  });

  test('l’ordre de rejeu départage les créations de la même milliseconde', () => {
    // `app/partager.tsx` insère N pièces dans une boucle serrée : `Date.now()`
    // peut rendre la même valeur pour plusieurs.
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 'b', nom: 'deux', creeLe: 7 }));
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 'a', nom: 'un', creeLe: 7 }));
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 'c', nom: 'trois', creeLe: 8 }));
    const noms = db.prepare(LISTER_TELEVERSEMENTS_A_ENVOYER).all().map((l) => ligne(l).nom);
    assert.deepEqual(noms, ['un', 'deux', 'trois'], 'ordre total, jamais indéfini');
  });

  test('le `file_id` de `rooms.media` est persisté et relu', () => {
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 't1' }));
    db.prepare(NOTER_FILE_ID).run('abc123', 't1');
    const l = ligne(db.prepare(LISTER_TELEVERSEMENTS_A_ENVOYER).all()[0]);
    assert.equal(l.file_id, 'abc123', 'sans lui, les octets repartiraient au rejeu');
  });

  test('« ce fichier a-t-il déjà été posté ? » se lit dans `pieces_jointes`, sans réseau', () => {
    // Le message que le serveur a créé au `mediaConfirm` dont on a perdu la
    // réponse : livré par le stream DDP comme n'importe quel autre.
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({
        id: 'm1',
        misAJourLe: 5,
        piecesJointes: JSON.stringify([
          { title: 'photo.jpg', title_link: '/file-upload/abc123/photo.jpg' },
        ]),
      }),
    );

    assert.ok(
      db.prepare(MESSAGE_AVEC_FICHIER).get('rid-1', 'abc123') !== undefined,
      'le fileId est dans le title_link de la pièce jointe',
    );
    assert.equal(
      db.prepare(MESSAGE_AVEC_FICHIER).get('rid-1', 'jamais-vu'),
      undefined,
      'un fichier non posté ne doit pas faire croire à un doublon',
    );
    assert.equal(
      db.prepare(MESSAGE_AVEC_FICHIER).get('autre-salon', 'abc123'),
      undefined,
      'la recherche est bornée au salon',
    );
  });

  test('le rejeu liste dans l’ordre de création, pas dans celui de l’id', () => {
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 'zzz', nom: 'premier', creeLe: 1000 }));
    db.prepare(INSERER_TELEVERSEMENT).run(...televersement({ id: 'aaa', nom: 'second', creeLe: 2000 }));
    const noms = db.prepare(LISTER_TELEVERSEMENTS_A_ENVOYER).all().map((l) => ligne(l).nom);
    assert.deepEqual(noms, ['premier', 'second']);
  });

  test('marquer en échec une ligne inconnue ne crée rien', () => {
    db.prepare(MARQUER_TELEVERSEMENT_ECHEC).run('oups', 'fantome');
    assert.equal(db.prepare(LISTER_TELEVERSEMENTS_A_ENVOYER).all().length, 0);
  });
});

describe('emojis custom', () => {
  test('round-trip : insérés puis relus, aliases préservés en JSON', () => {
    db.prepare(INSERER_EMOJI_CUSTOM).run(
      ...paramsEmojiCustom({ nom: 'party_parrot', extension: 'gif', aliases: ['parrot'], misAJourLe: 10 }),
    );
    db.prepare(INSERER_EMOJI_CUSTOM).run(
      ...paramsEmojiCustom({ nom: 'shipit', extension: 'png', aliases: [], misAJourLe: 10 }),
    );
    const lignes = db.prepare(LISTER_EMOJIS_CUSTOM).all().map(ligne);
    assert.equal(lignes.length, 2);
    const parrot = lignes.find((l) => l.nom === 'party_parrot');
    assert.equal(parrot?.extension, 'gif');
    assert.deepEqual(JSON.parse(parrot?.aliases as string), ['parrot']);
  });

  test('VIDER efface tout — le remplacement en bloc ne laisse pas de fantôme', () => {
    db.prepare(INSERER_EMOJI_CUSTOM).run(
      ...paramsEmojiCustom({ nom: 'obsolete', extension: 'png', aliases: [], misAJourLe: 1 }),
    );
    db.prepare(VIDER_EMOJIS_CUSTOM).run();
    assert.equal(db.prepare(LISTER_EMOJIS_CUSTOM).all().length, 0);
  });
});

describe('purge des salons fantômes (réconciliation)', () => {
  const rids = (table: string): string[] =>
    (db.prepare(`SELECT rid FROM ${table} ORDER BY rid`).all() as { rid: string }[]).map(
      (l) => l.rid,
    );
  const ids = (table: string): string[] =>
    (db.prepare(`SELECT id FROM ${table} ORDER BY id`).all() as { id: string }[]).map((l) => l.id);

  /** Les sept DELETE, dans l'ordre où le dépôt les joue. */
  function purger(connus: string[], vivants: string[]): void {
    const c = JSON.stringify(connus);
    const v = JSON.stringify(vivants);
    for (const sql of [
      PURGER_SALONS_ABSENTS,
      PURGER_ABONNEMENTS_ABSENTS,
      PURGER_MESSAGES_ABSENTS,
      PURGER_SORTIE_ABSENTE,
      PURGER_TELEVERSEMENTS_ABSENTS,
      PURGER_BROUILLONS_ABSENTS,
      PURGER_CURSEURS_ABSENTS,
    ]) {
      db.prepare(sql).run(c, v);
    }
  }

  test('efface salon, abonnement ET messages dont le rid n’est plus vivant', () => {
    for (const rid of ['r1', 'r2', 'r3']) {
      db.prepare(UPSERT_SALON).run(...salon({ rid, misAJourLe: 100 }));
      db.prepare(UPSERT_ABONNEMENT).run(...abo({ rid, misAJourLe: 100 }));
      db.prepare(UPSERT_MESSAGE).run(...msg({ id: `m-${rid}`, rid, misAJourLe: 100 }));
    }
    purger(['r1', 'r2', 'r3'], ['r1']);

    assert.deepEqual(rids('salons'), ['r1'], 'seul le salon vivant reste');
    assert.deepEqual(rids('abonnements'), ['r1']);
    assert.deepEqual(ids('messages'), ['m-r1'], 'les messages orphelins partent aussi');
  });

  test('garde plusieurs rids vivants, purge le reste', () => {
    for (const rid of ['r1', 'r2', 'r3', 'r4']) {
      db.prepare(UPSERT_SALON).run(...salon({ rid, misAJourLe: 100 }));
    }
    purger(['r1', 'r2', 'r3', 'r4'], ['r1', 'r3']);
    assert.deepEqual(rids('salons'), ['r1', 'r3']);
  });

  test('un salon CRÉÉ pendant la requête réseau n’est pas effacé', () => {
    // L'instantané est pris avant l'aller-retour : il ne connaît que r1 et r2.
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r1', misAJourLe: 100 }));
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r2', misAJourLe: 100 }));
    const connus = ['r1', 'r2'];
    // …puis le stream DDP écrit un DM tout neuf pendant le vol. Il n'est ni
    // dans les vivants (le serveur avait déjà répondu), ni dans les connus.
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r3', misAJourLe: 200 }));
    db.prepare(UPSERT_ABONNEMENT).run(...abo({ rid: 'r3', misAJourLe: 200 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm-r3', rid: 'r3', misAJourLe: 200 }));

    purger(connus, ['r1']);

    assert.deepEqual(rids('salons'), ['r1', 'r3'], 'le DM arrivé en vol survit');
    assert.deepEqual(rids('abonnements'), ['r3']);
    assert.deepEqual(ids('messages'), ['m-r3']);
  });

  test('la purge emporte AUSSI sortie, téléversements, brouillons et curseurs', () => {
    for (const rid of ['r1', 'r2']) {
      db.prepare(UPSERT_SALON).run(...salon({ rid, misAJourLe: 100 }));
      db.prepare(INSERER_SORTIE).run(`${rid}-sortie`, rid, 'coucou', null, 1000);
      db.prepare(INSERER_TELEVERSEMENT).run(
        `${rid}-tlv`, rid, 'file:///a.jpg', 'a.jpg', 'image/jpeg', null, 1000,
      );
      db.prepare(UPSERT_BROUILLON).run(rid, 'brouillon de salon', 1000);
      db.prepare(UPSERT_BROUILLON).run(`${rid}:tmid`, 'brouillon de fil', 1000);
      db.prepare(UPSERT_CURSEUR).run(rid, 'messages', 5000);
    }
    db.prepare(UPSERT_CURSEUR).run('*', 'salons', 7000);

    purger(['r1', 'r2'], ['r1']);

    assert.deepEqual(ids('sortie'), ['r1-sortie'], 'la ligne zombie ne sera plus rejouée');
    assert.deepEqual(ids('televersements'), ['r1-tlv']);
    const cles = (db.prepare('SELECT cle FROM brouillons ORDER BY cle').all() as { cle: string }[])
      .map((l) => l.cle);
    assert.deepEqual(cles, ['r1', 'r1:tmid'], 'le brouillon de FIL suit son salon');
    const portees = (
      db.prepare('SELECT portee FROM etat_synchro ORDER BY portee').all() as { portee: string }[]
    ).map((l) => l.portee);
    assert.deepEqual(portees, ['*', 'r1'], 'le curseur GLOBAL ne tombe jamais');
  });

  test('une file d’envoi orpheline (salon déjà purgé) est reprise', () => {
    // Le zombie laissé par une purge d'avant ce correctif : plus de salon, plus
    // d'abonnement, plus de message — seulement la ligne de sortie.
    db.prepare(INSERER_SORTIE).run('z'.repeat(24), 'rZombie', 'jamais parti', null, 1000);
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r1', misAJourLe: 100 }));

    const connus = (db.prepare(LISTER_RIDS_CONNUS).all() as { rid: string }[]).map((l) => l.rid);
    assert.ok(connus.includes('rZombie'), 'l’instantané voit une table à rid, pas que les salons');

    purger(connus, ['r1']);
    assert.deepEqual(ids('sortie'), []);
  });

  test('un instantané VIDE n’efface rien — premier lancement', () => {
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r1', misAJourLe: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', rid: 'r1', misAJourLe: 100 }));
    purger([], ['rAutre']);
    assert.deepEqual(rids('salons'), ['r1']);
    assert.deepEqual(ids('messages'), ['m1']);
  });

  test('l’instantané ne compte pas les curseurs globaux comme des rids', () => {
    db.prepare(UPSERT_CURSEUR).run('*', 'salons', 7000);
    db.prepare(UPSERT_CURSEUR).run('r1', 'messages', 5000);
    const connus = (db.prepare(LISTER_RIDS_CONNUS).all() as { rid: string }[]).map((l) => l.rid);
    assert.deepEqual(connus.sort(), ['r1']);
  });
});

describe('départ d’un salon : les tables satellites partent avec lui', () => {
  test('sortie, téléversements, brouillons et curseurs du rid s’effacent', () => {
    for (const rid of ['r1', 'r2']) {
      db.prepare(INSERER_SORTIE).run(`${rid}-sortie`, rid, 'coucou', null, 1000);
      db.prepare(INSERER_TELEVERSEMENT).run(
        `${rid}-tlv`, rid, 'file:///a.jpg', 'a.jpg', 'image/jpeg', null, 1000,
      );
      db.prepare(UPSERT_BROUILLON).run(rid, 'brouillon', 1000);
      db.prepare(UPSERT_BROUILLON).run(`${rid}:tmid`, 'brouillon de fil', 1000);
      db.prepare(UPSERT_CURSEUR).run(rid, 'messages', 5000);
    }
    db.prepare(UPSERT_CURSEUR).run('*', 'salons', 7000);

    db.prepare(SUPPRIMER_SORTIE_SALON).run('r1');
    db.prepare(SUPPRIMER_TELEVERSEMENTS_SALON).run('r1');
    db.prepare(SUPPRIMER_BROUILLONS_SALON).run('r1');
    db.prepare(SUPPRIMER_CURSEURS_SALON).run('r1');

    const un = (sql: string): unknown[] => db.prepare(sql).all();
    assert.equal(un(`SELECT id FROM sortie WHERE rid = 'r1'`).length, 0);
    assert.equal(un(`SELECT id FROM televersements WHERE rid = 'r1'`).length, 0);
    assert.equal(un(`SELECT cle FROM brouillons WHERE cle LIKE 'r1%'`).length, 0);
    assert.equal(un(`SELECT portee FROM etat_synchro WHERE portee = 'r1'`).length, 0);

    assert.equal(un(`SELECT id FROM sortie WHERE rid = 'r2'`).length, 1, 'r2 est intact');
    assert.equal(un(`SELECT cle FROM brouillons WHERE cle LIKE 'r2%'`).length, 2);
    assert.equal(un(`SELECT portee FROM etat_synchro WHERE portee = '*'`).length, 1);
  });

  test('un curseur effacé au départ ne ressuscite pas à la réintégration', () => {
    // `UPSERT_CURSEUR` refuse toute régression : sans l'effacement, l'ancienne
    // valeur reprend la main et `rattraperSalon` repart d'un point qui ne dit
    // plus rien de l'état local — plafonné à 2 pages, il lui faut des dizaines
    // d'ouvertures pour converger, chacune payée en appels rate-limités.
    db.prepare(UPSERT_CURSEUR).run('r1', 'messages', 9000);
    db.prepare(SUPPRIMER_CURSEURS_SALON).run('r1');
    db.prepare(UPSERT_CURSEUR).run('r1', 'messages', 100);
    const l = db.prepare(LIRE_CURSEUR).get('r1', 'messages') as { mis_a_jour_depuis: number };
    assert.equal(l.mis_a_jour_depuis, 100, 'le nouveau curseur, bas, s’installe');
  });
});

describe('rétention : les N derniers messages par salon', () => {
  const ids = (): string[] =>
    (db.prepare('SELECT id FROM messages ORDER BY id').all() as { id: string }[]).map((l) => l.id);

  test('coupe PAR SALON, pas sur la table entière', () => {
    for (const rid of ['r1', 'r2']) {
      for (let i = 1; i <= 4; i += 1) {
        db.prepare(UPSERT_MESSAGE).run(
          ...msg({ id: `${rid}-m${i}`, rid, horodatage: i * 1000, misAJourLe: 100 }),
        );
      }
    }
    db.prepare(APPLIQUER_RETENTION).run(2);
    assert.deepEqual(ids(), ['r1-m3', 'r1-m4', 'r2-m3', 'r2-m4'], 'les 2 plus récents de CHACUN');
  });

  test('un salon sous le quota n’est pas touché', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'a', horodatage: 1000, misAJourLe: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'b', horodatage: 2000, misAJourLe: 100 }));
    db.prepare(APPLIQUER_RETENTION).run(500);
    assert.deepEqual(ids(), ['a', 'b']);
  });

  test('un message OPTIMISTE survit, si vieux soit-il, et ne consomme pas le quota', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'opt', horodatage: 1, misAJourLe: 0 }));
    for (let i = 1; i <= 3; i += 1) {
      db.prepare(UPSERT_MESSAGE).run(
        ...msg({ id: `m${i}`, horodatage: i * 1000, misAJourLe: 100 }),
      );
    }
    db.prepare(APPLIQUER_RETENTION).run(2);
    assert.deepEqual(ids(), ['m2', 'm3', 'opt'], 'les 2 derniers serveur, PLUS l’optimiste');
  });

  test('une racine de fil encore référencée est épargnée', () => {
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'racine', horodatage: 1, misAJourLe: 100, filReponses: 2 }),
    );
    for (let i = 1; i <= 3; i += 1) {
      db.prepare(UPSERT_MESSAGE).run(
        ...msg({ id: `m${i}`, horodatage: i * 1000, misAJourLe: 100 }),
      );
    }
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'rep', horodatage: 5000, misAJourLe: 100, filId: 'racine' }),
    );
    db.prepare(APPLIQUER_RETENTION).run(2);
    assert.ok(ids().includes('racine'), 'sans elle, l’écran fil n’a plus de tête');
    assert.ok(ids().includes('rep'));
  });

  test('une racine SANS réponse locale n’est pas un cas particulier', () => {
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'racine', horodatage: 1, misAJourLe: 100, filReponses: 2 }),
    );
    for (let i = 1; i <= 3; i += 1) {
      db.prepare(UPSERT_MESSAGE).run(
        ...msg({ id: `m${i}`, horodatage: i * 1000, misAJourLe: 100 }),
      );
    }
    db.prepare(APPLIQUER_RETENTION).run(2);
    assert.deepEqual(ids(), ['m2', 'm3']);
  });

  test('la coupe est déterministe sur des horodatages ex æquo', () => {
    for (const id of ['a', 'b', 'c']) {
      db.prepare(UPSERT_MESSAGE).run(...msg({ id, horodatage: 1000, misAJourLe: 100 }));
    }
    db.prepare(APPLIQUER_RETENTION).run(2);
    assert.deepEqual(ids(), ['b', 'c'], 'l’id départage, toujours dans le même sens');
  });
});

describe('identités (uid → pseudo courant)', () => {
  const q = 'SELECT username, mis_a_jour_le FROM utilisateurs WHERE uid = ?';

  function util(uid: string, username: string, misAJourLe: number) {
    return paramsUtilisateur({ uid, username, misAJourLe });
  }

  test('insère une identité inconnue', () => {
    db.prepare(UPSERT_UTILISATEUR).run(...util('u1', 'alice', 100));
    assert.deepEqual(ligne(db.prepare(q).get('u1')), { username: 'alice', mis_a_jour_le: 100 });
  });

  test('un renommage plus récent gagne', () => {
    db.prepare(UPSERT_UTILISATEUR).run(...util('u1', 'alice', 100));
    db.prepare(UPSERT_UTILISATEUR).run(...util('u1', 'alice2', 200));
    assert.deepEqual(ligne(db.prepare(q).get('u1')), { username: 'alice2', mis_a_jour_le: 200 });
  });

  test('un message PLUS ANCIEN ne rétrograde pas le pseudo', () => {
    // Un rattrapage REST peut livrer, après coup, une vieille copie d'un message
    // qui porte encore l'ancien pseudo : elle ne doit pas écraser le nouveau.
    db.prepare(UPSERT_UTILISATEUR).run(...util('u1', 'alice2', 200));
    db.prepare(UPSERT_UTILISATEUR).run(...util('u1', 'alice', 100));
    assert.deepEqual(
      ligne(db.prepare(q).get('u1')),
      { username: 'alice2', mis_a_jour_le: 200 },
      'le passé ne doit pas gagner',
    );
  });

  test('même pseudo, horodatage plus récent : la ligne ne bouge PAS', () => {
    // Le garde `username IS NOT` : sans lui, chaque message au même pseudo
    // toucherait la table et ferait rejouer la useLiveQuery des identités.
    db.prepare(UPSERT_UTILISATEUR).run(...util('u1', 'alice', 100));
    db.prepare(UPSERT_UTILISATEUR).run(...util('u1', 'alice', 500));
    assert.deepEqual(
      ligne(db.prepare(q).get('u1')),
      { username: 'alice', mis_a_jour_le: 100 },
      'horodatage figé : aucune écriture, donc aucun événement de changement',
    );
  });

  test('un upsert de message enregistre AUSSI l’identité de l’auteur', () => {
    // Le dépôt (db/depot.ts) dérive l'identité de chaque message ; ici on
    // reproduit la double écriture pour prouver le contrat de bout en bout.
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', auteurId: 'u9', auteurNom: 'bob', misAJourLe: 300 }));
    db.prepare(UPSERT_UTILISATEUR).run(...util('u9', 'bob', 300));
    assert.deepEqual(ligne(db.prepare(q).get('u9')), { username: 'bob', mis_a_jour_le: 300 });
  });
});

describe('versions d’avatar', () => {
  const lireUtil = 'SELECT username, avatar_etag FROM utilisateurs WHERE uid = ?';
  const lireSalon = 'SELECT avatar_etag FROM salons WHERE rid = ?';

  test('le stream pose la version par PSEUDO, pas par uid', () => {
    db.prepare(UPSERT_UTILISATEUR).run(...paramsUtilisateur({ uid: 'u1', username: 'alice', misAJourLe: 1 }));
    db.prepare(MAJ_AVATAR_UTILISATEUR).run('e1', 'alice', 'e1');
    assert.deepEqual(ligne(db.prepare(lireUtil).get('u1')), {
      username: 'alice',
      avatar_etag: 'e1',
    });
  });

  test('un pseudo inconnu ne crée rien — sa photo n’est affichée nulle part', () => {
    db.prepare(MAJ_AVATAR_UTILISATEUR).run('e1', 'fantome', 'e1');
    const n = db.prepare('SELECT COUNT(*) AS n FROM utilisateurs').get() as { n: number };
    assert.equal(n.n, 0);
  });

  test('l’identité autoritaire CRÉE la ligne (mon compte, qui n’a rien posté)', () => {
    db.prepare(UPSERT_IDENTITE).run(...paramsIdentite({ uid: 'moi', username: 'guy', avatarEtag: 'e7' }));
    assert.deepEqual(ligne(db.prepare(lireUtil).get('moi')), { username: 'guy', avatar_etag: 'e7' });
  });

  test('`users.info` SANS avatarETag n’efface pas la version connue', () => {
    // Le champ est absent quand la personne n'a pas de photo — et absent aussi
    // des réponses partielles. L'effacer ferait retomber l'URL sur sa forme
    // d'origine, que le cache image sert avec l'ANCIENNE photo.
    db.prepare(UPSERT_IDENTITE).run(...paramsIdentite({ uid: 'u1', username: 'alice', avatarEtag: 'e1' }));
    db.prepare(UPSERT_IDENTITE).run(...paramsIdentite({ uid: 'u1', username: 'alice', avatarEtag: null }));
    assert.deepEqual(ligne(db.prepare(lireUtil).get('u1')), { username: 'alice', avatar_etag: 'e1' });
  });

  test('un salon garde sa version quand le document Rooms ne la porte pas', () => {
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r1', misAJourLe: 100, avatarEtag: 'e1' }));
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r1', misAJourLe: 200 }));
    assert.deepEqual(ligne(db.prepare(lireSalon).get('r1')), { avatar_etag: 'e1' });
  });

  test('le stream met à jour la version d’un salon', () => {
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r1', misAJourLe: 100, avatarEtag: 'e1' }));
    db.prepare(MAJ_AVATAR_SALON).run('e2', 'r1', 'e2');
    assert.deepEqual(ligne(db.prepare(lireSalon).get('r1')), { avatar_etag: 'e2' });
  });

  test('une version INCHANGÉE ne touche pas la ligne', () => {
    // Sans cette garde, chaque rediffusion réveillerait toutes les requêtes
    // vives assises sur la table — donc re-rendrait la liste entière.
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'r1', misAJourLe: 100, avatarEtag: 'e1' }));
    const compter = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const avant = compter();
    db.prepare(MAJ_AVATAR_SALON).run('e1', 'r1', 'e1');
    assert.equal(compter(), avant, 'aucune écriture');
  });
});

describe('aperçu de liste d’un salon chiffré', () => {
  const lire = 'SELECT dernier_message FROM salons WHERE rid = ?';
  const compter = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

  test('l’aperçu suit le dernier message déchiffré', () => {
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'rid-1', chiffre: true, misAJourLe: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'un', horodatage: 10, misAJourLe: 1 }));
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm2', texte: 'deux', horodatage: 20, misAJourLe: 2 }),
    );
    db.prepare(MAJ_APERCU_CHIFFRE).run();
    assert.deepEqual(ligne(db.prepare(lire).get('rid-1')), { dernier_message: 'deux' });
  });

  test('supprimer le dernier message fait RECULER l’aperçu sur le précédent', () => {
    // Le serveur ne peut pas nous l'apprendre ici : il ne détient que du
    // ciphertext. Seule la base locale sait quel message reste.
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'rid-1', chiffre: true, misAJourLe: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'un', horodatage: 10, misAJourLe: 1 }));
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm2', texte: 'deux', horodatage: 20, misAJourLe: 2 }),
    );
    db.prepare(MAJ_APERCU_CHIFFRE).run();

    db.prepare(SUPPRIMER_MESSAGE).run('m2');
    db.prepare(MAJ_APERCU_CHIFFRE).run();
    assert.deepEqual(ligne(db.prepare(lire).get('rid-1')), { dernier_message: 'un' });
  });

  test('salon chiffré VIDÉ : l’aperçu retombe au placeholder', () => {
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'rid-1', chiffre: true, misAJourLe: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'seul', horodatage: 10, misAJourLe: 1 }));
    db.prepare(MAJ_APERCU_CHIFFRE).run();

    db.prepare(SUPPRIMER_MESSAGE).run('m1');
    db.prepare(MAJ_APERCU_CHIFFRE).run();
    assert.deepEqual(ligne(db.prepare(lire).get('rid-1')), { dernier_message: null });
  });

  test('un aperçu INCHANGÉ ne touche pas la ligne', () => {
    // `supprimerMessage` rejoue ce SQL à CHAQUE suppression, dans n'importe
    // quel salon : sans cette garde, il réveillerait la liste entière à chaque
    // fois — y compris sur un compte sans aucun salon chiffré.
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'rid-1', chiffre: true, misAJourLe: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'un', horodatage: 10, misAJourLe: 1 }));
    db.prepare(MAJ_APERCU_CHIFFRE).run();

    const avant = compter();
    db.prepare(MAJ_APERCU_CHIFFRE).run();
    assert.equal(compter(), avant, 'aucune écriture');
  });

  test('un message DÉCHIFFRÉ compte, alors qu’il porte t: e2e', () => {
    // Anti-régression : dans un salon chiffré, TOUS les messages portent
    // `t: 'e2e'`. Un filtre « pas de message système » écrit naïvement
    // (`type_systeme IS NULL`) viderait donc l'aperçu de tous les salons
    // chiffrés — c'est-à-dire la seule chose que cette requête calcule.
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'rid-1', chiffre: true, misAJourLe: 100 }));
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', texte: 'clair', typeSysteme: 'e2e', horodatage: 10, misAJourLe: 1 }),
    );
    db.prepare(MAJ_APERCU_CHIFFRE).run();
    assert.deepEqual(ligne(db.prepare(lire).get('rid-1')), { dernier_message: 'clair' });
  });

  test('une réponse de FIL invisible dans le salon ne devient pas l’aperçu', () => {
    // Le flux du salon l'écarte (`fil_id IS NULL OR fil_affiche`) : l'annoncer
    // en liste ferait promettre un message introuvable en ouvrant le salon.
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'rid-1', chiffre: true, misAJourLe: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'visible', horodatage: 10, misAJourLe: 1 }));
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm2', texte: 'dans le fil', filId: 'm1', horodatage: 20, misAJourLe: 2 }),
    );
    db.prepare(MAJ_APERCU_CHIFFRE).run();
    assert.deepEqual(ligne(db.prepare(lire).get('rid-1')), { dernier_message: 'visible' });
  });

  test('une réponse de fil COCHÉE « aussi dans le salon » compte, elle', () => {
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'rid-1', chiffre: true, misAJourLe: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'visible', horodatage: 10, misAJourLe: 1 }));
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({
        id: 'm2',
        texte: 'dans le fil ET dans le salon',
        filId: 'm1',
        filAffiche: true,
        horodatage: 20,
        misAJourLe: 2,
      }),
    );
    db.prepare(MAJ_APERCU_CHIFFRE).run();
    assert.deepEqual(ligne(db.prepare(lire).get('rid-1')), {
      dernier_message: 'dans le fil ET dans le salon',
    });
  });

  test('un message SYSTÈME ne devient pas l’aperçu — son texte n’est qu’un paramètre', () => {
    // Le fil rend « alice » + « a rejoint le salon » ; le `texte` seul, mis en
    // aperçu, n'affichait que « alice ».
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'rid-1', chiffre: true, misAJourLe: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', texte: 'vrai message', horodatage: 10, misAJourLe: 1 }));
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm2', texte: 'alice', typeSysteme: 'uj', horodatage: 20, misAJourLe: 2 }),
    );
    db.prepare(MAJ_APERCU_CHIFFRE).run();
    assert.deepEqual(ligne(db.prepare(lire).get('rid-1')), { dernier_message: 'vrai message' });
  });

  test('deux messages à la MÊME milliseconde : même gagnant que le flux', () => {
    // Le flux départage par `id DESC`. Sans la même clé secondaire ici,
    // l'aperçu et la première ligne du salon désignaient deux messages
    // différents, au gré de l'ordre d'insertion (rowid).
    db.prepare(UPSERT_SALON).run(...salon({ rid: 'rid-1', chiffre: true, misAJourLe: 100 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'mb', texte: 'B', horodatage: 10, misAJourLe: 1 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'ma', texte: 'A', horodatage: 10, misAJourLe: 2 }));
    db.prepare(MAJ_APERCU_CHIFFRE).run();
    assert.deepEqual(ligne(db.prepare(lire).get('rid-1')), { dernier_message: 'B' });
  });

  test('un salon EN CLAIR n’est jamais touché par cette passe', () => {
    // Son aperçu vient du serveur (`lastMessage`), et l'historique local est
    // partiel : le recalculer ici l'écraserait avec ce qu'on a sous la main.
    db.prepare(UPSERT_SALON).run(
      ...salon({ rid: 'rid-1', chiffre: false, dernierMessage: 'du serveur', misAJourLe: 100 }),
    );
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', texte: 'local', horodatage: 10, misAJourLe: 1 }),
    );
    db.prepare(MAJ_APERCU_CHIFFRE).run();
    assert.deepEqual(ligne(db.prepare(lire).get('rid-1')), { dernier_message: 'du serveur' });
  });
});

describe('verrouillage E2EE : masquer sans réécrire ce qui l’est déjà', () => {
  const compter = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

  test('le masquage efface le clair et laisse le ciphertext', () => {
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', texte: 'clair', chiffreBrut: '{"ciphertext":"x"}', misAJourLe: 1 }),
    );
    db.prepare(MASQUER_MESSAGES_CHIFFRES).run();
    assert.deepEqual(
      ligne(db.prepare('SELECT texte, chiffre_brut FROM messages WHERE id = ?').get('m1')),
      { texte: null, chiffre_brut: '{"ciphertext":"x"}' },
    );
  });

  test('un verrouillage REJOUÉ n’écrit rien', () => {
    // `reverrouillageE2E` rejoue l'opération ; sans la garde, elle toucherait
    // toute la table `messages` et réveillerait chaque requête vive assise
    // dessus — donc re-rendrait le salon ouvert, pour rien.
    db.prepare(UPSERT_MESSAGE).run(
      ...msg({ id: 'm1', texte: 'clair', chiffreBrut: '{"ciphertext":"x"}', misAJourLe: 1 }),
    );
    db.prepare(MASQUER_MESSAGES_CHIFFRES).run();

    const avant = compter();
    db.prepare(MASQUER_MESSAGES_CHIFFRES).run();
    assert.equal(compter(), avant, 'aucune écriture');
  });

  test('l’aperçu chiffré déjà masqué n’est pas réécrit non plus', () => {
    db.prepare(UPSERT_SALON).run(
      ...salon({ rid: 'rid-1', chiffre: true, dernierMessage: 'clair', misAJourLe: 100 }),
    );
    db.prepare(MASQUER_APERCU_CHIFFRE).run();
    assert.deepEqual(
      ligne(db.prepare('SELECT dernier_message FROM salons WHERE rid = ?').get('rid-1')),
      { dernier_message: null },
    );

    const avant = compter();
    db.prepare(MASQUER_APERCU_CHIFFRE).run();
    assert.equal(compter(), avant, 'aucune écriture');
  });
});

describe('aperçu de liste : le type du dernier message', () => {
  const lire = 'SELECT dernier_message, dernier_message_type FROM salons WHERE rid = ?';

  test('un appel vidéo n’a pas de texte, mais laisse son type', () => {
    // Sans quoi le salon remonte en tête de liste avec une ligne VIDE : c'est
    // la colonne qui permet à l'écran d'écrire « Appel vidéo » à la place.
    const s = versSalon({
      _id: 'r1',
      t: 'c',
      _updatedAt: { $date: 100 },
      lastMessage: { _id: 'm1', msg: '', t: 'videoconf', ts: { $date: 50 } },
    });
    db.prepare(UPSERT_SALON).run(...paramsSalon(s!));
    assert.deepEqual(ligne(db.prepare(lire).get('r1')), {
      dernier_message: null,
      dernier_message_type: 'videoconf',
    });
  });

  test('un message ORDINAIRE qui suit remet le type à null', () => {
    const appel = versSalon({
      _id: 'r1',
      t: 'c',
      _updatedAt: { $date: 100 },
      lastMessage: { _id: 'm1', msg: '', t: 'videoconf', ts: { $date: 50 } },
    });
    db.prepare(UPSERT_SALON).run(...paramsSalon(appel!));

    const apres = versSalon({
      _id: 'r1',
      t: 'c',
      _updatedAt: { $date: 200 },
      lastMessage: { _id: 'm2', msg: 'coucou', ts: { $date: 60 } },
    });
    db.prepare(UPSERT_SALON).run(...paramsSalon(apres!));
    assert.deepEqual(ligne(db.prepare(lire).get('r1')), {
      dernier_message: 'coucou',
      dernier_message_type: null,
    });
  });

  test('salon VIDÉ : les deux colonnes retombent à null', () => {
    // Le document Rooms perd complètement son `lastMessage` — c'est la seule
    // façon d'apprendre qu'un salon a été vidé, et il faut la distinguer de
    // « dernier message sans texte ».
    const plein = versSalon({
      _id: 'r1',
      t: 'c',
      _updatedAt: { $date: 100 },
      lastMessage: { _id: 'm1', msg: 'coucou', ts: { $date: 50 } },
    });
    db.prepare(UPSERT_SALON).run(...paramsSalon(plein!));

    const vide = versSalon({ _id: 'r1', t: 'c', _updatedAt: { $date: 200 } });
    db.prepare(UPSERT_SALON).run(...paramsSalon(vide!));
    assert.deepEqual(ligne(db.prepare(lire).get('r1')), {
      dernier_message: null,
      dernier_message_type: null,
    });
  });

  test('un salon CHIFFRÉ ne garde aucun type : son aperçu est calculé localement', () => {
    // Le serveur ne sait pas lire ses messages ; y laisser le `t` ferait
    // décrire l'aperçu local (`MAJ_APERCU_CHIFFRE`) par le type d'un AUTRE
    // message — un « a rejoint le salon » collé sur un vrai message.
    const s = versSalon({
      _id: 'r1',
      t: 'p',
      encrypted: true,
      _updatedAt: { $date: 100 },
      lastMessage: { _id: 'm1', msg: 'alice', t: 'uj', ts: { $date: 50 } },
    });
    db.prepare(UPSERT_SALON).run(...paramsSalon(s!));
    assert.deepEqual(ligne(db.prepare(lire).get('r1')), {
      dernier_message: null,
      dernier_message_type: null,
    });
  });
});

/**
 * Bout en bout, sur les charges RÉELLEMENT captées d'un Rocket.Chat 8.5 (sonde
 * DDP sur le serveur local, juillet 2026). Les tests ci-dessus éprouvent
 * `versSalon` et le SQL séparément ; celui-ci vérifie leur COMPOSITION sur les
 * documents que le serveur envoie vraiment — c'est là que le bug vivait.
 */
describe('aperçu de liste : les documents réels du serveur', () => {
  const AUTEUR = { _id: 'a8Lu', username: 'alice', name: 'Alice Martin' };
  const lire = 'SELECT dernier_message FROM salons WHERE rid = ?';

  /** Le document Room tel que `rooms-changed` le livre, sans son `lastMessage`. */
  const room = (misAJourLe: number) => ({
    _id: 'r1',
    fname: 'sonde',
    name: 'sonde',
    t: 'c',
    u: AUTEUR,
    ro: false,
    sysMes: true,
    lm: { $date: 1784958551573 },
    _updatedAt: { $date: misAJourLe },
  });

  const ingerer = (brut: Record<string, unknown>) => {
    const s = versSalon(brut, 'alice', 'a8Lu');
    assert.notEqual(s, null, 'le document doit se normaliser');
    db.prepare(UPSERT_SALON).run(...paramsSalon(s as SalonLocal));
  };

  test('supprimer le DERNIER message d’un salon en efface l’aperçu', () => {
    ingerer({
      ...room(1784958546377),
      msgs: 1,
      lastMessage: { _id: 'm1', msg: 'PREMIER', ts: { $date: 1784958546341 }, u: AUTEUR },
    });
    assert.deepEqual(ligne(db.prepare(lire).get('r1')), { dernier_message: 'PREMIER' });

    // Le salon vidé : le serveur n'envoie PLUS de `lastMessage` du tout.
    ingerer({ ...room(1784958558296), msgs: 0 });
    assert.deepEqual(
      ligne(db.prepare(lire).get('r1')),
      { dernier_message: null },
      'le message supprimé ne doit plus figurer dans la liste',
    );
  });

  test('une pièce jointe sans légende ne laisse pas l’aperçu précédent', () => {
    ingerer({
      ...room(1784958546377),
      lastMessage: { _id: 'm1', msg: 'PREMIER', ts: { $date: 1784958546341 }, u: AUTEUR },
    });
    ingerer({
      ...room(1784958549011),
      lastMessage: {
        _id: 'm2',
        msg: '',
        ts: { $date: 1784958548985 },
        u: AUTEUR,
        file: { _id: 'f1', name: 'note.txt', type: 'text/plain' },
        attachments: [
          { title: 'note.txt', title_link: '/file-upload/f1/note.txt', type: 'file', format: 'TXT' },
        ],
      },
    });
    assert.deepEqual(ligne(db.prepare(lire).get('r1')), { dernier_message: 'note.txt' });
  });
});

/**
 * Brouillons de composer. Ce SQL n'existait pas — l'écriture était construite
 * par Drizzle dans `ui/brouillons.ts` et lancée hors de la file d'écritures,
 * donc jamais exécutée par un test. Il vit désormais ici, avec le reste.
 */
describe('brouillons', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = baseMigree();
  });

  test('écrit puis relit un brouillon', () => {
    db.prepare(UPSERT_BROUILLON).run('r1', 'salut', 1000);
    assert.deepEqual(ligne(db.prepare(LIRE_BROUILLON).get('r1')), { texte: 'salut' });
  });

  test('une clé absente ne rend rien', () => {
    assert.equal(db.prepare(LIRE_BROUILLON).get('jamais-ecrit'), undefined);
  });

  test('la dernière frappe écrase la précédente, sans garde de fraîcheur', () => {
    db.prepare(UPSERT_BROUILLON).run('r1', 'premier', 2000);
    // Horodatage PLUS ANCIEN : contrairement aux upserts venus du réseau, il ne
    // doit rien bloquer — la seule source est la frappe, la dernière gagne.
    db.prepare(UPSERT_BROUILLON).run('r1', 'second', 1000);
    assert.deepEqual(ligne(db.prepare(LIRE_BROUILLON).get('r1')), { texte: 'second' });
  });

  test('le brouillon d’un fil ne touche pas celui du salon', () => {
    db.prepare(UPSERT_BROUILLON).run('r1', 'du salon', 1000);
    db.prepare(UPSERT_BROUILLON).run('r1:m9', 'du fil', 1000);
    assert.deepEqual(ligne(db.prepare(LIRE_BROUILLON).get('r1')), { texte: 'du salon' });
    assert.deepEqual(ligne(db.prepare(LIRE_BROUILLON).get('r1:m9')), { texte: 'du fil' });
  });

  test('la suppression ne vise que sa clé', () => {
    db.prepare(UPSERT_BROUILLON).run('r1', 'du salon', 1000);
    db.prepare(UPSERT_BROUILLON).run('r2', 'ailleurs', 1000);
    db.prepare(SUPPRIMER_BROUILLON).run('r1');
    assert.equal(db.prepare(LIRE_BROUILLON).get('r1'), undefined);
    assert.deepEqual(ligne(db.prepare(LIRE_BROUILLON).get('r2')), { texte: 'ailleurs' });
  });

  test('supprimer une clé absente ne lève pas', () => {
    db.prepare(SUPPRIMER_BROUILLON).run('jamais-ecrit');
  });
});

describe('pièces jointes d’un fichier chiffré', () => {
  const lire = 'SELECT texte, pieces_jointes FROM messages WHERE id = ?';
  const jointes = JSON.stringify([{ title: 'photo.jpg', encryption: { iv: 'aXY=' } }]);
  const chiffre = { typeSysteme: 'e2e', texte: null, chiffreBrut: '{"ciphertext":"x"}' } as const;

  test('posées au déchiffrement, gardées par une resynchro sans clé', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', ...chiffre, misAJourLe: 1 }));
    db.prepare(MAJ_TEXTE_MESSAGE).run('', jointes, 'm1');
    assert.deepEqual(ligne(db.prepare(lire).get('m1')), { texte: '', pieces_jointes: jointes });

    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', ...chiffre, misAJourLe: 2 }));
    assert.deepEqual(ligne(db.prepare(lire).get('m1')), { texte: '', pieces_jointes: jointes });
  });

  test('un texte déchiffré sans pièce jointe ne les efface pas', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', ...chiffre, misAJourLe: 1 }));
    db.prepare(MAJ_TEXTE_MESSAGE).run('', jointes, 'm1');
    db.prepare(MAJ_TEXTE_MESSAGE).run('légende', null, 'm1');
    assert.deepEqual(ligne(db.prepare(lire).get('m1')), { texte: 'légende', pieces_jointes: jointes });
  });

  test('effacées au verrouillage : elles portent la clé du fichier', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', ...chiffre, misAJourLe: 1 }));
    db.prepare(MAJ_TEXTE_MESSAGE).run('', jointes, 'm1');
    db.prepare(MASQUER_MESSAGES_CHIFFRES).run();
    assert.deepEqual(ligne(db.prepare(lire).get('m1')), { texte: null, pieces_jointes: null });
  });

  test('un message ordinaire suit toujours le serveur', () => {
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', piecesJointes: jointes, misAJourLe: 1 }));
    db.prepare(UPSERT_MESSAGE).run(...msg({ id: 'm1', piecesJointes: null, misAJourLe: 2 }));
    assert.deepEqual(ligne(db.prepare(lire).get('m1')), { texte: 'bonjour', pieces_jointes: null });
  });
});
