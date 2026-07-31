/**
 * Endpoint d'historique Rocket.Chat selon le type du salon — trois routes pour
 * la même chose, héritage de l'API. `l` (livechat) est hors périmètre.
 *
 * Déplacé de l'écran salon (chantier 14) : le nom d'un endpoint RC n'a rien à
 * faire dans `app/`. Le routage complet par la façade `Fournisseur` viendra
 * avec le chantier 15.
 */
export function cheminHistorique(type: string): string {
  if (type === 'c') return 'channels.history';
  if (type === 'p') return 'groups.history';
  return 'im.history';
}
