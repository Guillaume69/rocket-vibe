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
  roomRows: S[] | undefined,
  subscriptionRows: A[] | undefined,
  titles: SectionTitles,
): HomeSection<HomeEntry<S, A>>[] {
  const subscriptionByRid = new Map((subscriptionRows ?? []).map((a) => [a.rid, a]));
  const visible: HomeEntry<S, A>[] = (roomRows ?? [])
    .filter((s) => subscriptionByRid.get(s.rid)?.open !== false)
    .map((s) => ({ room: s, subscription: subscriptionByRid.get(s.rid) ?? null }));

  const hasMessage = (e: HomeEntry<S, A>): boolean =>
    (e.subscription?.unread ?? 0) > 0 || e.subscription?.alert === true;
  const unread = visible.filter(hasMessage);
  const favorites = visible.filter((e) => !hasMessage(e) && e.subscription?.favorite === true);
  const read = visible.filter((e) => !hasMessage(e) && e.subscription?.favorite !== true);

  const sections: HomeSection<HomeEntry<S, A>>[] = [
    { key: 'nonLus', title: titles.nonLus, data: unread },
    { key: 'favoris', title: titles.favoris, data: favorites },
    { key: 'salons', title: titles.salons, data: read.filter((e) => e.room.type !== 'd') },
    {
      key: 'messagesPrives',
      title: titles.messagesPrives,
      data: read.filter((e) => e.room.type === 'd'),
    },
  ];
  return sections.filter((s) => s.data.length > 0);
}

const SECTION_KEYS: readonly SectionKey[] = ['nonLus', 'favoris', 'salons', 'messagesPrives'];

/**
 * Relit les sections repliées persistées. Tout ce qui n'est pas un tableau de
 * clés connues (absence, stockage corrompu, clé d'une version future) est
 * ignoré : au pire, une section se redéplie.
 */
export function readCollapsedSections(raw: string | null): ReadonlySet<SectionKey> {
  if (raw === null) return new Set();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(value)) return new Set();
  const keys: unknown[] = value;
  return new Set(SECTION_KEYS.filter((key) => keys.includes(key)));
}

export function writeCollapsedSections(collapsedKeys: ReadonlySet<SectionKey>): string {
  return JSON.stringify(SECTION_KEYS.filter((key) => collapsedKeys.has(key)));
}

export function toggleSection(
  collapsedKeys: ReadonlySet<SectionKey>,
  key: SectionKey,
): ReadonlySet<SectionKey> {
  const following = new Set(collapsedKeys);
  if (following.has(key)) following.delete(key);
  else following.add(key);
  return following;
}

export type DisplayedSection<E> = HomeSection<E> & { collapsed: boolean; total: number };

/**
 * Vide les sections repliées en gardant leur effectif. Une section SEULE n'a
 * pas d'en-tête à l'écran, donc aucun moyen de la redéplier : elle reste
 * dépliée quel que soit l'état persisté.
 */
export function collapseSections<E>(
  sections: HomeSection<E>[],
  collapsedKeys: ReadonlySet<SectionKey>,
): DisplayedSection<E>[] {
  const collapsible = sections.length > 1;
  return sections.map((s) => {
    const collapsed = collapsible && collapsedKeys.has(s.key);
    return { ...s, data: collapsed ? [] : s.data, collapsed, total: s.data.length };
  });
}
