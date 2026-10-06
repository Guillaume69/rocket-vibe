import {useMemo} from 'react';
import {Pressable,StyleSheet,Text,View} from 'react-native';
import type {IntegrationCard as Card} from '../lib/integrationCards.ts';
import {messageTree} from '../lib/markdown.ts';
import {MessageBody,RenderGuard} from './markdown.tsx';
import {openExternalLink} from './externalLink.ts';
import {FONTS,type Colors} from './theme.ts';

export function IntegrationCard({c,card,onLongPress}:{c:Colors;card:Card;onLongPress?:(()=>void)|undefined}) {
  const tree=useMemo(()=>messageTree(null,card.text),[card.text]);
  return <Pressable onPress={card.url?()=>openExternalLink(card.url!):undefined} onLongPress={onLongPress}
    delayLongPress={350} accessibilityRole={card.url?'link':undefined}
    style={[styles.card,{backgroundColor:c.card,borderColor:c.border,borderLeftColor:card.color??c.accent}]}>
    {card.author&&<Text style={[styles.author,{color:c.dimmed}]}>{card.author}</Text>}
    {card.title&&<Text style={[styles.title,{color:c.text}]}>{card.title}</Text>}
    {tree&&<RenderGuard key={card.text} fallback={<Text style={{color:c.text}}>{card.text}</Text>}><MessageBody tree={tree} c={c}/></RenderGuard>}
    <View style={styles.fields}>{card.fields.map((field,i)=><View key={i} style={[styles.field,field.short&&styles.short]}>
      <Text style={[styles.label,{color:c.dimmed}]}>{field.title}</Text>
      <Text style={[styles.value,{color:c.text}]}>{field.value}</Text>
    </View>)}</View>
  </Pressable>;
}
const styles=StyleSheet.create({card:{width:300,maxWidth:'100%',padding:12,gap:6,borderRadius:14,borderWidth:1,borderLeftWidth:3},
  author:{fontFamily:FONTS.bodySemi,fontSize:12},title:{fontFamily:FONTS.bodyBold,fontSize:14},
  fields:{flexDirection:'row',flexWrap:'wrap',gap:8},field:{width:'100%',gap:2},short:{width:'47%',flexGrow:1},
  label:{fontFamily:FONTS.bodySemi,fontSize:11},value:{fontSize:13}});
