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
 *     TOUS TYPES CONFONDUS ; viennent ensuite les salons que j'ai mis en favori
 *     (l'étoile du serveur, `f`), puis le reste se répartit Salons / Messages
 *     privés ;
 *   - une section vide est retirée ;
 *   - l'ordre d'entrée (récence décroissante, trié par la requête) est
 *     PRÉSERVÉ par chaque section — aucun re-tri ici.
 */

export type EntreeAccueil<S, A> = { salon: S; abonnement: A | null };

export type CleSection = 'nonLus' | 'favoris' | 'salons' | 'messagesPrives';

export type TitresSections = Record<CleSection, string>;

export type SectionAccueil<E> = { cle: CleSection; titre: string; data: E[] };

export function construireSections<
  S extends { rid: string; type: string },
  A extends { rid: string; nonLus: number; alerte: boolean; ouvert: boolean; favori: boolean },
>(
  lignesSalons: S[] | undefined,
  lignesAbonnements: A[] | undefined,
  titres: TitresSections,
): SectionAccueil<EntreeAccueil<S, A>>[] {
  const abonnementParRid = new Map((lignesAbonnements ?? []).map((a) => [a.rid, a]));
  const visibles: EntreeAccueil<S, A>[] = (lignesSalons ?? [])
    .filter((s) => abonnementParRid.get(s.rid)?.ouvert !== false)
    .map((s) => ({ salon: s, abonnement: abonnementParRid.get(s.rid) ?? null }));

  const aUnMessage = (e: EntreeAccueil<S, A>): boolean =>
    (e.abonnement?.nonLus ?? 0) > 0 || e.abonnement?.alerte === true;
  const nonLus = visibles.filter(aUnMessage);
  const favoris = visibles.filter((e) => !aUnMessage(e) && e.abonnement?.favori === true);
  const lus = visibles.filter((e) => !aUnMessage(e) && e.abonnement?.favori !== true);

  const sections: SectionAccueil<EntreeAccueil<S, A>>[] = [
    { cle: 'nonLus', titre: titres.nonLus, data: nonLus },
    { cle: 'favoris', titre: titres.favoris, data: favoris },
    { cle: 'salons', titre: titres.salons, data: lus.filter((e) => e.salon.type !== 'd') },
    {
      cle: 'messagesPrives',
      titre: titres.messagesPrives,
      data: lus.filter((e) => e.salon.type === 'd'),
    },
  ];
  return sections.filter((s) => s.data.length > 0);
}

const CLES_SECTIONS: readonly CleSection[] = ['nonLus', 'favoris', 'salons', 'messagesPrives'];

/**
 * Relit les sections repliées persistées. Tout ce qui n'est pas un tableau de
 * clés connues (absence, stockage corrompu, clé d'une version future) est
 * ignoré : au pire, une section se redéplie.
 */
export function lireSectionsRepliees(brut: string | null): ReadonlySet<CleSection> {
  if (brut === null) return new Set();
  let valeur: unknown;
  try {
    valeur = JSON.parse(brut);
  } catch {
    return new Set();
  }
  if (!Array.isArray(valeur)) return new Set();
  const cles: unknown[] = valeur;
  return new Set(CLES_SECTIONS.filter((cle) => cles.includes(cle)));
}

export function ecrireSectionsRepliees(repliees: ReadonlySet<CleSection>): string {
  return JSON.stringify(CLES_SECTIONS.filter((cle) => repliees.has(cle)));
}

export function basculerSection(
  repliees: ReadonlySet<CleSection>,
  cle: CleSection,
): ReadonlySet<CleSection> {
  const suivantes = new Set(repliees);
  if (suivantes.has(cle)) suivantes.delete(cle);
  else suivantes.add(cle);
  return suivantes;
}

export type SectionAffichee<E> = SectionAccueil<E> & { repliee: boolean; total: number };

/**
 * Vide les sections repliées en gardant leur effectif. Une section SEULE n'a
 * pas d'en-tête à l'écran, donc aucun moyen de la redéplier : elle reste
 * dépliée quel que soit l'état persisté.
 */
export function replierSections<E>(
  sections: SectionAccueil<E>[],
  repliees: ReadonlySet<CleSection>,
): SectionAffichee<E>[] {
  const repliable = sections.length > 1;
  return sections.map((s) => {
    const repliee = repliable && repliees.has(s.cle);
    return { ...s, data: repliee ? [] : s.data, repliee, total: s.data.length };
  });
}
