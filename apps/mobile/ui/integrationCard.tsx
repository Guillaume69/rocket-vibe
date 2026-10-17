import {useMemo,useRef,useState} from 'react';
import {ActivityIndicator,Pressable,StyleSheet,Text,View} from 'react-native';
import type {CardAction,IntegrationCard as Card} from '../lib/integrationCards.ts';
import {useCardAction} from './cardActions.ts';
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

function Buttons({c,actions,press}:{c:Colors;actions:CardAction[];press:(action:CardAction)=>Promise<void>}) {
  const [busy,setBusy]=useState<ReadonlySet<string>>(new Set());
  const flight=useRef(new Set<string>());
  const run=(action:CardAction)=>{
    if(flight.current.has(action.id))return;
    flight.current.add(action.id);
    setBusy(new Set(flight.current));
    void press(action).finally(()=>{flight.current.delete(action.id);setBusy(new Set(flight.current));});
  };
  return <View style={styles.buttons}>{actions.map(action=>{
    const pending=busy.has(action.id);
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
      {press!==null&&card.actions.length>0&&<Buttons c={c} actions={card.actions} press={press}/>}
    </Pressable>}
  </View>;
}
const styles=StyleSheet.create({wrap:{width:300,maxWidth:'100%',gap:4},card:{padding:12,gap:6,borderRadius:14,borderWidth:1,borderLeftWidth:3},
  author:{fontFamily:FONTS.bodySemi,fontSize:12},
  fields:{flexDirection:'row',flexWrap:'wrap',gap:8},field:{width:'100%',gap:2},short:{width:'47%',flexGrow:1},
  label:{fontFamily:FONTS.bodyBold,fontSize:12},
  buttons:{flexDirection:'row',flexWrap:'wrap',gap:6,marginTop:2},
  button:{flexDirection:'row',alignItems:'center',gap:6,paddingHorizontal:12,paddingVertical:6,borderRadius:8,borderWidth:1,overflow:'hidden'},
  buttonLabel:{fontFamily:FONTS.bodySemi,fontSize:13}});
