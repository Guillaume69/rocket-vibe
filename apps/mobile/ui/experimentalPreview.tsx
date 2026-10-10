import { useState } from 'react';
import { Pressable,Text,View } from 'react-native';
import { SlackPreview } from './slackPreview.tsx';
import { TeamsPreview } from './teamsPreview.tsx';
import { useT } from './i18n.ts';
import { useColors } from './theme.ts';
/** Switching providers unmounts the previous reader and discards its credentials. */
export function ExperimentalPreview({onHide}:{onHide:()=>void}){
  const [provider,setProvider]=useState<'slack'|'teams'>('slack');const t=useT(),c=useColors();
  return <View style={{gap:12}}><View style={{flexDirection:'row',gap:12}}>{(['slack','teams'] as const).map(p=><Pressable key={p} accessibilityRole="tab" accessibilityState={{selected:p===provider}} onPress={()=>setProvider(p)} style={{padding:12,borderRadius:12,backgroundColor:p===provider?c.card:'transparent'}}><Text style={{color:p===provider?c.accent:c.dimmed,fontWeight:'700'}}>{t(p==='slack'?'experimental.slack':'experimental.teams')}</Text></Pressable>)}</View>{provider==='slack'?<SlackPreview onHide={onHide}/>:<TeamsPreview onHide={onHide}/>}</View>;
}
