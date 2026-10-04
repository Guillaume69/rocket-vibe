/**
 * Fiche d'un salon (canal ou groupe privé) — sheet native, ouverte par le tap
 * sur le nom dans l'en-tête du salon. Pour un DM, l'en-tête route directement
 * vers la fiche de l'interlocuteur (`/profile`) : la « fiche du salon » d'un
 * tête-à-tête, c'est l'autre personne.
 *
 * Le squelette (nom, type, chiffré/lecture seule) vient de la base locale —
 * affiché immédiatement, même hors ligne. Description, sujet, annonce et
 * nombre de membres viennent de `rooms.info` (non stockés localement : ils ne
 * servent qu'ici) et se posent à l'arrivée.
 */

import { eq } from 'drizzle-orm';
import { useRequeteVive } from '../ui/liveQuery.ts';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { BaseLocale } from '../db/client.ts';
import { abonnements, salons } from '../db/schema.ts';
import type { MoteurE2E } from '../lib/e2e/engine.ts';
import type { ClientRest } from '../lib/rest.ts';
import { useE2EDeverrouille } from '../ui/e2e.ts';
import { traduireCourant, useT } from '../ui/i18n.ts';
import { Appuyable } from '../ui/tappable.tsx';
import { AvatarSalon } from '../ui/kit.tsx';
import type { CleTraduction } from '../ui/messages.ts';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/sync.tsx';
import { POLICES, useCouleurs } from '../ui/theme.ts';
import { useMargeBasFeuille } from '../ui/sheetMargin.ts';

type Complement = {
  description: string | null;
  sujet: string | null;
  annonce: string | null;
  membres: number | null;
};

function chaine(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

const PHRASE_TYPE: Record<string, CleTraduction> = {
  c: 'salonInfo.typeCanalPublic',
  p: 'salonInfo.typeGroupePrive',
  d: 'salonInfo.typeMessageDirect',
};

export default function EcranSalonInfo() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { etat } = useSession();
  const synchro = useSynchro();
  const c = useCouleurs();

  // L'écran ne s'ouvre que depuis un salon affiché : session et synchro sont
  // forcément là. La garde (avant tout hook du contenu, qui déréférence la
  // base) couvre un démontage pendant une déconnexion.
  if (etat.phase !== 'connecte' || synchro.phase !== 'pret' || typeof rid !== 'string') {
    return null;
  }
  return (
    <ContenuSalonInfo rid={rid} base={synchro.base} client={etat.client} e2e={synchro.e2e} c={c} />
  );
}

