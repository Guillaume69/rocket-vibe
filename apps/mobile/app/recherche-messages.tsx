import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { MessageLocal } from '../lib/normaliser.ts';
import type { Fournisseur } from '../lib/fournisseur.ts';
import type { ClientRest } from '../lib/rest.ts';
import { VueEvitantLeClavier } from '../ui/clavier.tsx';
import { useT } from '../ui/i18n.ts';
import { LigneMessage } from '../ui/ligneMessage.tsx';
import { useRechercheDebouncee } from '../ui/rechercheDebouncee.ts';
import { useSession } from '../ui/session.tsx';
import {useSynchro} from '../ui/synchro.tsx';
import { useCouleurs, type Couleurs, POLICES } from '../ui/theme.ts';

/**
 * Recherche dans un salon par son fournisseur. Les résultats sont temporaires,
 * rendus directement depuis la
 * réponse (normalisés par `versMessage`, comme tout document serveur),
 * jamais écrits en base — des messages isolés hors fenêtre n'ont rien à y
 * faire. Pas de saut vers le message dans l'historique : consigné, viendra
 * avec une vraie pagination arrière ciblée.
 */

/** Stable (module-level) : une valeur recréée à chaque rendu relancerait l'effet. */
const AUCUN_MESSAGE: MessageLocal[] = [];
const AUCUN_RESULTAT:{version:string|null;revision:number;messages:MessageLocal[]}={version:null,revision:-1,messages:AUCUN_MESSAGE};
function versionDe(f:Fournisseur):string {return JSON.stringify([f.identite,f.native?.chat.searchVersion??null]);}

export default function EcranRechercheMessages() {
  const { rid } = useLocalSearchParams<{ rid: string }>();
  const { etat } = useSession();
  const synchro=useSynchro();
  const c = useCouleurs();
  const t = useT();

  // Même portier que le salon : un lien profond peut atterrir ici sans session.
  if (etat.phase === 'deconnecte') return <Redirect href="/connexion" />;
  if(synchro.phase==='erreur')return <View style={[styles.centre,{backgroundColor:c.fond}]}><Text style={[styles.messageErreur,{color:c.texteErreur}]}>{synchro.message}</Text></View>;

  if (etat.phase !== 'connecte' || synchro.phase!=='pret' || typeof rid !== 'string') {
    return (
      <View style={[styles.centre, { backgroundColor: c.fond }]}>
        <Stack.Screen options={{ title: t('commun.rechercher') }} />
        <ActivityIndicator />
      </View>
    );
  }
  return <RechercheMessages c={c} client={etat.client} rid={rid} fournisseur={synchro.fournisseur} />;
}

function RechercheMessages({
  c,
  client,
  rid,
  fournisseur,
}: {
  c: Couleurs;
  client: ClientRest;
  rid: string;
  fournisseur:Fournisseur;
}) {
  const t = useT();
  const [requete, setRequete] = useState('');
  const [revisionRequete,setRevisionRequete]=useState(0);
  const version=useSyncExternalStore(
    useCallback(ecouter=>fournisseur.native?.chat.subscribe(ecouter)??(()=>{}),[fournisseur]),
    ()=>versionDe(fournisseur),
  );

  // Les résultats sont normalisés dès la réponse (`versMessage`, comme tout
  // document serveur) — jamais écrits en base, voir l'en-tête du fichier.
  const chercherMessages = useCallback(
    async(propre: string) => {
      const version=versionDe(fournisseur);
      if(!fournisseur.capacites.recherche || !fournisseur.rechercherMessages)throw new Error('unsupported_feature');
      return {version,revision:revisionRequete,messages:await fournisseur.rechercherMessages(rid,propre)};
    },
    [fournisseur, rid,revisionRequete],
  );
  const { resultats, message, repondue } = useRechercheDebouncee(
    requete,
    AUCUN_RESULTAT,
    chercherMessages,
    t('rechercheMessages.rechercheImpossible'),
  );
  const propre = requete.trim();
  const cherche = propre !== '' && message===null && (repondue !== propre || resultats.revision!==revisionRequete);
  const perimes=resultats.version!==null && resultats.version!==version && repondue===propre;

  return (
    <VueEvitantLeClavier>
      <Stack.Screen options={{ title: t('rechercheMessages.titre') }} />
      <View style={styles.entete}>
        <TextInput
          value={requete}
          onChangeText={setRequete}
          onSubmitEditing={()=>setRevisionRequete(v=>v+1)}
          returnKeyType="search"
          placeholder={t('rechercheMessages.placeholder')}
          placeholderTextColor={c.attenue}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          style={[styles.champ, { color: c.texte, borderColor: c.bordure }]}
        />
      </View>
      {message !== null && (
        <Text style={[styles.messageErreur, { color: c.texteErreur }]}>{message}</Text>
      )}
      <FlatList
        data={resultats.version===version && resultats.revision===revisionRequete && repondue===propre?resultats.messages:AUCUN_MESSAGE}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => (
          <View style={styles.resultat}>
            <LigneMessage
              c={c}
              // MessageLocal et la ligne SQLite partagent exactement ces
              // champs — c'est le même document serveur normalisé.
              message={item}
              client={client}
              statutEnvoi={null}
              surReessayer={null}
              surAbandonner={null}
              // Pas d'actions ici : la feuille lit la base par id, et un
              // résultat ancien n'y est pas forcément — fausse promesse.
              surAppuiLong={null}
              surOuvrirFil={null}
              // Même raison pour les réactions : lecture seule, rien de marqué.
              moi={null}
              surReagir={null}
              // Des résultats épars, pas un flux : chacun garde son en-tête.
              suite={false}
              heureRepetee={false}
            />
          </View>
        )}
        ListEmptyComponent={
          requete.trim() === '' ? null : cherche ? (
            <View style={styles.centre}>
              <ActivityIndicator />
            </View>
          ) : perimes ? (
            <Text style={[styles.vide,{color:c.attenue}]}>{t('rechercheMessages.modifiee')}</Text>
          ) : (
            <Text style={[styles.vide, { color: c.attenue }]}>{t('rechercheMessages.aucunMessage')}</Text>
          )
        }
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.contenu}
      />
    </VueEvitantLeClavier>
  );
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  entete: { padding: 16 },
  champ: {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: POLICES.corps,
    fontSize: 16,
  },
  contenu: { paddingHorizontal: 16 },
  resultat: { paddingVertical: 2 },
  vide: { textAlign: 'center', padding: 24, fontFamily: POLICES.corps, fontSize: 14 },
  messageErreur: {
    textAlign: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
    fontFamily: POLICES.corps,
    fontSize: 13,
  },
});
