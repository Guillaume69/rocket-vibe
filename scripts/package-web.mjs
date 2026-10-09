import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0)
    throw result.error || new Error(`${command}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const version = run(process.execPath, ['scripts/version.mjs', 'web']);
const output = resolve(root, process.argv[2] || '.cache/web-package');
const name = `rocket-vibe-web-${version}`;
const stage = join(output, name);
if (existsSync(stage)) throw new Error(`Package staging directory already exists: ${stage}`);
for (const file of ['index.html', 'sw.js'])
  if (!existsSync(join(root, 'apps/web/dist', file))) throw new Error(`Missing built ${file}`);
mkdirSync(stage, { recursive: true });
cpSync(join(root, 'apps/web/dist'), join(stage, 'dist'), { recursive: true });
cpSync(join(root, 'apps/web/README.md'), join(stage, 'README.md'));
cpSync(join(root, 'apps/web/CHANGELOG.md'), join(stage, 'CHANGELOG.md'));
writeFileSync(join(stage, 'VERSION.json'), JSON.stringify({
  app: 'web', version, commit: run('git', ['rev-parse', 'HEAD']),
}, null, 2) + '\n');
writeFileSync(join(stage, 'DEPLOYMENT.md'), `# RocketVibe web ${version}\n\nThe native RocketVibe server embeds this dist directory at build time. Use the source checkout at web-v${version}, which includes the matching native API changes, and rebuild rv-server (cargo build --locked --release -p rv-server), or build apps/server/Dockerfile from that checkout. Serve the application and API from the same HTTPS origin. No separate Node process is required.\n\nThese archives contain the frontend assets only. An existing rv-server binary keeps its previously embedded frontend until rebuilt. The web client uses one account on the serving origin; encrypted rooms remain unsupported. Browser media and persistent workers require HTTPS, with loopback allowed for local development.\n`);
const tarName = `${name}.tar.gz`, zipName = `${name}.zip`;
run('tar', ['-C', output, '-czf', join(output, tarName), name]);
if (process.platform === 'win32') {
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  run('powershell.exe', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory(${quote(stage)}, ${quote(join(output, zipName))}, [IO.Compression.CompressionLevel]::Optimal, $true)`]);
} else run('zip', ['-q', '-r', zipName, name], output);
writeFileSync(join(output, 'SHA256SUMS'), [tarName, zipName].map((file) =>
  createHash('sha256').update(readFileSync(join(output, file))).digest('hex') + '  ' + file,
).join('\n') + '\n');
console.log(`Packaged web ${version}: ${tarName}, ${zipName}, SHA256SUMS`);
