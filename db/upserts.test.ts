import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AbonnementLocal, MessageLocal, SalonLocal } from '../lib/normaliser.ts';
import {
  INSERER_EMOJI_CUSTOM,
  INSERER_SORTIE,
  LISTER_EMOJIS_CUSTOM,
  LISTER_SORTIE_A_ENVOYER,
  MARQUER_SORTIE_ECHEC,
  PURGER_ABONNEMENTS_ABSENTS,
  PURGER_MESSAGES_ABSENTS,
  PURGER_SALONS_ABSENTS,
  MAJ_AVATAR_SALON,
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

  test('efface salon, abonnement ET messages dont le rid n’est plus vivant', () => {
    for (const rid of ['r1', 'r2', 'r3']) {
      db.prepare(UPSERT_SALON).run(...salon({ rid, misAJourLe: 100 }));
      db.prepare(UPSERT_ABONNEMENT).run(...abo({ rid, misAJourLe: 100 }));
      db.prepare(UPSERT_MESSAGE).run(...msg({ id: `m-${rid}`, rid, misAJourLe: 100 }));
    }
    const vivants = JSON.stringify(['r1']);
    db.prepare(PURGER_SALONS_ABSENTS).run(vivants);
    db.prepare(PURGER_ABONNEMENTS_ABSENTS).run(vivants);
    db.prepare(PURGER_MESSAGES_ABSENTS).run(vivants);

    assert.deepEqual(rids('salons'), ['r1'], 'seul le salon vivant reste');
    assert.deepEqual(rids('abonnements'), ['r1']);
    const idsMessages = (db.prepare('SELECT id FROM messages ORDER BY id').all() as { id: string }[])
      .map((l) => l.id);
    assert.deepEqual(idsMessages, ['m-r1'], 'les messages orphelins partent aussi');
  });

  test('garde plusieurs rids vivants, purge le reste', () => {
    for (const rid of ['r1', 'r2', 'r3', 'r4']) {
      db.prepare(UPSERT_SALON).run(...salon({ rid, misAJourLe: 100 }));
    }
    db.prepare(PURGER_SALONS_ABSENTS).run(JSON.stringify(['r1', 'r3']));
    assert.deepEqual(rids('salons'), ['r1', 'r3']);
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
