/**
 * Notifications (6.3) : deep link vers le salon, badge cohérent avec les
 * non-lus, et substitution du contenu d'un salon chiffré.
 *
 * Rocket.Chat met dans `data.ejson` un JSON qui porte `rid` : c'est notre
 * route. Le tap est écouté en marche ET relu au démarrage à froid
 * (`getLastNotificationResponseAsync`) — le chemin exact « app tuée, tap sur
 * la notification ».
 *
 * `Push_show_message = true` sur le serveur cible : une notification venant
 * d'un salon chiffré transporte du CIPHERTEXT. Quand c'est l'app qui affiche
 * (premier plan, fenêtres de reconnexion), on remplace par un texte
 * générique. App tuée, c'est le système qui affiche la charge telle quelle —
 * limite documentée, le vrai levier est côté serveur (`Push_show_message`).
 */

import * as Notifications from 'expo-notifications';
import { useRequeteVive } from './requeteVive.ts';
import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';

import { salons, abonnements } from '../db/schema.ts';
import { estSalonChiffre, poserSalonsChiffres } from './etatNotifications.ts';
import { identifiantNotifSalon } from '../lib/notificationId.ts';
import { traduireCourant } from './i18n.ts';
import {useSession} from './session.tsx';
import { useSynchro } from './synchro.tsx';

/** Le salon d'un push, et le serveur d'où il vient (multi-session). */
type CibleNotification = { rid: string; host: string | null };

function cibleDeNotification(contenu: Notifications.NotificationContent): CibleNotification | null {
  const brut = (contenu.data as { ejson?: unknown } | null)?.ejson;
  if (typeof brut !== 'string') return null;
  try {
    const ejson = JSON.parse(brut) as { rid?: unknown; host?: unknown };
    if (typeof ejson.rid !== 'string') return null;
    return { rid: ejson.rid, host: typeof ejson.host === 'string' ? ejson.host : null };
  } catch {
    return null;
  }
}

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const cible = cibleDeNotification(notification.request.content);
    if (cible !== null && estSalonChiffre(cible.rid)) {
      // Ne pas afficher le ciphertext : on republie un texte générique.
      Notifications.scheduleNotificationAsync({
        content: {
          title: traduireCourant('notifications.titreChiffre'),
          body: traduireCourant('notifications.corpsChiffre'),
        },
        trigger: null,
      }).catch(() => {});
      return {
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    return {
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    };
  },
});

