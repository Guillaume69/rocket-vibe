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

test('edit reference migration retains older operation IDs and drafts without inventing a new body',()=>{
  const db=baseMigreeAvant(25);
  try {
    db.exec("INSERT INTO native_commands(id,rid,message_id,kind,expected_revision,text) VALUES('old-operation','room','message','edit','9007199254740993','Saved draft')");
    appliquerMigration(db,25);
    const row=db.prepare('SELECT id,expected_revision,text,state,quotes FROM native_commands').get()!;
    assert.equal(row.id,'old-operation');assert.equal(row.expected_revision,'9007199254740993');assert.equal(row.text,'Saved draft');assert.equal(row.state,'pending');assert.equal(row.quotes,null);
  }finally {db.close();}
});

function tables(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((l) => String((l as { name: unknown }).name))
    .sort();
}

/** Applique les migrations dont l'index numérique est < `avant`, dans l'ordre. */
function baseMigreeAvant(avant: number): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const fichiers = readdirSync(DOSSIER)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const fichier of fichiers) {
    if (parseInt(fichier.slice(0, 4), 10) >= avant) continue;
    for (const requete of readFileSync(join(DOSSIER, fichier), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      const sql = requete.trim();
      if (sql !== '') db.exec(sql);
    }
  }
  return db;
}

/** Applique les statements d'UN fichier de migration (par son index). */
function appliquerMigration(db: DatabaseSync, index: number): void {
  const fichier = readdirSync(DOSSIER).find((f) => parseInt(f.slice(0, 4), 10) === index);
  assert.ok(fichier !== undefined, `migration ${index} absente`);
  for (const requete of readFileSync(join(DOSSIER, fichier), 'utf8').split('--> statement-breakpoint')) {
    const sql = requete.trim();
    if (sql !== '') db.exec(sql);
  }
}

describe('backfill des identités (0009)', () => {
  test('sème utilisateurs depuis les messages EXISTANTS : pseudo le plus récent par uid', () => {
    // Une base d'AVANT la table d'identités, avec un historique déjà là.
    const db = baseMigreeAvant(9);
    const ins =
      'INSERT INTO messages (id, rid, horodatage, auteur_id, auteur_nom, mis_a_jour_le) VALUES (?, ?, ?, ?, ?, ?)';
    // u1 : ancien pseudo (100) puis renommé (200). u2 : un seul message. u3 :
    // message chiffré sans auteur_nom → ne doit PAS créer d'identité.
    db.prepare(ins).run('m1', 'r1', 1, 'u1', 'alice', 100);
    db.prepare(ins).run('m2', 'r1', 2, 'u1', 'alice-neuve', 200);
    db.prepare(ins).run('m3', 'r1', 3, 'u2', 'bob', 150);
    db.prepare(ins).run('m4', 'r1', 4, 'u3', null, 300);

    appliquerMigration(db, 9);

    const lignes = db
      .prepare('SELECT uid, username, mis_a_jour_le FROM utilisateurs ORDER BY uid')
      .all()
      .map((l) => ({ ...(l as Record<string, unknown>) }));
    assert.deepEqual(lignes, [
      { uid: 'u1', username: 'alice-neuve', mis_a_jour_le: 200 },
      { uid: 'u2', username: 'bob', mis_a_jour_le: 150 },
    ]);
    db.close();
  });
});

