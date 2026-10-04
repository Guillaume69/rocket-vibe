/**
 * Chargement REST des messages — l'historique d'un salon et le fil complet.
 * C'est l'implémentation Rocket.Chat de `Fournisseur.chargerHistorique` et
 * `Fournisseur.chargerFil` : les noms d'endpoints et leurs quirks vivent ici,
 * plus dans `app/` (chantiers 14 puis 15).
 */

import { toEpoch } from '../../lib/normalize.ts';
import type { ClientRest } from '../../lib/rest.ts';
import type { SyncEngine } from '../../lib/sync.ts';

/**
 * Endpoint d'historique Rocket.Chat selon le type du salon — trois routes pour
 * la même chose, héritage de l'API. `l` (livechat) est hors périmètre.
 */
export function historyPath(type: string): string {
  if (type === 'c') return 'channels.history';
  if (type === 'p') return 'groups.history';
  return 'im.history';
}

/** Taille de page serveur — le même pas que la fenêtre SQLite de l'écran. */
const PAGE = 50;

export async function loadHistory(
  client: ClientRest,
  engine: SyncEngine,
  rid: string,
  type: string,
  latest?: string,
): Promise<{ oldest: number | null }> {
  const response = await client.get<{ messages?: Record<string, unknown>[] }>(
    historyPath(type),
    {
      // `inclusive` : deux messages peuvent partager la même milliseconde.
      // Sans lui, le jumeau du message-borne serait un trou permanent dans
      // l'historique. Les upserts idempotents absorbent le recouvrement.
      // `showThreadMessages: false` — EXPLICITE bien que ce soit le défaut
      // vérifié sur 8.5 : le filtre serveur (tmid absent OU tshow) doit
      // rester identique au filtre local du flux, sinon une page entière
      // de réponses masquées ferait boucler la pagination keyset sur
      // place (le `latest` vient de la liste FILTRÉE).
      params: { roomId: rid, count: PAGE, latest, inclusive: true, showThreadMessages: false },
    },
  );
  const lot = response.messages ?? [];
  const recent = await engine.ingestMessages(lot);
  // Le plus ancien `ts` de la page : c'est LUI qui dit à l'écran si la page a
  // vraiment reculé dans le passé (voir `chargerPlus` et `pageARecule`).
  let oldest: number | null = null;
  for (const raw of lot) {
    const ts = toEpoch((raw as { ts?: unknown }).ts);
    if (ts !== null && (oldest === null || ts < oldest)) oldest = ts;
  }
  // Le curseur de rattrapage du salon NAÎT ici — et RIEN DE PLUS. Sans lui,
  // `rattraperSalon` no-ope à vie (`depuis === null`) ; avec, il reprend la
  // pagination par curseur là où elle en est.
  //
  // Il ne se RÉ-ANCRE plus à chaque ouverture. Ce saut en avant n'existait
  // que pour garder minuscule la fenêtre d'un `chat.syncMessages?lastUpdate=`
  // non borné, au prix des éditions et suppressions de l'intervalle sauté.
  // Depuis que le rattrapage pagine par curseur et se plafonne lui-même
  // (`lib/catchUp.ts`), la fenêtre n'a plus besoin d'être petite : le
  // curseur peut redevenir honnête.
  if (recent !== null) {
    const existing = await engine.syncStore.readCursor(rid, 'messages');
    if (existing === null) {
      await engine.syncStore.writeCursor(rid, 'messages', recent);
    }
  }
  return { oldest };
}

/**
 * Pagination DÉFENSIVE du fil : `count: 0` (« tout ») dépend de
 * `API_Allow_Infinite_Count`, un réglage serveur — désactivé, il retombe
 * silencieusement sur 50 et tronquerait le fil sans indice. On pagine par
 * pages pleines, bornées à 20 (2 000 réponses), à l'abri du réglage.
 */
const THREAD_PAGE = 100;
const MAX_THREAD_PAGES = 20;

export async function loadThread(
  client: ClientRest,
  engine: SyncEngine,
  threadId: string,
  isDiscarded: () => boolean,
): Promise<void> {
  // La racine d'abord : `chat.getThreadMessages` ne la renvoie JAMAIS (elle n'a
  // pas de tmid). Ouverte par lien direct à froid, elle n'existerait nulle part
  // sans cet appel.
  await client
    .get<{ message?: Record<string, unknown> }>('chat.getMessage', {
      params: { msgId: threadId },
    })
    .then((r) => (r.message === undefined ? null : engine.ingestMessages([r.message])))
    .catch(() => {});
  for (let page = 0; page < MAX_THREAD_PAGES && !isDiscarded(); page++) {
    const response = await client.get<{ messages?: Record<string, unknown>[] }>(
      'chat.getThreadMessages',
      { params: { tmid: threadId, count: THREAD_PAGE, offset: page * THREAD_PAGE } },
    );
    const lot = response.messages ?? [];
    await engine.ingestMessages(lot);
    if (lot.length < THREAD_PAGE) break;
  }
}
