/**
 * `useRequeteVive` — un `useLiveQuery` qui COALESCE les rafales d'écriture.
 *
 * Le `useLiveQuery` de drizzle-orm/expo-sqlite ré-exécute la requête ENTIÈRE à
 * CHAQUE événement d'`addDatabaseChangeListener`. Or `sqlite3_update_hook` (la
 * source de ces événements) fire une fois PAR LIGNE, au moment où chaque
 * `INSERT`/`UPDATE` s'exécute — pas au commit. Ingérer un lot de N messages
 * (historique, rattrapage d'un backlog…) émet donc N événements, chacun
 * re-rendant une grosse liste.
 *
 * Pire : un rafraîchissement À FRONT MONTANT (rendre dès le premier événement)
 * BLOQUE le thread JS pendant le rendu, ce qui retarde l'upsert SUIVANT de la
 * même transaction — le rendu étale la transaction, les événements s'espacent
 * du temps d'un rendu, et une fenêtre de regroupement courte ne les rattrape
 * plus. Mesuré sur le Pixel : une transaction de 50 upserts s'étirait sur ~8 s
 * (~50 rendus), et un gros rattrapage sur PLUSIEURS MINUTES — la barre de synchro
 * tournant « à l'infini ».
 *
 * D'où un debounce PUR (trailing) : on NE rend PAS pendant la rafale. Le thread
 * reste libre, la transaction s'enchaîne en quelques millisecondes, les
 * événements se serrent, et on rafraîchit UNE fois une fois le silence revenu.
 * Un plafond `ATTENTE_MAX_MS` évite qu'un flot d'écritures ininterrompu ne fige
 * l'affichage : on rafraîchit au moins à cette cadence. On filtre par table
 * (comme drizzle) pour ne pas relire sur le changement d'une autre table, et par
 * FICHIER de base pour ne pas relire sur l'écriture d'un autre compte — voir
 * `fichierDeLaRequete`.
 *
 * API identique à `useLiveQuery` (`{ data }`) : remplacement mécanique. On ne
 * gère que les requêtes SELECT (`base.select()…`), les seules utilisées ici ;
 * une requête relationnelle (`base.query.*`) tomberait dans le repli « écoute
 * toutes les tables » — correct, juste un peu moins ciblé.
 */

import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { addDatabaseChangeListener } from 'expo-sqlite';
import { useEffect, useState, type DependencyList } from 'react';

/** Silence à attendre après la dernière écriture avant de rafraîchir. */
const FENETRE_MS = 48;
/** …mais on rafraîchit au moins aussi souvent si les écritures ne cessent pas. */
const ATTENTE_MAX_MS = 400;

/** Dernier segment d'un chemin — `…/rv_chat.barrut.me_abc.db` → `rv_chat.barrut.me_abc.db`. */
function nomDeFichier(chemin: string): string {
  return chemin.slice(chemin.lastIndexOf('/') + 1);
}

/**
 * Le fichier de la base sur laquelle porte cette requête, ou `null` si on n'a
 * pas su le lire.
 *
 * `addDatabaseChangeListener` est GLOBAL à toutes les bases ouvertes, et
 * `db/client.ts` en garde une par couple (serveur, compte) pour la vie du
 * process : sans ce filtre, une écriture sur la base d'un compte visité plus tôt
 * relancerait les requêtes de l'écran courant.
 *
 * On lit `session.client` du builder drizzle (drizzle-orm/expo-sqlite range là
 * le `SQLiteDatabase`) : chemin interne, donc sondé défensivement. On compare le
 * NOM DE FICHIER et non le chemin entier, parce que les deux valeurs ne
 * viennent pas de la même source — `databasePath` est ce que JS a passé à
 * l'ouverture, `databaseFilePath` ce que le natif rapporte — et qu'une
 * normalisation différente ferait tout filtrer. Nos noms sont uniques par
 * (serveur, compte) (db/nomFichier.ts), le nom seul suffit donc à discriminer.
 *
 * Relevé sur l'AVD le 2026-07-28, une trace posée des deux côtés :
 *   attendu `rocket-vibe-10_0_2_2_3300-6a5615….db`
 *   reçu    `/data/data/com.rocketvibe.app/files/SQLite/rocket-vibe-10_0_2_2_3300-6a5615….db`
 *   `databaseName` = `main` — d'où le choix de `databaseFilePath`.
 */
function fichierDeLaRequete(requete: unknown): string | null {
  const chemin = (requete as { session?: { client?: { databasePath?: unknown } } }).session?.client
    ?.databasePath;
  return typeof chemin === 'string' && chemin !== '' ? nomDeFichier(chemin) : null;
}

export function useRequeteVive<L>(
  requete: PromiseLike<L[]>,
  deps: DependencyList = [],
): { data: L[]; loaded:boolean } {
  const [data, setData] = useState<L[]>([]);
  const [loaded,setLoaded]=useState(false);

  useEffect(() => {
    let annule = false;
    const relire = () => {
      requete.then(
        (lignes) => {
          if (!annule) {setData(lignes);setLoaded(true);}
        },
        () => {
          // Un échec de lecture (base fermée en plein démontage) ne doit pas
          // remonter : l'ancienne valeur reste affichée, la prochaine écriture
          // relira.
        },
      );
    };
    // Premier remplissage, comme `useLiveQuery`.
    relire();

    // La table écoutée est extraite de la requête SELECT (`.config.table`),
    // comme le fait drizzle en interne. Requête sans table identifiable → on
    // écoute tout (repli sûr).
    const table = (requete as { config?: { table?: unknown } }).config?.table;
    const nomTable = is(table, SQLiteTable) ? getTableConfig(table).name : null;
    const fichier = fichierDeLaRequete(requete);

    let minuterie: ReturnType<typeof setTimeout> | null = null;
    let debutRafale = 0;
    const rafraichir = () => {
      minuterie = null;
      debutRafale = 0;
      relire();
    };
    const sub = addDatabaseChangeListener(({ tableName, databaseFilePath }) => {
      if (nomTable !== null && tableName !== nomTable) return;
      // `databaseName` de l'événement ne discrimine RIEN : c'est le nom SQLite
      // interne du schéma attaché, donc `main` pour toutes nos bases. Le fichier
      // est le seul champ qui distingue deux comptes.
      if (fichier !== null && typeof databaseFilePath === 'string' && databaseFilePath !== '') {
        if (nomDeFichier(databaseFilePath) !== fichier) return;
      }
      const maintenant = Date.now();
      if (debutRafale === 0) debutRafale = maintenant;
      if (minuterie !== null) clearTimeout(minuterie);
      // Debounce : attendre le silence (`FENETRE_MS`) — SANS jamais rendre
      // pendant la rafale, pour ne pas la ralentir — mais sans dépasser
      // `ATTENTE_MAX_MS` depuis son début, pour ne pas figer l'affichage sous un
      // flot continu.
      const resteAvantPlafond = ATTENTE_MAX_MS - (maintenant - debutRafale);
      minuterie = setTimeout(rafraichir, Math.max(0, Math.min(FENETRE_MS, resteAvantPlafond)));
    });

    return () => {
      annule = true;
      if (minuterie !== null) clearTimeout(minuterie);
      sub.remove();
    };
    // `requete` change de référence à chaque rendu ; comme `useLiveQuery`, ce
    // sont les `deps` fournies qui déterminent quand relancer l'effet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data,loaded };
}
