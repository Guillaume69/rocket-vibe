// Builds the WhatsApp engine (apps/desktop/whatsapp, Go) as librv_whatsapp.so
// for each ABI with the NDK's clang: the same code as the desktop helper,
// exported to C by its mobile/ package and loaded by Kotlin through JNA.
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(moduleDirectory, '../../../..');
const engine = path.join(repository, 'apps/desktop/whatsapp');
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  if (!['--ndk', '--min-api', '--abis'].includes(name) || !process.argv[index + 1]) throw new Error('Invalid native build option');
  options.set(name, process.argv[index + 1]);
}
const ndk = options.get('--ndk') ?? process.env.ANDROID_NDK_HOME;
const api = Number(options.get('--min-api') ?? 24);
const abis = [...new Set((options.get('--abis') ?? 'arm64-v8a,x86_64').split(','))];
const targets = {'arm64-v8a': ['arm64', 'aarch64-linux-android'], 'x86_64': ['amd64', 'x86_64-linux-android']};
if (!ndk || !Number.isInteger(api) || api < 24 || abis.length === 0 || abis.some(abi => !targets[abi])) {
  throw new Error('Android NDK, minimum API >=24 and supported ABIs required');
}
const go = spawnSync('go', ['version'], {encoding: 'utf8'});
if (go.error || go.status !== 0) {
  throw new Error('Go is required to build the WhatsApp engine (https://go.dev/dl, the version apps/desktop/whatsapp/go.mod names)');
}
const hostTag = process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
const clang = path.join(ndk, 'toolchains/llvm/prebuilt', hostTag, 'bin', process.platform === 'win32' ? 'clang.exe' : 'clang');
const quoted = clang.includes(' ') ? `"${clang}"` : clang;
const generated = path.join(moduleDirectory, 'android/build/generated/jniLibs');

for (const abi of abis) {
  const [goarch, triple] = targets[abi];
  const out = mkdtempSync(path.join(tmpdir(), 'rv-whatsapp-'));
  const library = path.join(out, 'librv_whatsapp.so');
  // NDK r27 needs an explicit alignment for devices with 16 KiB pages; the
  // vault needs sqlite_unlock_notify (engine/tags.go refuses to start otherwise).
  const result = spawnSync('go', ['build', '-buildmode=c-shared', '-tags', 'sqlite_unlock_notify', '-trimpath', '-buildvcs=false',
    '-ldflags', '-s -w -extldflags=-Wl,-z,max-page-size=16384,-soname,librv_whatsapp.so', '-o', library, './mobile'], {
    cwd: engine, stdio: 'inherit',
    env: {...process.env, GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? 'auto', CGO_ENABLED: '1', GOOS: 'android', GOARCH: goarch,
      CC: `${quoted} --target=${triple}${api}`},
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`WhatsApp engine build failed for ${abi}`);
  const destination = path.join(generated, abi);
  mkdirSync(destination, {recursive: true});
  cpSync(library, path.join(destination, 'librv_whatsapp.so'));
  rmSync(out, {recursive: true, force: true});
}

// The licence notice the APK ships (assets/rv-whatsapp-licenses.txt, shown
// from Settings > App): every Go module the engine is built from, whatsmeow
// (MPL-2.0, our fork) first, as apps/desktop/whatsapp/licenses.sh writes it
// for the desktop packages.
const list = spawnSync('go', ['list', '-m', '-json', 'all'], {cwd: engine, encoding: 'utf8', maxBuffer: 64 << 20,
  env: {...process.env, GOTOOLCHAIN: process.env.GOTOOLCHAIN ?? 'auto'}});
if (list.error || list.status !== 0) throw new Error('Go module list failed for the licence notice');
// One object per module, each closing on a line of its own.
const modules = JSON.parse(`[${list.stdout.trim().replace(/\n}\r?\n{/g, '\n},\n{')}]`);
const parts = [
  'rv-whatsapp is built from these Go modules; their licences follow.',
  'whatsmeow comes from https://github.com/boubou666/whatsmeow (branch rocketvibe), a fork of',
  'https://github.com/tulir/whatsmeow, under the Mozilla Public License 2.0.',
];
// whatsmeow first, the module the notice is mostly about; the others in order.
modules.sort((a, b) => Number(b.Path === 'go.mau.fi/whatsmeow') - Number(a.Path === 'go.mau.fi/whatsmeow'));
for (const module of modules) {
  if (module.Main) continue;
  const dir = module.Replace?.Dir ?? module.Dir;
  if (!dir || !existsSync(dir)) continue;
  for (const name of readdirSync(dir).filter(n => /^(LICEN[CS]E|COPYING)/i.test(n)).sort()) {
    parts.push('', `==== ${module.Path} ${module.Version ?? ''} (${name}) ====`, '', readFileSync(path.join(dir, name), 'utf8').trimEnd());
  }
}
const assets = path.join(moduleDirectory, 'android/build/generated/assets');
mkdirSync(assets, {recursive: true});
writeFileSync(path.join(assets, 'rv-whatsapp-licenses.txt'), parts.join('\n') + '\n');
