import {Image,type ImageStyle,type StyleProp} from 'react-native';
import {useAvatarNatif} from './avatarNatif.ts';
import {useSyncExternalStore} from 'react';
import {codesEmojiCustom,surChangementEmojisCustom} from '../lib/emojisCustom.ts';

export function useCatalogueEmojis():readonly string[] {
  return useSyncExternalStore(surChangementEmojisCustom,codesEmojiCustom,codesEmojiCustom);
}

/** The existing emoji image also accepts authenticated native image handles. */
export function ImageEmoji({uri,style,code}:{uri:string;style:StyleProp<ImageStyle>;code?:string}) {
  const local=useAvatarNatif(uri);
  return <Image source={local?{uri:local}:undefined} style={style} resizeMode="contain" accessibilityLabel={code?`:${code}:`:undefined}/>;
}
