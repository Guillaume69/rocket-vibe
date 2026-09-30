import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const schemaPath = new URL('../docs/protocol/v1.schema.json', import.meta.url);
const outputPath = new URL('../apps/mobile/fournisseurs/rocketvibe/protocol.generated.ts', import.meta.url);
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const definitions = schema.$defs;

function typeOf(node) {
  if (node.$ref) return node.$ref.split('/').at(-1);
  if ('const' in node) return JSON.stringify(node.const);
  if (node.enum) return node.enum.map(v => JSON.stringify(v)).join(' | ');
  if (node.anyOf || node.oneOf) return (node.anyOf ?? node.oneOf).map(typeOf).join(' | ');
  if (node.type === 'string') return 'string';
  if (node.type === 'integer' || node.type === 'number') return 'number';
  if (node.type === 'boolean') return 'boolean';
  if (node.type === 'null') return 'null';
  if (node.type === 'array') return `(${typeOf(node.items)})[]`;
  if (node.type === 'object') {
    const required = new Set(node.required ?? []);
    return `{ ${Object.entries(node.properties ?? {}).map(([name, property]) => `${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${typeOf(property)};`).join(' ')} }`;
  }
  throw new Error(`Unsupported protocol schema: ${JSON.stringify(node)}`);
}

const generated = `// Generated from crates/rv-protocol. Run scripts/generate-native-protocol.mjs.\n` +
  Object.entries(definitions).map(([name, node]) => `export type ${name} = ${typeOf(node)};\n`).join('') +
  `\nexport type NativeTypes = { ${Object.keys(definitions).map(name => `${name}: ${name};`).join(' ')} };\n` +
  `\nexport const nativeSchema = ${JSON.stringify(schema, null, 2)} as const;\n`;

if (process.argv.includes('--check')) {
  if (readFileSync(outputPath, 'utf8') !== generated) throw new Error('Native TypeScript protocol is stale. Regenerate it.');
} else {
  writeFileSync(outputPath, generated);
  console.log(`Generated ${fileURLToPath(outputPath)}`);
}
