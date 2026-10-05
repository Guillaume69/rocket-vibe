// Reproducible J0 inventory. TypeScript's parser keeps comments and test fixtures out.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/mobile/package.json', import.meta.url));
const ts = require('typescript');
const scopes = ['apps/mobile/app', 'apps/mobile/lib', 'apps/mobile/ui', 'apps/mobile/providers/rocketchat', 'apps/mobile/plugins', 'apps/desktop/crates', 'apps/desktop/macos/Sources'];
// Generated/ignored bindings can exist locally and be absent in a clean checkout.
// Include new non-ignored source files too so regeneration works before staging.
const sourceFiles = new Set(execFileSync('git', ['-c', `safe.directory=${root}`, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...scopes], {cwd:root,encoding:'utf8'}).split('\0'));
const rows = [];
const scanned = [];
const atom = /^(?:(?:chat|rooms|subscriptions|users|permissions|channels|groups|im|e2e|emoji-custom|video-conference|push)\.[A-Za-z][\w.-]*(?:\/[^\s]*)?|settings\.public|spotlight|api\/info)$/;
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'supprimer', 'upload', 'download', 'fetch_protected']);
function add(file, source, at, kind, surface) {
  surface = surface.replace(/\$\{[^}]*\}/g, '{…}').replace(/\{[^}]*\}/g, '{…}');
  if (!surface || surface.length > 240) return;
  rows.push({ file, line: source.slice(0, at).split('\n').length, kind, surface });
}
function literals(file, source, at, value) {
  if (atom.test(value)) add(file, source, at, 'endpoint', value);
  if (/^stream-[\w-]+(?:\/.*)?$/.test(value)) add(file, source, at, 'stream', value);
  for (const m of value.matchAll(/\/api\/(?:v1\/)?[\w.-]+(?:\/(?:[\w.-]+|\{[^}]*\}|\$\{[^}]*\}))*|\/(?:avatar|file-upload|emoji-custom)\/[^\s"'`<>]*/g)) {
    // Embedded Kotlin templates are scanned too; report their actual source line.
    add(file, source, at + m.index, m[0].startsWith('/api/') ? 'url' : 'resource', m[0]);
  }
}
function walk(dir) {
  for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!['target', 'node_modules', 'tests', '__tests__'].includes(entry.name)) walk(file);
      continue;
    }
    if (!sourceFiles.has(file) || !/\.(?:tsx?|js|rs|swift)$/.test(file) || /\.(?:test|generated)\./.test(file)) continue;
    let source = readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n');
    if (file.endsWith('.rs')) source = source.split('#[cfg(test)]')[0];
    scanned.push(file);
    if (/\.(?:tsx?|js)$/.test(file)) {
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isStringLiteralLike(node)) literals(file, source, node.getStart(ast), node.text);
        if (ts.isTemplateExpression(node)) {
          const value = node.getText(ast).slice(1, -1);
          literals(file, source, node.getStart(ast), value);
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length) {
          const receiver = node.expression.expression.getText(ast);
          const method = node.expression.name.text;
          if (methods.has(method) && /(?:^|\.)(?:client|rest)$/.test(receiver)) {
            const arg = node.arguments[0];
            add(file, source, node.getStart(ast), `call:${method === 'supprimer' ? 'DELETE' : method.toUpperCase()}`, arg.getText(ast));
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
    } else {
      // Rust/Swift lexical scan: comments are consumed, strings retain their offsets.
      const lex = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|r(#+)?"[\s\S]*?"\1|"(?:\\[\s\S]|[^"\\])*"/g;
      for (const match of source.matchAll(lex)) {
        if (match[0].startsWith('/')) continue;
        const value = match[0].replace(/^r#*"|^"|"#*$|"$/g, '');
        literals(file, source, match.index, value);
      }
      for (const match of source.matchAll(/\b(?:self\.)?rest\s*\.\s*(get|post|put|patch|delete|upload|download|fetch_protected)\s*\(\s*([^\n]+)/g)) {
        add(file, source, match.index, `call:${match[1].toUpperCase()}`, match[2].split(', CallOptions')[0].trim());
      }
    }
  }
}
scopes.forEach(walk);
const unique = [...new Map(rows.map(r => [`${r.file}:${r.line}:${r.kind}:${r.surface}`, r])).values()]
  .sort((a, b) => a.file.localeCompare(b.file, 'en') || a.line - b.line || a.kind.localeCompare(b.kind, 'en') || a.surface.localeCompare(b.surface, 'en'));
const inventory = { format: 1, scopes, scanned: scanned.sort(), entries: unique };
const escape = s => s.replace(/\|/g, '\\|').replace(/`/g, '\\`');
const markdown = `# Rocket.Chat inventory (generated)

Command: \`node scripts/inventory-rocketchat.mjs\`. Check: add \`--check\`.

${scanned.length} production files scanned; ${unique.length} occurrences.
Calls with a dynamic first argument remain visible: their resolution is
recorded in [the parity contract](PARITY.md). The lines are source
markers at the time of generation. The JSON keeps the scope and all the files.

| Source | Kind | Surface / first argument |\n|---|---|---|\n` + unique.map(r => `| [${r.file}:${r.line}](../../${r.file}#L${r.line}) | ${r.kind} | ${escape(r.surface)} |\n`).join('');
for (const [name, value] of [['rocketchat-inventory.json', `${JSON.stringify(inventory, null, 2)}\n`], ['rocketchat-inventory.md', markdown]]) {
  const path = resolve(root, 'docs/protocol', name);
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== value) throw new Error(`Stale ${relative(root, path)}; regenerate the Rocket.Chat inventory.`);
  } else writeFileSync(path, value);
}
console.log(`Rocket.Chat inventory: ${scanned.length} files, ${unique.length} occurrences.`);
