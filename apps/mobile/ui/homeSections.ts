/**
 * Le regroupement de la liste des salons (écran d'accueil) — la projection
 * PURE, extraite du composant pour être testable sous Node (`app/` n'a aucun
 * test).
 *
 * Les règles, toutes visibles à l'écran et aucune verrouillée jusqu'ici :
 *   - fusion salons/abonnements PAR RID, en JS — `useRequeteVive`
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

export type HomeEntry<S, A> = { room: S; subscription: A | null };

export type SectionKey = 'nonLus' | 'favoris' | 'salons' | 'messagesPrives';

export type SectionTitles = Record<SectionKey, string>;

export type HomeSection<E> = { key: SectionKey; title: string; data: E[] };

export function buildSections<
  S extends { rid: string; type: string },
  A extends { rid: string; unread: number; alert: boolean; open: boolean; favorite: boolean },
>(
  lignesSalons: S[] | undefined,
  lignesAbonnements: A[] | undefined,
  titres: SectionTitles,
): HomeSection<HomeEntry<S, A>>[] {
  const abonnementParRid = new Map((lignesAbonnements ?? []).map((a) => [a.rid, a]));
  const visibles: HomeEntry<S, A>[] = (lignesSalons ?? [])
    .filter((s) => abonnementParRid.get(s.rid)?.open !== false)
    .map((s) => ({ room: s, subscription: abonnementParRid.get(s.rid) ?? null }));

  const aUnMessage = (e: HomeEntry<S, A>): boolean =>
    (e.subscription?.unread ?? 0) > 0 || e.subscription?.alert === true;
  const nonLus = visibles.filter(aUnMessage);
  const favoris = visibles.filter((e) => !aUnMessage(e) && e.subscription?.favorite === true);
  const lus = visibles.filter((e) => !aUnMessage(e) && e.subscription?.favorite !== true);

  const sections: HomeSection<HomeEntry<S, A>>[] = [
    { key: 'nonLus', title: titres.nonLus, data: nonLus },
    { key: 'favoris', title: titres.favoris, data: favoris },
    { key: 'salons', title: titres.salons, data: lus.filter((e) => e.room.type !== 'd') },
    {
      key: 'messagesPrives',
      title: titres.messagesPrives,
      data: lus.filter((e) => e.room.type === 'd'),
    },
  ];
  return sections.filter((s) => s.data.length > 0);
}

const CLES_SECTIONS: readonly SectionKey[] = ['nonLus', 'favoris', 'salons', 'messagesPrives'];

/**
 * Relit les sections repliées persistées. Tout ce qui n'est pas un tableau de
 * clés connues (absence, stockage corrompu, clé d'une version future) est
 * ignoré : au pire, une section se redéplie.
 */
export function readCollapsedSections(brut: string | null): ReadonlySet<SectionKey> {
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

export function writeCollapsedSections(repliees: ReadonlySet<SectionKey>): string {
  return JSON.stringify(CLES_SECTIONS.filter((cle) => repliees.has(cle)));
}

export function toggleSection(
  repliees: ReadonlySet<SectionKey>,
  cle: SectionKey,
): ReadonlySet<SectionKey> {
  const suivantes = new Set(repliees);
  if (suivantes.has(cle)) suivantes.delete(cle);
  else suivantes.add(cle);
  return suivantes;
}

export type DisplayedSection<E> = HomeSection<E> & { collapsed: boolean; total: number };

/**
 * Vide les sections repliées en gardant leur effectif. Une section SEULE n'a
 * pas d'en-tête à l'écran, donc aucun moyen de la redéplier : elle reste
 * dépliée quel que soit l'état persisté.
 */
export function collapseSections<E>(
  sections: HomeSection<E>[],
  repliees: ReadonlySet<SectionKey>,
): DisplayedSection<E>[] {
  const repliable = sections.length > 1;
  return sections.map((s) => {
    const repliee = repliable && repliees.has(s.key);
    return { ...s, data: repliee ? [] : s.data, collapsed: repliee, total: s.data.length };
  });
}
