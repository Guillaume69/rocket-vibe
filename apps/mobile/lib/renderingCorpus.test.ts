import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { arbreDuMessage, apercuTexte } from './markdown.ts';
import { estJointeCitation, premiereImageDesJointes } from './citation.ts';
import { jointeAPartager } from './fichierJoint.ts';

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
  const tree = arbreDuMessage(null,item.source);
  for (const expected of item.nodes) assert.ok(types(tree).has(expected), `${item.id}: missing ${expected}`);
  const text = apercuTexte(item.source);
  for (const expected of item.contains) assert.ok(text.includes(expected), `${item.id}: missing ${expected} in ${text}`);
  assert.deepEqual(arbreDuMessage('corrupt-json',item.source),tree);
  for (const hidden of item.hidden ?? []) assert.ok(!apercuTexte(item.source).includes(hidden));
});
for (const item of corpus.attachments) test(`shared attachment corpus: ${item.id}`, () => {
  const json = JSON.stringify(item.items);
  assert.equal(premiereImageDesJointes(json),item.image);
  assert.equal(item.items.filter(estJointeCitation).length,item.quotes);
  if (item.share) assert.equal(jointeAPartager(json)?.chemin,item.share);
  if (item.quotes) assert.equal(jointeAPartager(json),null,'quoted files are not attachments of this message');
});
