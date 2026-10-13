import type {EmojiCatalog} from './protocol.generated.ts';
import {decodeNative} from './validation.ts';
import {canonicalEmoji} from './emojis.ts';

export const EMPTY_EMOJIS:EmojiCatalog={revision:'0',items:[]};
export function emojiShortcode(input:string):string|null {
  const code=input.startsWith(':')&&input.endsWith(':')?input.slice(1,-1):input;
  return /^[a-z0-9_+-]{1,80}$/.test(code)?code:null;
}
export function emojiRevision(value:string):bigint {
  if(!/^(0|[1-9]\d{0,18})$/.test(value)||BigInt(value)>9223372036854775807n)throw new Error('invalid_emoji_catalog');
  return BigInt(value);
}
/** A validated catalogue supplies names and immutable descriptors, never a URL. */
export function emojiCatalog(value:unknown):EmojiCatalog {
  const catalog=decodeNative('EmojiCatalog',value),revision=emojiRevision(catalog.revision);
  if(catalog.items.length>512)throw new Error('invalid_emoji_catalog');
  const ids=new Set<string>(),codes=new Set<string>();
  for(const item of catalog.items){
    if(!/^[A-Za-z0-9_-]{1,128}$/.test(item.id)||ids.has(item.id)||
      !/^[0-9a-f]{64}$/.test(item.file_id)||!/^[0-9a-f]{64}$/.test(item.sha256)||
      !['image/png','image/gif'].includes(item.media_type)||
      !/^[1-9]\d{0,6}$/.test(item.bytes)||Number(item.bytes)>1024*1024||
      emojiRevision(item.revision)===0n||emojiRevision(item.revision)>revision||item.aliases.length>8)throw new Error('invalid_emoji_catalog');
    ids.add(item.id);
    for(const code of [item.name,...item.aliases]){
      if(emojiShortcode(code)!==code||canonicalEmoji(code)!==null||codes.has(code))throw new Error('invalid_emoji_catalog');
      codes.add(code);
    }
  }
  return catalog;
}
