/**
 * Le regroupement de la liste des salons (écran d'accueil) — la projection
 * PURE, extraite du composant pour être testable sous Node (`app/` n'a aucun
 * test).
 *
 * Les règles, toutes visibles à l'écran et aucune verrouillée jusqu'ici :
 *   - fusion salons/abonnements PAR RID, en JS — le `useLiveQuery` de drizzle
 *     n'écoute que la table du FROM, une jointure SQL raterait les écritures
 *     qui ne touchent qu'`abonnements` ;
 *   - `ouvert === false` masque le salon ; PAS d'abonnement reçu → visible,
 *     plutôt que de faire clignoter la liste ;
 *   - « j'ai un message » = non-lus > 0 OU drapeau `alerte` (une mention peut
 *     le lever sans que le compteur bouge) : ces salons remontent en tête,
 *     TOUS TYPES CONFONDUS ; le reste se répartit Salons / Messages privés ;
 *   - une section vide est retirée ;
 *   - l'ordre d'entrée (récence décroissante, trié par la requête) est
 *     PRÉSERVÉ par chaque section — aucun re-tri ici.
 */

export type EntreeAccueil<S, A> = { salon: S; abonnement: A | null };

export type TitresSections = { nonLus: string; salons: string; messagesPrives: string };

export function construireSections<
  S extends { rid: string; type: string },
  A extends { rid: string; nonLus: number; alerte: boolean; ouvert: boolean },
>(
  lignesSalons: S[] | undefined,
  lignesAbonnements: A[] | undefined,
  titres: TitresSections,
): { titre: string; data: EntreeAccueil<S, A>[] }[] {
  const abonnementParRid = new Map((lignesAbonnements ?? []).map((a) => [a.rid, a]));
  const visibles: EntreeAccueil<S, A>[] = (lignesSalons ?? [])
    .filter((s) => abonnementParRid.get(s.rid)?.ouvert !== false)
    .map((s) => ({ salon: s, abonnement: abonnementParRid.get(s.rid) ?? null }));

  const aUnMessage = (e: EntreeAccueil<S, A>): boolean =>
    (e.abonnement?.nonLus ?? 0) > 0 || e.abonnement?.alerte === true;
  const nonLus = visibles.filter(aUnMessage);
  const lus = visibles.filter((e) => !aUnMessage(e));

  return [
    { titre: titres.nonLus, data: nonLus },
    { titre: titres.salons, data: lus.filter((e) => e.salon.type !== 'd') },
    { titre: titres.messagesPrives, data: lus.filter((e) => e.salon.type === 'd') },
  ].filter((s) => s.data.length > 0);
}
