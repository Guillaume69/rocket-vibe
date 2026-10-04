/**
 * Quels écrans salon sont montés, et lequel l'utilisateur regarde.
 *
 * `chat.syncMessages` traite UN salon à la fois et le REST est rate-limité :
 * le rattrapage ne vise donc que le salon affiché. Encore faut-il savoir
 * lequel c'est.
 *
 * Une variable unique (`salonActif = rid` au montage, `null` au démontage) ne
 * suffit pas : la pile de navigation peut contenir DEUX écrans salon —
 * `ui/notifications.tsx` fait un `push` depuis n'importe où, `app/profile.tsx`
 * un `replace`. Au retour arrière, le cleanup de celui du dessus posait `null`
 * alors qu'un salon restait affiché, et `rattraperTout` sortait sans rattraper
 * quoi que ce soit. Le défaut était masqué par le rattrapage REDONDANT que
 * l'écran lançait de son côté ; l'avoir supprimé (`lib/catchUp.ts` sérialise
 * désormais) transformerait cette dette en perte réelle.
 *
 * Des OBJETS, pas des chaînes : deux écrans peuvent porter le même rid (lien
 * profond sur un salon déjà ouvert), et c'est la déclaration EXACTE qu'il faut
 * retirer, pas la première occurrence venue.
 *
 * Une pile PAR SESSION — d'où la fabrique : elle vit dans la closure de
 * `ui/sync.tsx`, pas au niveau du module. Un écran survivant à une fin de
 * session ne doit pas déclarer un salon à la session suivante.
 */

export type OpenRoomsStack = {
  /** À l'ouverture d'un écran salon. Rend de quoi le retirer en partant. */
  declare: (rid: string) => () => void;
  /** Le salon du dessus — celui que l'utilisateur regarde. */
  top: () => string | undefined;
};

export function createOpenRoomsStack(): OpenRoomsStack {
  const pile: { rid: string }[] = [];
  return {
    declare: (rid) => {
      const declaration = { rid };
      pile.push(declaration);
      return () => {
        const i = pile.indexOf(declaration);
        if (i !== -1) pile.splice(i, 1);
      };
    },
    top: () => pile[pile.length - 1]?.rid,
  };
}
