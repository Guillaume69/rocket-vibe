/** Controls inside the existing information sheet; providers own commands and receipts. */
import {eq} from 'drizzle-orm';
import {useEffect,useRef,useState} from 'react';
import {Alert,StyleSheet,Switch,Text,TextInput,View} from 'react-native';
import type {BaseLocale} from '../db/client.ts';
import {nativeRoomOperations} from '../db/schema.ts';
import type {ChampsSalon,GestionSalon,IntentionSalon,PageMembresSalon,ReglagesSalon,RoleSalon} from '../lib/fournisseur.ts';
import {decrireErreurFournisseur} from '../lib/erreurFournisseur.ts';
import {Appuyable} from './appuyable.tsx';
import {useT} from './i18n.ts';
import {useRequeteVive} from './requeteVive.ts';
import {POLICES,type Couleurs} from './theme.ts';
import type {CleTraduction} from './messages.ts';

const errors:Record<string,CleTraduction>={last_room_owner:'gestionSalon.dernierProprietaire',revision_conflict:'gestionSalon.conflit',room_action_pending:'gestionSalon.attente',room_action_failed:'gestionSalon.refus',rate_limited:'gestionSalon.debit',offline:'gestionSalon.horsLigne',delivery_revalidate:'gestionSalon.actualiser',invalid_room_receipt:'gestionSalon.actualiser',unsupported_feature:'gestionSalon.indisponible'};
const roleKey:Record<RoleSalon,CleTraduction>={owner:'gestionSalon.proprietaire',moderator:'gestionSalon.moderateur',member:'gestionSalon.membre'};
function fields(details:ReglagesSalon):ChampsSalon{return {nom:details.nom,prive:details.prive,sujet:details.sujet,description:details.description,annonce:details.annonce,lectureSeule:details.lectureSeule};}

