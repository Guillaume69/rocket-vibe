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
import { useLiveQuery } from 'drizzle-orm/expo-sqlite';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';

import { salons, abonnements } from '../db/schema.ts';
import { useSynchro } from './synchro.tsx';

/** Salons chiffrés connus — consulté par le handler global au moment d'afficher. */
const ridsChiffres = new Set<string>();

function ridDeNotification(contenu: Notifications.NotificationContent): string | null {
  const brut = (contenu.data as { ejson?: unknown } | null)?.ejson;
  if (typeof brut !== 'string') return null;
  try {
    const ejson = JSON.parse(brut) as { rid?: unknown };
    return typeof ejson.rid === 'string' ? ejson.rid : null;
  } catch {
    return null;
  }
}

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const rid = ridDeNotification(notification.request.content);
    if (rid !== null && ridsChiffres.has(rid)) {
      // Ne pas afficher le ciphertext : on republie un texte générique.
      Notifications.scheduleNotificationAsync({
        content: { title: 'Message chiffré', body: 'Nouveau message dans un salon chiffré.' },
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
  useEffect(() => {
    const ouvrir = (reponse: Notifications.NotificationResponse) => {
      const rid = ridDeNotification(reponse.notification.request.content);
      if (rid !== null) routeur.push({ pathname: '/salon/[rid]', params: { rid } });
    };
    const abo = Notifications.addNotificationResponseReceivedListener(ouvrir);
    Notifications.getLastNotificationResponseAsync()
      .then((derniere) => {
        if (derniere !== null) ouvrir(derniere);
      })
      .catch(() => {});
    return () => abo.remove();
  }, [routeur]);

  if (synchro.phase !== 'pret') return null;
  return <SuiviBadgeEtChiffre />;
}

/** Vit seulement quand la base est prête : badge et registre du chiffré. */
function SuiviBadgeEtChiffre() {
  const synchro = useSynchro();
  const base = synchro.phase === 'pret' ? synchro.base : null;

  const { data: lignesAbonnements } = useLiveQuery(base!.select().from(abonnements));
  const { data: lignesSalons } = useLiveQuery(base!.select().from(salons));

  useEffect(() => {
    const total = (lignesAbonnements ?? []).reduce((somme, a) => somme + a.nonLus, 0);
    Notifications.setBadgeCountAsync(total).catch(() => {});
  }, [lignesAbonnements]);

  useEffect(() => {
    ridsChiffres.clear();
    for (const s of lignesSalons ?? []) {
      if (s.chiffre) ridsChiffres.add(s.rid);
    }
  }, [lignesSalons]);

  return null;
}
