/** Native documents adapt to existing message widgets only at this boundary. */
import type {Document as NativeDocument,Node as NativeNode} from './protocol.generated.ts';
import {unicodeDeCodeCourt} from '../../lib/emojis.ts';

type LocalNode={type:string;value?:unknown;level?:number;number?:number;status?:boolean;shortCode?:string};
const plain=(text:string):LocalNode=>({type:'PLAIN_TEXT',value:text});
function words(nodes:LocalNode[]):string {
  const text=(value:unknown):string=>{
    if(typeof value==='string')return value;
    if(Array.isArray(value))return value.map(text).join('');
    return value!==null && typeof value==='object' && 'value' in value?text(value.value):'';
  };
  return text(nodes);
}
function inlines(nodes:NativeNode[]):LocalNode[] {
  const out:LocalNode[]=[];
  for(const node of nodes) {
    switch(node.kind) {
      case 'text':out.push(plain(node.text));break;
      case 'bold':case 'italic':case 'strike':out.push({type:node.kind==='bold'?'BOLD':node.kind==='italic'?'ITALIC':'STRIKE',value:inlines(node.children)});break;
      case 'inline_code':case 'code_block':out.push({type:'INLINE_CODE',value:plain(node.text)});break;
      case 'link': {
        let label=inlines(node.children);
        if(words(label).trim()==='')label=[plain(node.href)];
        out.push({type:'LINK',value:{src:plain(node.href),label}});break;
      }
      case 'mention':out.push(node.name==='here'?plain('@here'):{type:'MENTION_USER',value:plain(node.name)});break;
      case 'room_mention':out.push({type:'MENTION_CHANNEL',value:plain(node.name)});break;
      case 'emoji':out.push({type:'EMOJI',value:plain(node.shortcode),shortCode:node.shortcode});break;
      case 'break':out.push(plain('\n'));break;
      case 'rule':out.push(plain('---'));break;
      case 'paragraph':case 'heading':case 'list_item':if(out.length)out.push(plain('\n'));out.push(...inlines(node.children));break;
      case 'quote':out.push(plain('\n> '),...inlines(node.children));break;
      case 'list':node.children.forEach((item,i)=>{
        const marker=item.kind==='list_item' && item.checked!=null?(item.checked?'☑ ':'☐ '):node.start==null?'• ':`${node.start+i}. `;
        out.push(plain(`\n${marker}`),...inlines(item.kind==='list_item'?item.children:[item]));
      });break;
    }
  }
  return out;
}
const big=(nodes:NativeNode[]):boolean=>{
  const count=nodes.filter(n=>n.kind==='emoji').length;
  return count>=1 && count<=3 && nodes.every(n=>n.kind==='emoji'?unicodeDeCodeCourt(n.shortcode)!==null:n.kind==='text' && n.text.trim()==='');
};
export function nativeTree(document:NativeDocument):LocalNode[] {
  const blocks=(nodes:NativeNode[]):LocalNode[]=>nodes.flatMap(node=>{
    switch(node.kind) {
      case 'paragraph':return [{type:big(node.children)?'BIG_EMOJI':'PARAGRAPH',value:big(node.children)?inlines(node.children).filter(n=>n.type==='EMOJI'):inlines(node.children)}];
      case 'heading':return [{type:'HEADING',level:Math.max(1,Math.min(4,node.level)),value:inlines(node.children)}];
      case 'quote':return [{type:'QUOTE',value:blocks(node.children)}];
      case 'code_block':return [{type:'CODE',value:node.text.replace(/\n$/,'').split('\n').map(line=>({type:'CODE_LINE',value:plain(line)}))}];
      case 'list': {
        const out:LocalNode[]=[];let at=0;
        const checked=(n:NativeNode)=>n.kind==='list_item' && n.checked!=null;
        while(at<node.children.length) {
          const tasks=checked(node.children[at]);const items:LocalNode[]=[];
          while(at<node.children.length && checked(node.children[at])===tasks) {
            const item=node.children[at],local:LocalNode={type:'LIST_ITEM',value:inlines(item.kind==='list_item'?item.children:[item])};
            if(tasks)local.status=item.kind==='list_item' && item.checked===true;
            else if(node.start!=null)local.number=node.start+at;
            items.push(local);at++;
          }
          out.push({type:tasks?'TASKS':node.start==null?'UNORDERED_LIST':'ORDERED_LIST',value:items});
        }
        return out;
      }
      default:return [{type:'PARAGRAPH',value:inlines([node])}];
    }
  });
  return blocks(document.nodes);
}
export function nativeMarkdown(document:NativeDocument|null|undefined):string|null {
  return document?JSON.stringify(nativeTree(document)):null;
}
