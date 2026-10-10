"""Collect notices of the resolved runtime WASM crates inside the build image."""
import json
from pathlib import Path

metadata = json.loads(Path('.cache/web-crypto-metadata.json').read_text())
packages = {p['id']: p for p in metadata['packages']}
nodes = {n['id']: n for n in metadata['resolve']['nodes']}
seen = set()


def visit(package):
    if package in seen:
        return
    seen.add(package)
    for dependency in nodes[package]['deps']:
        if any(kind['kind'] is None for kind in dependency['dep_kinds']):
            visit(dependency['pkg'])


visit(metadata['resolve']['root'])
entries = []
for package in sorted(seen, key=lambda value: (packages[value]['name'],
                                               packages[value]['version'], value)):
    value = packages[package]
    if value['source'] is None:
        continue
    folder = Path(value['manifest_path']).parent
    texts = [path.read_text(errors='replace') for path in sorted(folder.iterdir())
             if path.is_file() and path.name.upper().startswith(
                 ('LICENSE', 'LICENCE', 'COPYING', 'NOTICE'))]
    entries.append(value['name'] + ' ' + value['version'] + ' (' +
                   (value['license'] or 'see source') + ')\nhttps://crates.io/crates/' +
                   value['name'] + '/' + value['version'] + '\n\n' + '\n\n'.join(texts))
Path('apps/web/src/crypto/wasm/LICENSES.txt').write_text('\n\n'.join(entries) + '\n')
print('Recorded', len(entries), 'runtime Rust crate notices')
