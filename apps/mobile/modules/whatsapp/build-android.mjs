// Builds the WhatsApp engine (crates/rv-whatsapp/engine, Rust) as
// librv_whatsapp.so for each ABI with the NDK's clang: the engine the desktop
// runs in process, exported to C by crates/rv-whatsapp/android and loaded by
// Kotlin through JNA. Then its licence notice, every crate it is built from.
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(moduleDirectory, '../../../..');
const workspace = path.join(repository, 'crates/rv-whatsapp');
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  if (!['--ndk', '--min-api', '--abis'].includes(name) || !process.argv[index + 1]) throw new Error('Invalid native build option');
  options.set(name, process.argv[index + 1]);
}
const ndk = options.get('--ndk') ?? process.env.ANDROID_NDK_HOME;
const api = Number(options.get('--min-api') ?? 24);
const abis = [...new Set((options.get('--abis') ?? 'arm64-v8a,x86_64').split(','))];
const targets = {'arm64-v8a': 'aarch64-linux-android', 'x86_64': 'x86_64-linux-android'};
if (!ndk || !Number.isInteger(api) || api < 24 || abis.length === 0 || abis.some(abi => !targets[abi])) {
  throw new Error('Android NDK, minimum API >=24 and supported Rust ABIs required');
}
const hostTag = process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? 'darwin-x86_64' : 'linux-x86_64';
const llvm = path.join(ndk, 'toolchains/llvm/prebuilt', hostTag, 'bin');
const extension = process.platform === 'win32' ? '.cmd' : '';
const targetDirectory = path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(repository, 'target/mobile-whatsapp'));
const generated = path.join(moduleDirectory, 'android/build/generated');

function run(command, args, env = process.env, capture = false) {
  const result = spawnSync(command, args, {cwd: workspace, env, encoding: 'utf8', maxBuffer: 64 << 20,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`WhatsApp engine build failed: ${command} ${args[0]}`);
  return result.stdout;
}

for (const abi of abis) {
  const target = targets[abi];
  const compiler = path.join(llvm, `${target}${api}-clang${extension}`);
  if (!existsSync(compiler)) throw new Error(`Missing NDK compiler for ${abi}`);
  const key = target.replaceAll('-', '_');
  const env = {...process.env,
    [`CC_${key}`]: compiler,
    [`AR_${key}`]: path.join(llvm, process.platform === 'win32' ? 'llvm-ar.exe' : 'llvm-ar'),
    [`CARGO_TARGET_${key.toUpperCase()}_LINKER`]: compiler,
  };
  // The rustup target is an explicit toolchain prerequisite, as for crypto-native.
  // NDK r27 needs an explicit alignment for devices with 16 KiB pages: the final library only.
  run('cargo', ['rustc', '--locked', '-p', 'rv-whatsapp-android', '--lib', '--crate-type', 'cdylib', '--release',
    '--target', target, '--target-dir', targetDirectory, '--', '-C', 'link-arg=-Wl,-z,max-page-size=16384',
    '-C', 'link-arg=-Wl,-soname,librv_whatsapp.so'], env);
  const destination = path.join(generated, 'jniLibs', abi);
  mkdirSync(destination, {recursive: true});
  cpSync(path.join(targetDirectory, target, 'release/librv_whatsapp.so'), path.join(destination, 'librv_whatsapp.so'));
}

// The licence notice the APK ships (assets/rv-whatsapp-licenses.txt, shown
// from Settings > App): every crate the library is built from for the first
// ABI, as crates/rv-whatsapp/engine/licenses.sh writes it for the desktop.
const used = new Set(run('cargo', ['tree', '--locked', '-p', 'rv-whatsapp-android', '-e', 'normal,build',
  '--target', targets[abis[0]], '--prefix', 'none', '-f', '{p}'], process.env, true)
  .split('\n').map(line => line.trim().split(' ')).filter(([name, version]) => name && version)
  .map(([name, version]) => `${name} ${version.replace(/^v/, '')}`));
const meta = JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1'], process.env, true));
const parts = [
  'The WhatsApp engine in RocketVibe is built from these Rust crates; their licences follow.',
  'whatsapp-rust and its wacore crates come from https://github.com/oxidezap/whatsapp-rust',
  '(MIT), vendored with changes in crates/rv-whatsapp of https://github.com/Guillaume69/rocket-vibe.',
];
const notices = name => /^(LICEN[CS]E|COPYING|NOTICE)/i.test(name);
const ours = new Set(['rv-whatsapp-android', 'rv-whatsapp-engine']);
for (const p of [...meta.packages].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  if (!used.has(`${p.name} ${p.version}`) || ours.has(p.name)) continue;
  let folder = path.dirname(p.manifest_path);
  let files = readdirSync(folder).filter(notices).sort();
  // A vendored crate carries the licence of the repository it came from.
  while (files.length === 0 && p.source === null && folder.startsWith(meta.workspace_root + path.sep)) {
    folder = path.dirname(folder);
    files = readdirSync(folder).filter(name => /^LICEN[CS]E/i.test(name)).sort();
  }
  parts.push('', `==== ${p.name} ${p.version} (${p.license ?? 'see below'}) ====`);
  for (const name of files) {
    const file = path.join(folder, name);
    if (statSync(file).isFile()) parts.push('', `-- ${name} --`, '', readFileSync(file, 'utf8').trimEnd());
  }
}
const assets = path.join(generated, 'assets');
mkdirSync(assets, {recursive: true});
writeFileSync(path.join(assets, 'rv-whatsapp-licenses.txt'), parts.join('\n') + '\n');
