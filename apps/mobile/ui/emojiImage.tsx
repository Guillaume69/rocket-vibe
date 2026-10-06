import {Image,type ImageStyle,type StyleProp} from 'react-native';
import {useNativeAvatar} from './nativeAvatar.ts';
import {useSyncExternalStore} from 'react';
import {customEmojiCodes,onCustomEmojisChange} from '../lib/customEmojis.ts';

export function useCatalogueEmojis():readonly string[] {
  return useSyncExternalStore(onCustomEmojisChange,customEmojiCodes,customEmojiCodes);
}

/** The existing emoji image also accepts authenticated native image handles. */
export function ImageEmoji({uri,style,code}:{uri:string;style:StyleProp<ImageStyle>;code?:string}) {
  const local=useNativeAvatar(uri);
  return <Image source={local?{uri:local}:undefined} style={style} resizeMode="contain" accessibilityLabel={code?`:${code}:`:undefined}/>;
}
