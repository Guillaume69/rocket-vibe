// Builds crates/rv-voice-mobile (RNNoise over JNI) for the requested Android
// ABIs into android/build/generated/jniLibs, as crypto-native's script builds
// rv-crypto-mobile. Called by the voice module's Gradle build.
import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(moduleDirectory, '../../../..');
const crate = path.join(repository, 'crates/rv-voice-mobile');
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
const targetDirectory = path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(repository, 'target/mobile-voice'));
const generated = path.join(moduleDirectory, 'android/build/generated');

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {cwd: crate, env, stdio: 'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Native build failed: ${command}`);
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
  // As for the crypto library: 16 KiB pages on recent devices, applied to the cdylib only.
  run('cargo', ['rustc', '--locked', '--lib', '--release', '--target', target, '--target-dir', targetDirectory,
    '--', '-C', 'link-arg=-Wl,-z,max-page-size=16384'], env);
  const destination = path.join(generated, 'jniLibs', abi);
  mkdirSync(destination, {recursive: true});
  cpSync(path.join(targetDirectory, target, 'release/librv_voice_mobile.so'), path.join(destination, 'librv_voice_mobile.so'));
}
