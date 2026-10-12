// Builds the WhatsApp engine (apps/desktop/whatsapp, Go) as librv_whatsapp.so
// for each ABI with the NDK's clang: the same code as the desktop helper,
// exported to C by its mobile/ package and loaded by Kotlin through JNA.
import {spawnSync} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
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
