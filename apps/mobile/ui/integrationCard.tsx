import {useMemo,useRef,useState} from 'react';
import {ActivityIndicator,Pressable,StyleSheet,Text,View} from 'react-native';
import {useRouter} from 'expo-router';
import {menuLabel,type CardAction,type IntegrationCard as Card} from '../lib/integrationCards.ts';
import {useCardAction} from './cardActions.ts';
import {requestCardMenu} from './cardMenuStore.ts';
import {Icon} from './icon.tsx';
import {messageTree,type Root} from '../lib/markdown.ts';
import {MessageBody,RenderGuard} from './markdown.tsx';
import {openExternalLink} from './externalLink.ts';
import {FONTS,type Colors} from './theme.ts';

function bold(tree:Root|null):Root|null {
  return tree&&(tree.map(b=>b.type==='PARAGRAPH'?{...b,value:[{type:'BOLD',value:b.value}]}:b) as Root);
}

function Markdown({c,tree,text}:{c:Colors;tree:Root|null;text:string|null}) {
  return tree&&<RenderGuard key={text} fallback={<Text style={{color:c.text}}>{text}</Text>}><MessageBody tree={tree} c={c}/></RenderGuard>;
}

function Buttons({c,rid,actions,press}:{c:Colors;rid:string;actions:CardAction[];press:(action:CardAction,selected?:string)=>Promise<boolean>}) {
  const router=useRouter();
  const [busy,setBusy]=useState<ReadonlySet<string>>(new Set());
  const [chosen,setChosen]=useState<ReadonlyMap<string,string>>(new Map());
  const flight=useRef(new Set<string>());
  const run=(action:CardAction,selected?:{label:string;value:string})=>{
    if(flight.current.has(action.id))return;
    flight.current.add(action.id);
    setBusy(new Set(flight.current));
    const before=chosen.get(action.id);
    if(selected)setChosen(m=>new Map(m).set(action.id,selected.label));
    void press(action,selected?.value).then(ok=>{
      if(!ok&&selected)setChosen(m=>{const next=new Map(m);if(before===undefined)next.delete(action.id);else next.set(action.id,before);return next;});
    }).finally(()=>{flight.current.delete(action.id);setBusy(new Set(flight.current));});
  };
  const pick=(action:CardAction)=>{
    if(!action.menu||flight.current.has(action.id))return;
    const answer=requestCardMenu({rid,title:action.name,menu:action.menu});
    router.push('/card-menu');
    void answer.then(option=>{if(option)run(action,option);});
  };
  return <View style={styles.buttons}>{actions.map(action=>{
    const pending=busy.has(action.id);
    if(action.menu)return <Pressable key={action.id} onPress={()=>pick(action)} disabled={pending} accessibilityRole="combobox" accessibilityLabel={action.name}
      accessibilityValue={{text:menuLabel(action,chosen.get(action.id)??null)}} accessibilityState={{disabled:pending,busy:pending}}
      android_ripple={{color:c.ripple}} style={[styles.button,styles.menu,{borderColor:c.border,opacity:pending?0.5:1}]}>
      {pending&&<ActivityIndicator size="small" color={c.text}/>}
      <Text style={[styles.buttonLabel,styles.menuLabel,{color:chosen.has(action.id)||action.menu.initial!==null?c.text:c.dimmed}]} numberOfLines={1}>{menuLabel(action,chosen.get(action.id)??null)}</Text>
      <Icon name="pan-down" size={16} color={c.dimmed}/>
    </Pressable>;
    const color=action.style==='danger'?c.danger:['primary','good','success'].includes(action.style??'')?c.accent:c.text;
    return <Pressable key={action.id} onPress={()=>run(action)} disabled={pending} accessibilityRole="button" accessibilityState={{disabled:pending,busy:pending}}
      android_ripple={{color:c.ripple}} style={[styles.button,{borderColor:color===c.text?c.border:color,opacity:pending?0.5:1}]}>
      {pending&&<ActivityIndicator size="small" color={color}/>}
      <Text style={[styles.buttonLabel,{color}]} numberOfLines={1}>{action.name}</Text>
    </Pressable>;
  })}</View>;
}

export function IntegrationCard({c,card,onLongPress,rid,postId}:{c:Colors;card:Card;onLongPress?:(()=>void)|undefined;rid:string;postId:string|null|undefined}) {
  const press=useCardAction(rid,postId);
  const pretext=useMemo(()=>messageTree(null,card.pretext),[card.pretext]);
  const title=useMemo(()=>bold(messageTree(null,card.title)),[card.title]);
  const tree=useMemo(()=>messageTree(null,card.text),[card.text]);
  const valuesKey=JSON.stringify(card.fields.map(f=>f.value));
  const values=useMemo(()=>(JSON.parse(valuesKey) as string[]).map(v=>messageTree(null,v)),[valuesKey]);
  return <View style={styles.wrap}>
    <Markdown c={c} tree={pretext} text={card.pretext}/>
    {(card.author||card.title||card.text||card.fields.length>0||(press!==null&&card.actions.length>0))&&<Pressable onPress={card.url?()=>openExternalLink(card.url!):undefined} onLongPress={onLongPress}
      delayLongPress={350} accessibilityRole={card.url?'link':undefined}
      style={[styles.card,{backgroundColor:c.card,borderColor:c.border,borderLeftColor:card.color??c.accent}]}>
      {card.author&&<Text style={[styles.author,{color:c.dimmed}]}>{card.author}</Text>}
      <Markdown c={c} tree={title} text={card.title}/>
      <Markdown c={c} tree={tree} text={card.text}/>
      <View style={styles.fields}>{card.fields.map((field,i)=><View key={i} style={[styles.field,field.short&&styles.short]}>
        <Text style={[styles.label,{color:c.dimmed}]}>{field.title}</Text>
        <Markdown c={c} tree={values[i]??null} text={field.value}/>
      </View>)}</View>
      {press!==null&&card.actions.length>0&&<Buttons c={c} rid={rid} actions={card.actions} press={press}/>}
    </Pressable>}
  </View>;
}
const styles=StyleSheet.create({wrap:{width:300,maxWidth:'100%',gap:4},card:{padding:12,gap:6,borderRadius:14,borderWidth:1,borderLeftWidth:3},
  author:{fontFamily:FONTS.bodySemi,fontSize:12},
  fields:{flexDirection:'row',flexWrap:'wrap',gap:8},field:{width:'100%',gap:2},short:{width:'47%',flexGrow:1},
  label:{fontFamily:FONTS.bodyBold,fontSize:12},
  buttons:{flexDirection:'row',flexWrap:'wrap',gap:6,marginTop:2},
  button:{flexDirection:'row',alignItems:'center',gap:6,paddingHorizontal:12,paddingVertical:6,borderRadius:8,borderWidth:1,overflow:'hidden'},
  buttonLabel:{fontFamily:FONTS.bodySemi,fontSize:13},
  menu:{flexGrow:1,minWidth:140},menuLabel:{flex:1}});
