import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { asc, eq } from 'drizzle-orm';
import { useRequeteVive } from '../../ui/requeteVive.ts';
import * as Haptics from 'expo-haptics';
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import type { BaseLocale } from '../../db/client.ts';
import { messages, salons, sortie } from '../../db/schema.ts';
import type { CandidatMention } from '../../lib/completionMention.ts';
import type { ClientDdp } from '../../lib/ddp.ts';
import type { MoteurEnvoi } from '../../lib/envoi.ts';
import type { ClientRest } from '../../lib/rest.ts';
import { MoteurSynchro, STREAM_MESSAGES, STREAM_NOTIFY_ROOM } from '../../lib/sync.ts';
import { useBrouillon } from '../../ui/brouillons.ts';
import { VueEvitantLeClavier } from '../../ui/clavier.tsx';
import { BandeauCompletionEmoji, useCompletionEmoji } from '../../ui/completionEmoji.tsx';
import { BandeauCompletionMention, useCandidatsMention } from '../../ui/completionMention.tsx';
import { useT } from '../../ui/i18n.ts';
import { hauteurPanneauEmoji, NavigateurEmoji } from '../../ui/navigateurEmoji.tsx';
import { LigneMessage, type LigneDeMessage } from '../../ui/ligneMessage.tsx';
import { useSession } from '../../ui/session.tsx';
import { useSynchro } from '../../ui/synchro.tsx';
import { useCouleurs, type Couleurs } from '../../ui/theme.ts';

/**
 * Écran d'un fil (8.3). `id` = `_id` du message racine (`tmid` de ses
 * réponses). Même architecture que le salon : SQLite projeté par requêtes
 * vives, le réseau (REST `chat.getThreadMessages` + stream) écrit dans SQLite.
 *
 * Un fil est court et fini — pas de pagination : `chat.getThreadMessages`
 * rapporte tout le fil en une passe (count=0 y est permis, ce n'est pas
 * l'historique du salon).
 */

export default function EcranFil() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { etat } = useSession();
  const synchro = useSynchro();
  const c = useCouleurs();

  if (etat.phase === 'deconnecte') return <Redirect href="/connexion" />;

  if (synchro.phase === 'erreur') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <Text style={[styles.erreur, { color: c.texteErreur }]}>{synchro.message}</Text>
      </View>
    );
  }
  if (typeof id !== 'string' || synchro.phase !== 'pret' || etat.phase !== 'connecte') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <Fil
      c={c}
      filId={id}
      base={synchro.base}
      moteur={synchro.moteur}
      envoi={synchro.envoi}
      ddp={synchro.ddp}
      client={etat.client}
      generation={synchro.generation}
    />
  );
}