export function CommandesSalon({rid,base,details,actions,c,rafraichir}:{rid:string;base:BaseLocale;details:ReglagesSalon;actions:GestionSalon;c:Couleurs;rafraichir:()=>void}){
  const t=useT(),alive=useRef(true),locked=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<CleTraduction|null>(null);
  const [edit,setEdit]=useState<{revision:string;champs:ChampsSalon}|null>(null);
  const [page,setPage]=useState<PageMembresSalon|null>(null);
  const [saved,setSaved]=useState<{key:string;value:IntentionSalon|null}|null>(null);
  const {data:rows}=useRequeteVive(base.select({id:nativeRoomOperations.id,state:nativeRoomOperations.state,error:nativeRoomOperations.error}).from(nativeRoomOperations).where(eq(nativeRoomOperations.rid,rid)),[rid]);
  const stateKey=JSON.stringify(rows??[]),intent=saved?.key===stateKey?saved.value:null;
  const members=page?.revision===details.revision?page:null;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{let active=true;void actions.intention(rid).then(value=>{if(active)setSaved({key:stateKey,value});}).catch(()=>{if(active)setError('gestionSalon.echec');});return()=>{active=false;};},[actions,rid,stateKey]);
  const run=async(fn:()=>Promise<void>,refresh=true)=>{
    if(locked.current || !alive.current)return;
    locked.current=true;setBusy(true);setError(null);
    try{await fn();}
    catch(error){if(alive.current)setError(errors[decrireErreurFournisseur(error,true).code]??'gestionSalon.echec');}
    finally{locked.current=false;if(alive.current){setBusy(false);if(refresh)rafraichir();}}
  };
  const button=(title:string,action:()=>void,disabled=false)=> <Appuyable key={title} accessibilityRole="button" accessibilityState={{disabled:busy||disabled}} disabled={busy||disabled} onPress={action} style={[styles.button,{backgroundColor:c.carte,opacity:busy||disabled?0.5:1}]}><Text style={[styles.buttonText,{color:c.texte}]}>{title}</Text></Appuyable>;
  const change=<K extends keyof ChampsSalon>(key:K,value:ChampsSalon[K])=>setEdit(current=>current?{...current,champs:{...current.champs,[key]:value}}:null);
  const input=(key:'nom'|'sujet'|'description'|'annonce',label:string,multiline=false)=> <View key={key} style={styles.field}><Text style={{color:c.attenue}}>{label}</Text><TextInput accessibilityLabel={label} editable={!busy} value={edit?.champs[key]??''} onChangeText={value=>change(key,value)} multiline={multiline} style={[styles.input,{backgroundColor:c.carte,color:c.texte,minHeight:multiline?80:44}]} /></View>;
  const loadMembers=(next:boolean)=>void run(async()=>{
    const fresh=await actions.membres(rid,next?members?.suite??null:null,details.revision);
    if(alive.current)setPage(next && members?{...fresh,membres:[...members.membres,...fresh.membres]}:fresh);
  },false);
  return <View style={styles.root}>
    {error && <Text accessibilityRole="alert" style={{color:c.texteErreur}}>{t(error)}</Text>}
    {intent && <View style={[styles.saved,{backgroundColor:c.carteProfonde}]}>
      <Text style={{color:c.texte}}>{t(intent.echouee?'gestionSalon.refus':'gestionSalon.attente')}</Text>
      {intent.erreur && <Text style={{color:c.texteErreur}}>{t(errors[intent.erreur]??'gestionSalon.echec')}</Text>}
      {!intent.echouee?button(t('gestionSalon.reprendre'),()=>void run(()=>actions.reprendre(rid))):<>
        {intent.reglages && details.peutModifier && button(t('gestionSalon.revoir'),()=>void run(async()=>{
          if(await actions.effacer(rid,intent.cle) && alive.current)setEdit({revision:details.revision,champs:intent.reglages!});
        }))}
        {button(t('gestionSalon.effacer'),()=>void run(async()=>{await actions.effacer(rid,intent.cle);}))}
      </>}
    </View>}
    {edit?<View style={styles.fields}>
      <Text style={{color:c.attenue}}>{t('gestionSalon.revisionFormulaire')}</Text>
      {input('nom',t('native.roomName'))}{input('sujet',t('salonInfo.sujet'),true)}{input('description',t('salonInfo.description'),true)}{input('annonce',t('salonInfo.annonce'),true)}
      <View style={styles.toggle}><Text style={{color:c.texte}}>{t('native.private')}</Text><Switch accessibilityLabel={t('native.private')} disabled={busy} value={edit.champs.prive} onValueChange={value=>change('prive',value)} /></View>
      <View style={styles.toggle}><Text style={{color:c.texte}}>{t('salonInfo.lectureSeule')}</Text><Switch accessibilityLabel={t('salonInfo.lectureSeule')} disabled={busy} value={edit.champs.lectureSeule} onValueChange={value=>change('lectureSeule',value)} /></View>
      {button(t('commun.enregistrer'),()=>void run(async()=>{await actions.modifier(rid,edit.revision,edit.champs);if(alive.current)setEdit(null);}),!!intent||!details.peutModifier)}
      {button(t('commun.annuler'),()=>setEdit(null))}
    </View>:details.peutModifier && button(t('gestionSalon.modifier'),()=>setEdit({revision:details.revision,champs:fields(details)}),!!intent)}
    {button(t('gestionSalon.membres'),()=>loadMembers(false))}
    {members?.membres.map(member=><View key={member.id} style={[styles.member,{borderColor:c.bordureDouce}]}>
      <Text style={{color:c.texte}}>{member.nom||member.pseudo} · @{member.pseudo}</Text>
      <Text style={{color:c.attenue}}>{t(roleKey[member.role])}{member.desactive?' · '+t('gestionSalon.desactive'):''}</Text>
      {details.peutChangerRoles && <View style={styles.roles}>{(['member','moderator','owner'] as const).map(role=>button(t(roleKey[role]),()=>void run(()=>actions.changerRole(rid,members.revision,member.id,role)),member.desactive||member.role===role||!!intent))}</View>}
    </View>)}
    {members?.suite && button(t('gestionSalon.suite'),()=>loadMembers(true))}
    {details.peutQuitter && button(t('gestionSalon.quitter'),()=>Alert.alert(t('gestionSalon.quitter'),t('gestionSalon.confirmerDepart'),[{text:t('commun.annuler'),style:'cancel'},{text:t('gestionSalon.quitter'),style:'destructive',onPress:()=>void run(()=>actions.quitter(rid,details.revision))}]),!!intent)}
  </View>;
}
const styles=StyleSheet.create({root:{gap:12,marginTop:12},fields:{gap:10},field:{gap:6},input:{borderRadius:12,padding:12,fontFamily:POLICES.corps,fontSize:15,textAlignVertical:'top'},toggle:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12},button:{padding:12,borderRadius:12},buttonText:{fontFamily:POLICES.corps,fontSize:15},saved:{padding:12,borderRadius:12,gap:8},member:{gap:6,paddingVertical:10,borderBottomWidth:1},roles:{flexDirection:'row',flexWrap:'wrap',gap:6}});
