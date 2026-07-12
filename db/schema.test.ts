import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Les migrations sont générées par `drizzle-kit`. Générées ne veut pas dire
 * valides : on les applique pour de vrai, sur un SQLite en mémoire.
 * `db/migrations/*.sql` utilise `--> statement-breakpoint` comme séparateur.
 */
const DOSSIER = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function baseMigree(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const fichiers = readdirSync(DOSSIER)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  assert.ok(fichiers.length > 0, 'aucune migration générée');
  for (const fichier of fichiers) {
    for (const requete of readFileSync(join(DOSSIER, fichier), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      const sql = requete.trim();
      if (sql !== '') db.exec(sql);
    }
  }
  return db;
}

function tables(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((l) => String((l as { name: unknown }).name))
    .sort();
}

describe('migrations', () => {
  test('le SQL généré s’applique sur une base vierge', () => {
    const db = baseMigree();
    assert.deepEqual(tables(db), [
      'abonnements',
      'brouillons',
      'emojis_custom',
      'etat_synchro',
      'messages',
      'salons',
      'sortie',
      'televersements',
    ]);
    db.close();
  });

  test('les index qui portent les requêtes chaudes existent', () => {
    const db = baseMigree();
    const index = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all()
      .map((l) => String((l as { name: unknown }).name))
      .sort();
    assert.deepEqual(index, [
      'idx_messages_fil',
      'idx_messages_salon_date',
      'idx_salons_activite',
      'idx_sortie_statut',
      'idx_televersements_statut',
    ]);
    db.close();
  });

  test('la requête de l’écran salon utilise bien son index', () => {
    const db = baseMigree();
    // `WHERE rid = ? ORDER BY horodatage DESC` est LA requête de l'étape 4.2 :
    // si elle passe par un balayage complet, la liste ramera dès 10 000 messages.
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM messages WHERE rid = ? ORDER BY horodatage DESC')
      .all()
      .map((l) => String((l as { detail: unknown }).detail))
      .join(' ');
    assert.match(plan, /USING INDEX idx_messages_salon_date/);
    assert.doesNotMatch(plan, /SCAN messages/);
    db.close();
  });

  test('deux messages à la même milliseconde s’ordonnent de façon déterministe', () => {
    // Sans clé secondaire, SQLite rend les ex æquo dans l'ordre d'INSERTION
    // (rowid) — donc À L'ENVERS après une pagination d'historique (insérée du
    // plus récent au plus ancien). On départage par `id` : l'ordre doit être le
    // MÊME quel que soit l'ordre d'insertion. C'est la requête de l'écran salon.
    const REQUETE =
      'SELECT id FROM messages WHERE rid = ? ORDER BY horodatage DESC, id DESC LIMIT 50';
    const inserer = (db: DatabaseSync, ids: string[]) => {
      const stmt = db.prepare(
        'INSERT INTO messages (id, rid, horodatage, auteur_id) VALUES (?, ?, ?, ?)',
      );
      for (const id of ids) stmt.run(id, 'rid-1', 1000, 'u1');
    };
    const lire = (db: DatabaseSync) =>
      (db.prepare(REQUETE).all('rid-1') as { id: string }[]).map((r) => r.id);

    const croissant = baseMigree();
    inserer(croissant, ['a', 'b', 'c']);
    const decroissant = baseMigree();
    inserer(decroissant, ['c', 'b', 'a']); // ordre d'insertion inverse (pagination)

    assert.deepEqual(lire(croissant), ['c', 'b', 'a']);
    // L'invariant clé : insertion inverse → MÊME ordre affiché (avant le
    // correctif, ceci rendait ['a', 'b', 'c']).
    assert.deepEqual(lire(decroissant), lire(croissant));
    croissant.close();
    decroissant.close();
  });

  test('`id` déduplique les messages : une seconde insertion est refusée', () => {
    const db = baseMigree();
    const inserer = db.prepare(
      'INSERT INTO messages (id, rid, horodatage, auteur_id) VALUES (?, ?, ?, ?)',
    );
    inserer.run('msg-1', 'rid-1', 1000, 'u1');
    assert.throws(() => inserer.run('msg-1', 'rid-1', 1000, 'u1'), /UNIQUE/);
    db.close();
  });

  test('`etat_synchro` est bien à clé composite (portée, flux)', () => {
    const db = baseMigree();
    const inserer = db.prepare(
      'INSERT INTO etat_synchro (portee, flux, mis_a_jour_depuis) VALUES (?, ?, ?)',
    );
    inserer.run('rid-1', 'messages', 1);
    inserer.run('rid-1', 'abonnements', 1); // même portée, autre flux : accepté
    inserer.run('*', 'messages', 1); // curseur global
    assert.throws(() => inserer.run('rid-1', 'messages', 2), /UNIQUE/);
    db.close();
  });

  test('les valeurs par défaut évitent les colonnes nulles inattendues', () => {
    const db = baseMigree();
    db.prepare('INSERT INTO salons (rid, type) VALUES (?, ?)').run('r1', 'c');
    const salon = db.prepare('SELECT * FROM salons WHERE rid = ?').get('r1') as Record<
      string,
      unknown
    >;
    assert.equal(salon.chiffre, 0);
    assert.equal(salon.lecture_seule, 0);
    assert.equal(salon.mis_a_jour_le, 0);

    db.prepare('INSERT INTO sortie (id, rid, texte, cree_le) VALUES (?, ?, ?, ?)').run(
      's1',
      'r1',
      'coucou',
      42,
    );
    const envoi = db.prepare('SELECT * FROM sortie WHERE id = ?').get('s1') as Record<
      string,
      unknown
    >;
    assert.equal(envoi.statut, 'en-attente');
    assert.equal(envoi.tentatives, 0);
    db.close();
  });
});