export function GestionNotifications() {
  const routeur = useRouter();
  const synchro = useSynchro();

  // Tap sur une notification : en marche, et au démarrage à froid.
  //
  // Ce chemin ne dessert QUE les notifications postées par expo (pushes de
  // repli sans bloc `notification`, ou sans `rid` groupable). Les notifications
  // de message natives (`plugins/with-fcm-deeplink.js`) ouvrent le salon par
  // leur propre deep-link `rocketvibe://salon/<rid>`, routé par expo-router,
  // sans jamais passer par ici. Sous iOS, en revanche, TOUS les taps passent
  // ici : l'extension de notification range `rid` et `host` dans `ejson`.
  useEffect(() => {
    // Une même réponse peut arriver par LES DEUX voies (le listener ET
    // `getLastNotificationResponse` au démarrage) : on ne route qu'une fois.
    let dejaRoute: string | null = null;
    const ouvrir = (reponse: Notifications.NotificationResponse) => {
      // « Répondre » sous iOS est traité en natif (modules/reponse-notif), app
      // en arrière-plan : naviguer ici poserait le salon sous les yeux au
      // prochain retour dans l'app.
      if (reponse.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const id = reponse.notification.request.identifier;
      if (id === dejaRoute) return;
      dejaRoute = id;
      const cible = cibleDeNotification(reponse.notification.request.content);
      if (cible === null) return;
      // Le `host` voyage avec le rid, comme dans le deep-link natif : plusieurs
      // sessions coexistent et poussent toutes les deux. Sans lui, un rid d'un
      // autre serveur atterrissait sur un écran salon sans ligne pour ce rid,
      // donc sur un indicateur d'activité définitif.
      routeur.push({
        pathname: '/salon/[rid]',
        params: cible.host === null ? { rid: cible.rid } : { rid: cible.rid, host: cible.host },
      });
    };
    const abo = Notifications.addNotificationResponseReceivedListener(ouvrir);
    Notifications.getLastNotificationResponseAsync()
      .then((derniere) => {
        if (derniere === null) return;
        ouvrir(derniere);
        // IMPÉRATIF (doc expo-notifications) : une fois la route choisie,
        // EFFACER la réponse. Sinon elle persiste et, rejouée à un montage
        // ultérieur — ou par la file `pendingNotificationResponses` de
        // NotificationManager, jamais purgée côté natif — renaviguerait vers un
        // salon PÉRIMÉ : un « mauvais salon » au lancement suivant.
        Notifications.clearLastNotificationResponseAsync().catch(() => {});
      })
      .catch(() => {});
    return () => abo.remove();
  }, [routeur]);

  if (synchro.phase !== 'pret') return null;
  return <SuiviBadgeEtChiffre key={JSON.stringify(synchro.fournisseur.identite)} />;
}

/** Vit seulement quand la base est prête : badge, retrait des lus, chiffré. */
function SuiviBadgeEtChiffre() {
  const session=useSession().etat;
  const synchro = useSynchro();
  const base = synchro.phase === 'pret' ? synchro.base : null;

  const { data: lignesAbonnements } = useRequeteVive(base!.select().from(abonnements));
  const { data: lignesSalons } = useRequeteVive(base!.select().from(salons));

  useEffect(() => {
    const total = (lignesAbonnements ?? []).reduce((somme, a) => somme + a.nonLus, 0);
    Notifications.setBadgeCountAsync(total).catch(() => {});
  }, [lignesAbonnements]);

  // Salon lu ⇒ sa notification s'en va. `setAutoCancel(true)` ne la retire qu'au
  // TAP : lire #general depuis l'icône laissait ses trois messages dans la barre
  // d'état, et le suivant s'y ajoutait en quatrième ligne — les notifications de
  // la voie native étant groupées ET cumulatives. Le compteur de non-lus suit
  // déjà le serveur en temps réel, y compris quand c'est un AUTRE appareil qui
  // a lu : c'est la source la moins menteuse dont on dispose ici.
  //
  // Le `Set` mémorise ce qui a déjà été retiré, sinon chaque re-rendu rejouerait
  // l'appel pour tous les salons lus. Le premier passage n'est PAS sauté : à
  // l'ouverture de l'app, un salon déjà lu ailleurs peut très bien avoir sa
  // notification en attente dans la barre. Retirer une notification absente est
  // un `NotificationManagerCompat.cancel` sur un id inconnu — sans effet.
  const retirees = useRef(new Set<string>());
  const observedRooms=useRef(new Set<string>());
  useEffect(() => {
    if(lignesAbonnements===undefined)return;
    const aRetirer: string[] = [];
    const present=new Set(lignesAbonnements.map(a=>a.rid));
    if(session.phase==='connecte'&&session.session.genre==='rocketvibe')for(const rid of observedRooms.current)if(!present.has(rid))aRetirer.push(rid);
    observedRooms.current=present;
    for (const a of lignesAbonnements ?? []) {
      if (a.nonLus > 0) {
        retirees.current.delete(a.rid);
        continue;
      }
      if (retirees.current.has(a.rid)) continue;
      retirees.current.add(a.rid);
      aRetirer.push(a.rid);
    }
    if (aRetirer.length > 0) retirerNotifsSalons(aRetirer,session.phase==='connecte'?session.session:undefined);
  }, [lignesAbonnements,session]);

  useEffect(() => {
    poserSalonsChiffres((lignesSalons ?? []).filter((s) => s.chiffre).map((s) => s.rid));
  }, [lignesSalons]);

  return null;
}

/**
 * Android : l'id natif dérive du rid (`lib/notificationId.ts`). iOS : chaque
 * push est sa propre notification, groupée par `threadIdentifier` ; on retrouve
 * celles du salon par le `rid` que l'extension a rangé dans `ejson`.
 */
function retirerNotifsSalons(rids: string[],scope?:import('../lib/auth.ts').Session): void {
  if (Platform.OS !== 'ios') {
    for (const rid of rids) {
      Notifications.dismissNotificationAsync(identifiantNotifSalon(rid,scope)).catch(() => {});
    }
    return;
  }
  const cibles = new Set(rids);
  Notifications.getPresentedNotificationsAsync()
    .then((presentes) => {
      for (const n of presentes) {
        const cible = cibleDeNotification(n.request.content);
        if (cible !== null && cibles.has(cible.rid)) {
          Notifications.dismissNotificationAsync(n.request.identifier).catch(() => {});
        }
      }
    })
    .catch(() => {});
}
