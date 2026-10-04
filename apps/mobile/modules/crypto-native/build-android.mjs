import {spawnSync} from 'node:child_process';
import {cpSync, existsSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(moduleDirectory, '../../../..');
const crate = path.join(repository, 'crates/rv-crypto-mobile');
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
const targetDirectory = path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(repository, 'target/mobile-crypto'));
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
  // rustup target installation is an explicit toolchain prerequisite, never a
  // hidden network download triggered while the application is starting.
  // NDK r27 needs an explicit alignment for Android devices with 16 KiB pages.
  // Apply it only to the final cdylib, preserving the dependency build cache.
  run('cargo', ['rustc', '--locked', '--lib', '--release', '--target', target, '--target-dir', targetDirectory,
    '--', '-C', 'link-arg=-Wl,-z,max-page-size=16384'], env);
  const destination = path.join(generated, 'jniLibs', abi);
  mkdirSync(destination, {recursive: true});
  cpSync(path.join(targetDirectory, target, 'release/librv_crypto_mobile.so'), path.join(destination, 'librv_crypto_mobile.so'));
}

// Bindgen inspects library metadata; it never loads an Android library on the host.
const rustc = spawnSync('rustc', ['-vV'], {encoding: 'utf8'});
if (rustc.error || rustc.status !== 0) throw new Error('Rust host toolchain unavailable');
const host = /^host: (\S+)$/m.exec(rustc.stdout)?.[1];
if (!host) throw new Error('Rust host toolchain unavailable');
run('cargo', ['build', '--locked', '--features', 'bindgen', '--bin', 'mobile-bindgen', '--target', host, '--target-dir', targetDirectory]);
const executable = path.join(targetDirectory, host, 'debug', `mobile-bindgen${process.platform === 'win32' ? '.exe' : ''}`);
run(executable, ['generate', path.join(generated, 'jniLibs', abis[0], 'librv_crypto_mobile.so'),
  '--language', 'kotlin', '--metadata-no-deps', '--no-format', '--out-dir', path.join(generated, 'rust')]);