function Fil({
  c,
  filId,
  base,
  moteur,
  envoi,
  ddp,
  client,
  generation,
}: {
  c: Couleurs;
  filId: string;
  base: BaseLocale;
  moteur: MoteurSynchro;
  envoi: MoteurEnvoi;
  ddp: ClientDdp;
  client: ClientRest;
  generation: number;
}) {
  const t = useT();
  // La racine du fil — elle porte le titre et le `rid`.
  const { data: lignesRacine } = useRequeteVive(
    base.select().from(messages).where(eq(messages.id, filId)).limit(1),
    [filId],
  );
  const racine = lignesRacine?.[0];

  const { data: lignesReponses } = useRequeteVive(
    base
      .select()
      .from(messages)
      .where(eq(messages.filId, filId))
      // Clé secondaire `id` (même raison que l'écran salon) : un ex æquo à la
      // milliseconde près est départagé de façon déterministe, pas par l'ordre
      // d'insertion. Ordre ASC ici pour rester cohérent avec le tri DESC du
      // salon — deux messages liés gardent la même relation dans les deux vues.
      .orderBy(asc(messages.horodatage), asc(messages.id)),
    [filId],
  );

  // `rid` : par la racine, ou À DÉFAUT par une réponse (lien direct à froid —
  // `chat.getThreadMessages` ne renvoie jamais la racine, mais chaque réponse
  // porte le rid). Sans ce repli, l'écran ne pourrait ni s'abonner au stream
  // ni répondre tant que la racine n'est pas arrivée.
  const rid = racine?.rid ?? (lignesReponses ?? [])[0]?.rid;

  // Les drapeaux du salon : mêmes interdits que le composer du salon —
  // promettre une réponse dans un salon chiffré ou en lecture seule, c'est
  // promettre un `error-not-allowed`.
  const { data: lignesSalon } = useRequeteVive(
    base
      .select()
      .from(salons)
      .where(eq(salons.rid, rid ?? ''))
      .limit(1),
    [rid],
  );
  const salon = lignesSalon?.[0];
  const { data: lignesSortie } = useRequeteVive(
    base.select().from(sortie).where(eq(sortie.filId, filId)),
    [filId],
  );
  const sortieParId = useMemo(
    () => new Map((lignesSortie ?? []).map((s) => [s.id, s])),
    [lignesSortie],
  );

  // Racine en tête, réponses en ordre chronologique — un fil se lit du haut.
  const donnees = useMemo<LigneDeMessage[]>(() => {
    const reponses = lignesReponses ?? [];
    return racine === undefined ? reponses : [racine, ...reponses];
  }, [racine, lignesReponses]);

  // Le fil complet, depuis le serveur : rejouable, mêmes upserts idempotents.
  // `generation` : un fil ouvert hors ligne se remplit au raccordement.
  //
  // Pagination DÉFENSIVE : `count: 0` (« tout ») dépend de
  // `API_Allow_Infinite_Count`, un réglage serveur — désactivé, il retombe
  // silencieusement sur 50 et tronquerait le fil sans indice. On pagine par
  // pages pleines, bornées à 20 (2 000 réponses), à l'abri du réglage.
  const [premierPassageFini, setPremierPassageFini] = useState(false);
  useEffect(() => {
    let annule = false;
    (async () => {
      // La racine d'abord : `chat.getThreadMessages` ne la renvoie JAMAIS
      // (elle n'a pas de tmid). Ouverte par lien direct à froid, elle
      // n'existerait nulle part sans cet appel.
      await client
        .get<{ message?: Record<string, unknown> }>('chat.getMessage', {
          params: { msgId: filId },
        })
        .then((r) => (r.message === undefined ? null : moteur.ingererMessages([r.message])))
        .catch(() => {});
      const PAGE_FIL = 100;
      for (let page = 0; page < 20 && !annule; page++) {
        const reponse = await client.get<{ messages?: Record<string, unknown>[] }>(
          'chat.getThreadMessages',
          { params: { tmid: filId, count: PAGE_FIL, offset: page * PAGE_FIL } },
        );
        const lot = reponse.messages ?? [];
        await moteur.ingererMessages(lot);
        if (lot.length < PAGE_FIL) break;
      }
    })()
      .catch(() => {
        // Hors ligne : le cache local suffit.
      })
      .finally(() => {
        if (!annule) setPremierPassageFini(true);
      });
    return () => {
      annule = true;
    };
  }, [client, moteur, filId, generation]);

  // Les réponses arrivent par le stream du SALON : on s'y abonne aussi d'ici,
  // pour que le fil vive même ouvert par un lien direct (souscription
  // refcountée — voir ddp.souscrire).
  useEffect(() => {
    if (rid === undefined) return;
    const relachers = [
      ddp.souscrire(STREAM_MESSAGES, rid),
      ddp.souscrire(STREAM_NOTIFY_ROOM, `${rid}/deleteMessage`),
    ];
    return () => {
      for (const relacher of relachers) relacher();
    };
  }, [ddp, rid]);

  const routeur = useRouter();
  const ouvrirActions = useCallback(
    (idMessage: string) => {
      // « Pop » à l'ouverture de la feuille — confirme que l'appui long a pris.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      routeur.push({ pathname: '/actions-message', params: { id: idMessage } });
    },
    [routeur],
  );
  const reessayer = useCallback(() => {
    envoi.traiter().catch(() => {});
  }, [envoi]);
  const abandonner = useCallback(
    (idMessage: string) => {
      envoi.abandonner(idMessage).catch(() => {});
    },
    [envoi],
  );

  const rendreLigne = useCallback(
    ({ item }: { item: LigneDeMessage }) => {
      const etatEnvoi = sortieParId.get(item.id);
      return (
        <LigneMessage
          c={c}
          message={item}
          client={client}
          statutEnvoi={etatEnvoi?.statut ?? null}
          surReessayer={etatEnvoi?.statut === 'echec' ? reessayer : null}
          surAbandonner={etatEnvoi?.statut === 'echec' ? abandonner : null}
          surAppuiLong={etatEnvoi === undefined ? ouvrirActions : null}
          // On EST dans le fil : pas d'indicateur « N réponses » sur la racine.
          surOuvrirFil={null}
        />
      );
    },
    [c, client, sortieParId, reessayer, abandonner, ouvrirActions],
  );

  const liste = useRef<FlashListRef<LigneDeMessage>>(null);
  const apresEnvoi = useCallback(() => {
    // La liste s'ouvre sur la RACINE : sans ce défilement, la réponse
    // optimiste naît sous le pli et l'envoi semble n'avoir rien fait.
    setTimeout(() => liste.current?.scrollToEnd({ animated: true }), 250);
  }, []);

  // Brouillon du fil (8.7), clé `rid:tmid` : isolé du brouillon du salon.
  // `null` tant que le rid n'est pas connu — le composer attend.
  const persistance = useBrouillon(base, rid === undefined ? null : `${rid}:${filId}`);

  // Candidats à la mention (@) : ceux du SALON, pas seulement du fil — on
  // mentionne souvent dans un fil quelqu'un qui a parlé dans le flux principal.
  // `rid` encore inconnu → requête sur '' : liste vide, le composer n'est de
  // toute façon pas monté.
  const candidatsMention = useCandidatsMention(base, rid ?? '');

  return (
    <VueEvitantLeClavier>
      <Stack.Screen options={{ title: t('fil.titre') }} />
      {donnees.length === 0 ? (
        <View style={styles.centre}>
          {premierPassageFini ? (
            <Text style={[styles.vide, { color: c.attenue }]}>{t('fil.introuvable')}</Text>
          ) : (
            <ActivityIndicator />
          )}
        </View>
      ) : (
        <FlashList
          ref={liste}
          data={donnees}
          keyExtractor={(m) => m.id}
          renderItem={rendreLigne}
          contentContainerStyle={styles.contenu}
          // Un fil se LIT depuis sa racine : ouverture en haut — l'idiome
          // INVERSÉ du salon (8.10) n'aurait pas de sens ici. On garde donc
          // le mVCP pour suivre les réponses entrantes près du bas, avec son
          // recalage JS pendant l'animation du clavier — liste courte, à
          // porter si le ressenti l'exige.
          maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 0.2 }}
        />
      )}
      {rid !== undefined && salon?.chiffre === true && (
        <View style={[styles.composer, { borderTopColor: c.bordure }]}>
          <Text style={[styles.noteComposer, { color: c.attenue }]}>{t('fil.chiffre')}</Text>
        </View>
      )}
      {rid !== undefined && salon?.chiffre !== true && salon?.lectureSeule === true && (
        <View style={[styles.composer, { borderTopColor: c.bordure }]}>
          <Text style={[styles.noteComposer, { color: c.attenue }]}>{t('fil.lectureSeule')}</Text>
        </View>
      )}
      {rid !== undefined &&
        salon !== undefined &&
        !salon.chiffre &&
        !salon.lectureSeule &&
        persistance.initial !== null && (
          <ComposerFil
            key={`${rid}:${filId}`}
            c={c}
            rid={rid}
            filId={filId}
            envoi={envoi}
            client={client}
            candidatsMention={candidatsMention}
            apresEnvoi={apresEnvoi}
            brouillonInitial={persistance.initial}
            sauverBrouillon={persistance.sauver}
            effacerBrouillon={persistance.effacer}
          />
        )}
    </VueEvitantLeClavier>
  );
}