function ContenuSalonInfo({
  rid,
  base,
  client,
  e2e,
  c,
}: {
  rid: string;
  base: BaseLocale;
  client: ClientRest;
  e2e: MoteurE2E;
  c: ReturnType<typeof useCouleurs>;
}) {
  const margeBas = useMargeBasFeuille();
  const t = useT();
  const deverrouille = useE2EDeverrouille(e2e);
  const { data: lignes } = useRequeteVive(
    base.select().from(salons).where(eq(salons.rid, rid)),
    [rid],
  );
  const salon = (lignes ?? [])[0];
  const { data: lignesAbonnement } = useRequeteVive(
    base.select().from(abonnements).where(eq(abonnements.rid, rid)),
    [rid],
  );
  const favori = (lignesAbonnement ?? [])[0]?.favori === true;
  const [basculeFavori, setBasculeFavori] = useState(false);
  const [erreurFavori, setErreurFavori] = useState(false);
  // Le serveur d'abord : la ligne locale ne change qu'une fois l'étoile posée,
  // le flux des abonnements confirmera de lui-même.
  const basculerFavori = (): void => {
    if (basculeFavori) return;
    setBasculeFavori(true);
    setErreurFavori(false);
    void client
      .post('rooms.favorite', { corps: { roomId: rid, favorite: !favori } })
      .then(() => base.update(abonnements).set({ favori: !favori }).where(eq(abonnements.rid, rid)))
      .catch(() => setErreurFavori(true))
      .finally(() => setBasculeFavori(false));
  };

  const [complement, setComplement] = useState<Complement | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    void client
      .get<{ room?: Record<string, unknown> }>('rooms.info', { params: { roomId: rid } })
      .then((r) => {
        if (!vivant) return;
        setComplement({
          description: chaine(r.room?.description),
          sujet: chaine(r.room?.topic),
          annonce: chaine(r.room?.announcement),
          membres: typeof r.room?.usersCount === 'number' ? r.room.usersCount : null,
        });
      })
      .catch((e: unknown) => {
        // La base locale a déjà rempli l'essentiel : l'échec ne coûte que les
        // sections complémentaires.
        if (vivant) setErreur(e instanceof Error ? e.message : traduireCourant('salonInfo.detailsIndisponibles'));
      });
    return () => {
      vivant = false;
    };
  }, [client, rid]);

  const nom = salon?.nomAffiche ?? salon?.nom ?? '?';
  const cleType = PHRASE_TYPE[salon?.type ?? ''];
  const sousTitre = [
    cleType !== undefined ? t(cleType) : null,
    complement?.membres !== null && complement !== null
      ? t('salonInfo.membres', { n: complement.membres })
      : null,
    salon?.chiffre === true ? t('salonInfo.chiffre') : null,
    salon?.lectureSeule === true ? t('salonInfo.lectureSeule') : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  return (
    <View style={[styles.feuille, { backgroundColor: c.carteProfonde, paddingBottom: margeBas }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.entete}>
        <AvatarSalon
          c={c}
          nom={nom}
          type={salon?.type}
          chiffre={salon?.chiffre ?? false}
          chiffreDeverrouille={deverrouille}
          rid={salon?.rid}
          dmAutreUid={salon?.dmAutreUid}
          avatarEtag={salon?.avatarEtag}
          client={client}
          taille={72}
          rayon={22}
        />
        <View style={styles.identite}>
          <Text style={[styles.nom, { color: c.texte }]} numberOfLines={2}>
            {salon?.chiffre === true && <Text style={styles.badgeChiffre}>🔒 </Text>}
            {salon?.type === 'c' ? '#' : ''}
            {nom}
          </Text>
          {sousTitre !== '' && (
            <Text style={[styles.sousTitre, { color: c.attenue }]}>{sousTitre}</Text>
          )}
        </View>
      </View>

      <Appuyable
        onPress={basculerFavori}
        disabled={basculeFavori}
        accessibilityRole="button"
        android_ripple={{ color: c.ondulation }}
        style={[styles.favori, { backgroundColor: c.carte }]}
      >
        <Text style={[styles.favoriTexte, { color: c.texte }]}>
          {favori ? '★ ' + t('salonInfo.retirerFavori') : '☆ ' + t('salonInfo.ajouterFavori')}
        </Text>
      </Appuyable>
      {erreurFavori && (
        <Text style={[styles.vide, { color: c.texteErreur }]}>{t('salonInfo.favoriEchec')}</Text>
      )}

      {complement?.annonce !== null && complement !== null && (
        <Section c={c} titre={t('salonInfo.annonce')} texte={complement.annonce} />
      )}
      {complement?.sujet !== null && complement !== null && (
        <Section c={c} titre={t('salonInfo.sujet')} texte={complement.sujet} />
      )}
      {complement?.description !== null && complement !== null && (
        <Section c={c} titre={t('salonInfo.description')} texte={complement.description} />
      )}
      {complement !== null &&
        complement.annonce === null &&
        complement.sujet === null &&
        complement.description === null && (
          <Text style={[styles.vide, { color: c.attenue }]}>
            {t('salonInfo.rienARenseigner')}
          </Text>
        )}
      {erreur !== null && <Text style={[styles.vide, { color: c.texteErreur }]}>{erreur}</Text>}
    </View>
  );
}

function Section({
  c,
  titre,
  texte,
}: {
  c: ReturnType<typeof useCouleurs>;
  titre: string;
  texte: string;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitre, { color: c.attenue }]}>{titre}</Text>
      <Text style={[styles.sectionTexte, { color: c.texte }]}>{texte}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // `minHeight` : la sheet `fitToContents` se mesure au PREMIER rendu, avant
  // l'arrivée de rooms.info — sans plancher, elle fige à la hauteur du seul
  // en-tête et le contenu qui pousse ensuite est rogné.
  feuille: { padding: 20, paddingBottom: 28, gap: 16, minHeight: 300 },
  entete: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  identite: { flex: 1, gap: 2 },
  nom: { fontFamily: POLICES.titre, fontSize: 20 },
  badgeChiffre: { fontSize: 14 },
  sousTitre: { fontFamily: POLICES.corps, fontSize: 13 },
  section: { gap: 3 },
  sectionTitre: { fontFamily: POLICES.corpsFort, fontSize: 12, textTransform: 'uppercase' },
  sectionTexte: { fontFamily: POLICES.corps, fontSize: 15 },
  vide: { fontFamily: POLICES.corps, fontSize: 13, fontStyle: 'italic' },
  favori: { borderRadius: 14, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  favoriTexte: { fontFamily: POLICES.corpsFort, fontSize: 15 },
});
