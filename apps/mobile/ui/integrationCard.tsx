import {useMemo} from 'react';
import {Pressable,StyleSheet,Text,View} from 'react-native';
import type {IntegrationCard as Card} from '../lib/integrationCards.ts';
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

export function IntegrationCard({c,card,onLongPress}:{c:Colors;card:Card;onLongPress?:(()=>void)|undefined}) {
  const pretext=useMemo(()=>messageTree(null,card.pretext),[card.pretext]);
  const title=useMemo(()=>bold(messageTree(null,card.title)),[card.title]);
  const tree=useMemo(()=>messageTree(null,card.text),[card.text]);
  const valuesKey=JSON.stringify(card.fields.map(f=>f.value));
  const values=useMemo(()=>(JSON.parse(valuesKey) as string[]).map(v=>messageTree(null,v)),[valuesKey]);
  return <View style={styles.wrap}>
    <Markdown c={c} tree={pretext} text={card.pretext}/>
    {(card.author||card.title||card.text||card.fields.length>0)&&<Pressable onPress={card.url?()=>openExternalLink(card.url!):undefined} onLongPress={onLongPress}
      delayLongPress={350} accessibilityRole={card.url?'link':undefined}
      style={[styles.card,{backgroundColor:c.card,borderColor:c.border,borderLeftColor:card.color??c.accent}]}>
      {card.author&&<Text style={[styles.author,{color:c.dimmed}]}>{card.author}</Text>}
      <Markdown c={c} tree={title} text={card.title}/>
      <Markdown c={c} tree={tree} text={card.text}/>
      <View style={styles.fields}>{card.fields.map((field,i)=><View key={i} style={[styles.field,field.short&&styles.short]}>
        <Text style={[styles.label,{color:c.dimmed}]}>{field.title}</Text>
        <Markdown c={c} tree={values[i]??null} text={field.value}/>
      </View>)}</View>
    </Pressable>}
  </View>;
}
const styles=StyleSheet.create({wrap:{width:300,maxWidth:'100%',gap:4},card:{padding:12,gap:6,borderRadius:14,borderWidth:1,borderLeftWidth:3},
  author:{fontFamily:FONTS.bodySemi,fontSize:12},
  fields:{flexDirection:'row',flexWrap:'wrap',gap:8},field:{width:'100%',gap:2},short:{width:'47%',flexGrow:1},
  label:{fontFamily:FONTS.bodyBold,fontSize:12}});
