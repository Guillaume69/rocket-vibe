import {Image,Text,type ImageStyle,type StyleProp,type TextStyle} from 'react-native';
import {useAuthorizedUri} from './authorizedImage.ts';
import {useNativeAvatar} from './nativeAvatar.ts';
import {useSyncExternalStore} from 'react';
import {customEmojiCodes,customEmojiUrl,onCustomEmojisChange} from '../lib/customEmojis.ts';
import {unicodeOfShortcode} from '../lib/emojis.ts';

export function useCatalogueEmojis():readonly string[] {
  return useSyncExternalStore(onCustomEmojisChange,customEmojiCodes,customEmojiCodes);
}

/** The existing emoji image also accepts authenticated native image handles. */
export function ImageEmoji({uri,style,code}:{uri:string;style:StyleProp<ImageStyle>;code?:string}) {
  const local=useAuthorizedUri(useNativeAvatar(uri));
  return <Image source={local?{uri:local}:undefined} style={style} resizeMode="contain" accessibilityLabel={code?`:${code}:`:undefined}/>;
}

/** A reaction's emoji, in the message body's order: its glyph, the server's image, else `:code:`. */
export function ReactionEmoji({code,glyphStyle,imageStyle,codeStyle}:{code:string;glyphStyle:StyleProp<TextStyle>;imageStyle:StyleProp<ImageStyle>;codeStyle:StyleProp<TextStyle>}) {
  useCatalogueEmojis();
  const glyph=unicodeOfShortcode(code);
  const uri=glyph===null?customEmojiUrl(code):null;
  if(glyph!==null)return <Text style={glyphStyle}>{glyph}</Text>;
  if(uri!==null)return <ImageEmoji uri={uri} style={imageStyle} code={code}/>;
  return <Text style={codeStyle} numberOfLines={1}>:{code}:</Text>;
}
