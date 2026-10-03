import {useMemo} from 'react';
import {Pressable,StyleSheet,Text,View} from 'react-native';
import type {CarteIntegration as Carte} from '../lib/cartesIntegration.ts';
import {arbreDuMessage} from '../lib/markdown.ts';
import {CorpsMessage,GardeRendu} from './markdown.tsx';
import {ouvrirLienExterne} from './lienExterne.ts';
import {POLICES,type Couleurs} from './theme.ts';

export function CarteIntegration({c,carte,surAppuiLong}:{c:Couleurs;carte:Carte;surAppuiLong?:(()=>void)|undefined}) {
  const arbre=useMemo(()=>arbreDuMessage(null,carte.texte),[carte.texte]);
  return <Pressable onPress={carte.url?()=>ouvrirLienExterne(carte.url!):undefined} onLongPress={surAppuiLong}
    delayLongPress={350} accessibilityRole={carte.url?'link':undefined}
    style={[styles.carte,{backgroundColor:c.carte,borderColor:c.bordure,borderLeftColor:carte.couleur??c.accent}]}>
    {carte.auteur&&<Text style={[styles.auteur,{color:c.attenue}]}>{carte.auteur}</Text>}
    {carte.titre&&<Text style={[styles.titre,{color:c.texte}]}>{carte.titre}</Text>}
    {arbre&&<GardeRendu key={carte.texte} repli={<Text style={{color:c.texte}}>{carte.texte}</Text>}><CorpsMessage arbre={arbre} c={c}/></GardeRendu>}
    <View style={styles.champs}>{carte.champs.map((champ,i)=><View key={i} style={[styles.champ,champ.court&&styles.court]}>
      <Text style={[styles.etiquette,{color:c.attenue}]}>{champ.titre}</Text>
      <Text style={[styles.valeur,{color:c.texte}]}>{champ.valeur}</Text>
    </View>)}</View>
  </Pressable>;
}
const styles=StyleSheet.create({carte:{width:300,maxWidth:'100%',padding:12,gap:6,borderRadius:14,borderWidth:1,borderLeftWidth:3},
  auteur:{fontFamily:POLICES.corpsSemi,fontSize:12},titre:{fontFamily:POLICES.corpsGras,fontSize:14},
  champs:{flexDirection:'row',flexWrap:'wrap',gap:8},champ:{width:'100%',gap:2},court:{width:'47%',flexGrow:1},
  etiquette:{fontFamily:POLICES.corpsSemi,fontSize:11},valeur:{fontSize:13}});
