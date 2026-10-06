import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { messageTree, textPreview } from './markdown.ts';
import { isQuoteAttachment, firstAttachmentImage } from './quote.ts';
import { attachmentToShare } from './attachment.ts';

const corpus = JSON.parse(readFileSync(new URL('../../../docs/protocol/rendering.fixture.json', import.meta.url), 'utf8')) as {
  markdown: {id:string; source:string; nodes:string[]; contains:string[]; hidden?:string[]}[];
  attachments: {id:string; items:Record<string,unknown>[]; image:string|null; files:number; quotes:number; share?:string}[];
};
function types(value: unknown, result = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach(v => types(v,result));
  else if (value && typeof value === 'object') {
    const node = value as Record<string,unknown>;
    if (typeof node.type === 'string') result.add(node.type);
    Object.values(node).forEach(v => types(v,result));
  }
  return result;
}
for (const item of corpus.markdown) test(`shared rendering corpus: ${item.id}`, () => {
  const tree = messageTree(null,item.source);
  for (const expected of item.nodes) assert.ok(types(tree).has(expected), `${item.id}: missing ${expected}`);
  const text = textPreview(item.source);
  for (const expected of item.contains) assert.ok(text.includes(expected), `${item.id}: missing ${expected} in ${text}`);
  assert.deepEqual(messageTree('corrupt-json',item.source),tree);
  for (const hidden of item.hidden ?? []) assert.ok(!textPreview(item.source).includes(hidden));
});
for (const item of corpus.attachments) test(`shared attachment corpus: ${item.id}`, () => {
  const json = JSON.stringify(item.items);
  assert.equal(firstAttachmentImage(json),item.image);
  assert.equal(item.items.filter(isQuoteAttachment).length,item.quotes);
  if (item.share) assert.equal(attachmentToShare(json)?.path,item.share);
  if (item.quotes) assert.equal(attachmentToShare(json),null,'quoted files are not attachments of this message');
});