describe('migrations', () => {
  test('le SQL généré s’applique sur une base vierge', () => {
    const db = baseMigree();
    assert.deepEqual(tables(db), [
      'abonnements',
      'brouillons',
      'emojis_custom',
      'etat_synchro',
      'messages',
      'native_commands',
      'native_favorite_intents',
      'native_positions',
      'native_quote_references',
      'native_quote_sources',
      'native_read_intents',
      'native_read_states',
      'native_room_access',
      'native_room_creations',
      'native_room_operations',
      'native_star_states',
      'native_sync_state',
      'salons',
      'sortie',
      'televersements',
      'utilisateurs',
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
      'idx_native_command_message',
      'idx_native_favorite_operation',
      'idx_native_positions_room',
      'idx_native_quote_origins',
      'idx_native_quote_source_rooms',
      'idx_native_room_creation_form',
      'idx_native_room_operation_room',
      'idx_native_star_room',
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

test('quote migration adds reader views without rewriting existing messages or exact positions',()=>{
  const db=baseMigreeAvant(24);
  try {
    db.prepare('INSERT INTO messages(id,rid,horodatage,auteur_id,auteur_nom,texte,mis_a_jour_le) VALUES(?,?,?,?,?,?,?)').run('old-message','origin',1,'alice-id','alice','Historique conservé',1);
    db.prepare('INSERT INTO native_positions(id,rid,position,revision) VALUES(?,?,?,?)').run('old-message','origin','9007199254740993','9007199254740993');
    appliquerMigration(db,24);
    assert.equal((db.prepare('SELECT texte FROM messages WHERE id=?').get('old-message') as {texte:string}).texte,'Historique conservé');
    assert.equal((db.prepare('SELECT position FROM native_positions WHERE id=?').get('old-message') as {position:string}).position,'9007199254740993');
    assert.equal((db.prepare('SELECT count(*) AS n FROM native_quote_sources').get() as {n:number}).n,0);
  }finally {db.close();}
});

/**
 * `file_id` arrive sur une base qui tourne DÉJÀ sur le téléphone, avec des
 * lignes de téléversement dedans. Le migrateur de drizzle applique les
 * migrations dans une seule transaction, avec ROLLBACK sur erreur : un
 * `ALTER TABLE` qui échoue ne casse pas la base, il bloque le démarrage à la
 * phase `erreur`. Ce test vaut donc pour le lancement réel sur le Pixel.
 */
describe('ajout de file_id à la file de téléversements (0013)', () => {
  test('une base d’AVANT, avec des lignes, gagne la colonne sans rien perdre', () => {
    const db = baseMigreeAvant(13);

    db.prepare(
      'INSERT INTO televersements (id, rid, uri, nom, type, legende, cree_le) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('t1', 'r1', 'file:///vieux.png', 'vieux.png', 'image/png', 'ma légende', 1000);

    appliquerMigration(db, 13);

    const l = db.prepare('SELECT * FROM televersements WHERE id = ?').get('t1') as Record<
      string,
      unknown
    >;
    assert.equal(l.uri, 'file:///vieux.png', 'la ligne d’avant survit intacte');
    assert.equal(l.legende, 'ma légende');
    assert.equal(l.statut, 'en-attente');
    assert.equal(l.file_id, null, 'la colonne existe et vaut NULL sur l’historique');

    // Et elle est écrivable — c'est tout l'objet de la migration.
    db.prepare('UPDATE televersements SET file_id = ? WHERE id = ?').run('abc123', 't1');
    const apres = db.prepare('SELECT file_id FROM televersements WHERE id = ?').get('t1') as Record<
      string,
      unknown
    >;
    assert.equal(apres.file_id, 'abc123');
    db.close();
  });

  test('le journal et le bundle de migrations sont cohérents — sinon l’app ne démarre pas', () => {
    // `readMigrationFiles` lève « Missing migration: <tag> » si une entrée du
    // journal n'a pas sa clé `m00NN` dans le migrations.js généré. Le test
    // attrape l'oubli d'un `npm run db:generate`, qui ne se voit qu'au
    // lancement réel.
    const journal = JSON.parse(readFileSync(join(DOSSIER, 'meta', '_journal.json'), 'utf8')) as {
      entries: { idx: number; tag: string }[];
    };
    const bundle = readFileSync(join(DOSSIER, 'migrations.js'), 'utf8');
    const fichiers = readdirSync(DOSSIER).filter((f) => f.endsWith('.sql'));
    assert.equal(journal.entries.length, fichiers.length, 'un .sql par entrée de journal');
    for (const e of journal.entries) {
      const cle = `m${String(e.idx).padStart(4, '0')}`;
      assert.ok(bundle.includes(`${cle} from './${e.tag}.sql'`), `${cle} absent du bundle`);
      assert.ok(fichiers.includes(`${e.tag}.sql`), `${e.tag}.sql absent du dossier`);
    }
  });
});

describe('rôles des abonnements (0015)', () => {
  test('ajoute la colonne et oublie le curseur des abonnements, pas les autres', () => {
    const db = baseMigreeAvant(15);
    const ins = 'INSERT INTO etat_synchro (portee, flux, mis_a_jour_depuis) VALUES (?, ?, ?)';
    db.prepare(ins).run('*', 'abonnements', 100);
    db.prepare(ins).run('*', 'salons', 100);
    db.prepare(ins).run('r1', 'messages', 100);

    appliquerMigration(db, 15);

    const curseurs = db
      .prepare('SELECT portee, flux FROM etat_synchro ORDER BY portee, flux')
      .all()
      .map((l) => ({ ...(l as Record<string, unknown>) }));
    assert.deepEqual(curseurs, [
      { portee: '*', flux: 'salons' },
      { portee: 'r1', flux: 'messages' },
    ]);
    db.prepare("INSERT INTO abonnements (rid, roles) VALUES ('r1', '[\"owner\"]')").run();
    db.close();
  });
});
