/**
 * Fiche d'un salon (canal ou groupe privé) — sheet native, ouverte par le tap
 * sur le nom dans l'en-tête du salon. Pour un DM, l'en-tête route directement
 * vers la fiche de l'interlocuteur (`/profil`) : la « fiche du salon » d'un
 * tête-à-tête, c'est l'autre personne.
 *
 * Le squelette (nom, type, chiffré/lecture seule) vient de la base locale —
 * affiché immédiatement, même hors ligne. Description, sujet, annonce et
 * nombre de membres viennent du fournisseur actif (non stockés localement : ils ne
 * servent qu'ici) et se posent à l'arrivée.
 */

import { eq } from 'drizzle-orm';
import { useRequeteVive } from '../ui/requeteVive.ts';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import type { BaseLocale } from '../db/client.ts';
import { abonnements, salons } from '../db/schema.ts';
import type { MoteurE2E } from '../lib/e2e/moteur.ts';
import type { ClientRest } from '../lib/rest.ts';
import type { ActionsFournisseur, InformationsSalon } from '../lib/fournisseur.ts';
import { useE2EDeverrouille } from '../ui/e2e.ts';
import { traduireCourant, useT } from '../ui/i18n.ts';
import { Appuyable } from '../ui/appuyable.tsx';
import { AvatarSalon } from '../ui/kit.tsx';
import type { CleTraduction } from '../ui/messages.ts';
import { useSession } from '../ui/session.tsx';
import { useSynchro } from '../ui/synchro.tsx';
import { POLICES, useCouleurs } from '../ui/theme.ts';
import { useMargeBasFeuille } from '../ui/margeFeuille.ts';
import {CommandesSalon} from '../ui/gestionSalon.tsx';
import {BorneAdhesionSalon} from '../ui/adhesionSalon.tsx';
import {FavoriSalonNatif} from '../ui/favoriSalonNatif.tsx';
import {SectionGroupeChiffre} from '../ui/groupeChiffre.tsx';

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
  const contenu=(membership?:string|null)=>(
    <ContenuSalonInfo key={JSON.stringify(synchro.fournisseur.identite)+rid} membership={membership} rid={rid} base={synchro.base} client={etat.client} actions={synchro.actions} native={synchro.fournisseur.identite.genre==='rocketvibe'} favoris={synchro.capacites.favorisSalon!==false} e2e={synchro.e2e} c={c} />
  );
  return synchro.fournisseur.native?<BorneAdhesionSalon key={JSON.stringify(synchro.fournisseur.identite)+rid} base={synchro.base} rid={rid}>{contenu}</BorneAdhesionSalon>:contenu();
}

function ContenuSalonInfo({
  rid,
  base,
  client,
  actions,
  native,
  favoris,
  membership,
  e2e,
  c,
}: {
  rid: string;
  base: BaseLocale;
  client: ClientRest;
  actions: ActionsFournisseur;
  native: boolean;
  favoris: boolean;
  membership?:string|null;
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
  const salonPresent = salon !== undefined;
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
    void (actions.favoriSalon?.modifier(rid,!favori)??Promise.reject(new Error('Favorite unavailable')))
      .then(() => base.update(abonnements).set({ favori: !favori }).where(eq(abonnements.rid, rid)))
      .catch(() => setErreurFavori(true))
      .finally(() => setBasculeFavori(false));
  };

  const version = `${rid}:${salon?.misAJourLe ?? 0}`;
  const [details, setDetails] = useState<{version:string;value:InformationsSalon} | null>(null);
  const [incident, setIncident] = useState<{version:string;message:string} | null>(null);
  const [actualisation,setActualisation]=useState(0);
  const complement = details?.version === version ? details.value : null;
  const erreur = incident?.version === version ? incident.message : null;

  useEffect(() => {
    let vivant = true;
    if(native && !salonPresent)return;
    void actions
      .infosSalon(rid)
      .then((r) => {
        if (!vivant) return;
        setDetails({version,value:r});
      })
      .catch((e: unknown) => {
        // La base locale a déjà rempli l'essentiel : l'échec ne coûte que les
        // sections complémentaires.
        if (vivant) setIncident({version,message:e instanceof Error ? e.message : traduireCourant('salonInfo.detailsIndisponibles')});
      });
    return () => {
      vivant = false;
    };
  }, [actions, rid, native, salonPresent, version,actualisation]);

  const nom = complement?.nom || salon?.nomAffiche || salon?.nom || '?';
  const cleType = PHRASE_TYPE[complement?.type ?? salon?.type ?? ''];
  const sousTitre = [
    cleType !== undefined ? t(cleType) : null,
    complement?.membres !== null && complement !== null
      ? t('salonInfo.membres', { n: complement.membres })
      : null,
    salon?.chiffre === true ? t('salonInfo.chiffre') : null,
    (complement?.lectureSeule ?? salon?.lectureSeule) === true ? t('salonInfo.lectureSeule') : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  if(native && !salon)return null;
  return (
    <ScrollView style={{ backgroundColor: c.carteProfonde }} contentContainerStyle={[styles.feuille, { paddingBottom: margeBas }]}>
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

      {favoris && native && membership && actions.favoriSalon && <FavoriSalonNatif rid={rid} adhesion={membership} base={base} actions={actions.favoriSalon} c={c} bouton={(label,action,disabled)=><Appuyable onPress={action} disabled={disabled} accessibilityRole="button" android_ripple={{color:c.ondulation}} style={[styles.favori,{backgroundColor:c.carte}]}><Text style={[styles.favoriTexte,{color:c.texte}]}>{label}</Text></Appuyable>} />}
      {favoris && !native && <Appuyable
        onPress={basculerFavori}
        disabled={basculeFavori}
        accessibilityRole="button"
        android_ripple={{ color: c.ondulation }}
        style={[styles.favori, { backgroundColor: c.carte }]}
      >
        <Text style={[styles.favoriTexte, { color: c.texte }]}>
          {favori ? '★ ' + t('salonInfo.retirerFavori') : '☆ ' + t('salonInfo.ajouterFavori')}
        </Text>
      </Appuyable>}
      {erreurFavori && (
        <Text style={[styles.vide, { color: c.texteErreur }]}>{t('salonInfo.favoriEchec')}</Text>
      )}

      {complement?.gestion && actions.gestionSalon && <CommandesSalon rid={rid} base={base} details={complement.gestion} actions={actions.gestionSalon} c={c} rafraichir={()=>setActualisation(value=>value+1)} />}
      {native && membership && salon?.chiffre && <SectionGroupeChiffre c={c} room={rid} membership={membership}/>}

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
    </ScrollView>
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