function ComposerFil({
  c,
  rid,
  filId,
  envoi,
  client,
  candidatsMention,
  apresEnvoi,
  brouillonInitial,
  sauverBrouillon,
  effacerBrouillon,
}: {
  c: Couleurs;
  rid: string;
  filId: string;
  envoi: MoteurEnvoi;
  /** Avatars des suggestions de mention. */
  client: ClientRest;
  /** Auteurs récents du salon (`useCandidatsMention`), calculés par le parent. */
  candidatsMention: CandidatMention[];
  apresEnvoi: () => void;
  /** Brouillon restauré (8.7) — le parent attend sa lecture avant de monter. */
  brouillonInitial: string;
  sauverBrouillon: (texte: string) => void;
  effacerBrouillon: () => void;
}) {
  const t = useT();
  const [brouillon, setBrouillon] = useState(brouillonInitial);
  const { height: hauteurEcran } = useWindowDimensions();
  // Autocomplétion des emojis — mécanique partagée avec le composer du salon.
  const { curseur, selection, surSelection, choisirEmoji, insererAuCurseur, reinitialiser } =
    useCompletionEmoji(brouillon, setBrouillon, sauverBrouillon);

  // Navigateur d'emojis : mêmes gestes que le salon (bouton 😀 ↔ clavier).
  const champRef = useRef<TextInput>(null);
  const [panneauEmoji, setPanneauEmoji] = useState(false);
  const basculerEmoji = useCallback(() => {
    setPanneauEmoji((ouvert) => {
      if (ouvert) {
        champRef.current?.focus();
        return false;
      }
      Keyboard.dismiss();
      return true;
    });
  }, []);

  const changer = useCallback(
    (texte: string) => {
      setBrouillon(texte);
      sauverBrouillon(texte);
    },
    [sauverBrouillon],
  );

  const envoyer = useCallback(() => {
    const texte = brouillon.trim();
    if (texte === '') return;
    setBrouillon('');
    reinitialiser();
    effacerBrouillon();
    envoi.envoyer(rid, texte, filId).catch(() => {});
    apresEnvoi();
  }, [brouillon, envoi, rid, filId, effacerBrouillon, apresEnvoi, reinitialiser]);

  return (
    <View>
      {!panneauEmoji && (
        <BandeauCompletionEmoji
          texte={brouillon}
          curseur={curseur}
          c={c}
          surChoisir={choisirEmoji}
        />
      )}
      {/* Jetons `:` et `@` mutuellement exclusifs : un seul bandeau à la fois. */}
      {!panneauEmoji && (
        <BandeauCompletionMention
          texte={brouillon}
          curseur={curseur}
          candidats={candidatsMention}
          client={client}
          c={c}
          surChoisir={choisirEmoji}
        />
      )}
      <View style={[styles.composer, { borderTopColor: c.bordure }]}>
        <Pressable
          onPress={basculerEmoji}
          android_ripple={{ color: c.ondulation, borderless: true }}
          style={styles.boutonEmoji}
          accessibilityLabel={panneauEmoji ? t('fil.revenirClavier') : t('fil.choisirEmoji')}
        >
          <Text style={styles.emojiGlyphe}>{panneauEmoji ? '⌨️' : '😀'}</Text>
        </Pressable>
        <TextInput
          ref={champRef}
          value={brouillon}
          selection={selection}
          onChangeText={changer}
          onSelectionChange={surSelection}
          onFocus={() => setPanneauEmoji(false)}
          placeholder={t('fil.repondre')}
          placeholderTextColor={c.attenue}
          multiline
          style={[styles.champComposer, { color: c.texte, backgroundColor: c.carte }]}
        />
        {brouillon.trim() !== '' && (
          <Pressable
            onPress={envoyer}
            android_ripple={{ color: c.ondulation, borderless: true }}
            style={({ pressed }) => [styles.boutonEnvoyer, { opacity: pressed ? 0.4 : 1 }]}
          >
            <Text style={[styles.texteEnvoyer, { color: c.accent }]}>{t('commun.envoyer')}</Text>
          </Pressable>
        )}
      </View>
      {panneauEmoji && (
        <NavigateurEmoji
          c={c}
          hauteur={hauteurPanneauEmoji(hauteurEcran)}
          onChoisir={insererAuCurseur}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  contenu: { paddingHorizontal: 16, paddingVertical: 8 },
  vide: { textAlign: 'center', padding: 24, fontSize: 14 },
  erreur: { fontSize: 14, fontWeight: '600', textAlign: 'center' },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  champComposer: {
    flex: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 9,
    fontSize: 15,
    maxHeight: 120,
  },
  boutonEnvoyer: { paddingVertical: 10, paddingHorizontal: 4 },
  texteEnvoyer: { fontSize: 15, fontWeight: '700' },
  boutonEmoji: { paddingVertical: 8, paddingHorizontal: 2 },
  emojiGlyphe: { fontSize: 20 },
  noteComposer: { flex: 1, textAlign: 'center', fontSize: 13, paddingVertical: 8 },
});
