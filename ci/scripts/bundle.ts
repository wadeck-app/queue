import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '../..');

const MAX_UPDATER_SIZE = 500 * 1024; // 500 KB

function getCalVer(): string {
  try {
    const count = execSync('git rev-list --count HEAD', { cwd: rootDir, encoding: 'utf8', windowsHide: true }).trim();
    const hash = execSync('git rev-parse --short=8 HEAD', { cwd: rootDir, encoding: 'utf8', windowsHide: true }).trim();
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${yyyy}.${mm}.${dd}-${hh}${min}${ss}-${count}-${hash}`;
  } catch {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8')) as { version: string };
    return pkg.version;
  }
}

const version = process.env['BUNDLE_VERSION'] || getCalVer();
const sharedDefine = {
  'import.meta.url': '__importMetaUrl',
  __QUEUE_CLI_VERSION__: JSON.stringify(version),
};
const sharedBanner = { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" };

const updaterOutfile = join(rootDir, 'dist-bundle/queue-updater.cjs');

await Promise.all([
  build({
    entryPoints: [join(rootDir, 'src/cli/QueueIndex.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outfile: join(rootDir, 'dist-bundle/queue.cjs'),
    banner: sharedBanner,
    define: sharedDefine,
    external: [],
    supported: { 'top-level-await': false },
  }),
  build({
    entryPoints: [join(rootDir, 'src/cli/queue-updater-entry.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outfile: updaterOutfile,
    banner: sharedBanner,
    define: sharedDefine,
    external: [],
    supported: { 'top-level-await': false },
    logLevel: 'warning',
  }),
  build({
    entryPoints: [join(rootDir, 'src/daemon/daemon-entry.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outfile: join(rootDir, 'dist-bundle/queue-daemon.cjs'),
    banner: sharedBanner,
    define: sharedDefine,
    external: [],
    supported: { 'top-level-await': false },
  }),
]);

const updaterSize = statSync(updaterOutfile).size;
if (updaterSize > MAX_UPDATER_SIZE) {
  throw new Error(
    `queue-updater.cjs is ${updaterSize} bytes (${(updaterSize / 1024).toFixed(1)} KB) — exceeds 500 KB limit.\n` +
    'The queue runtime may have been accidentally included. Check queue-updater-entry.ts imports.'
  );
}

console.log(`Bundled queue.cjs + queue-updater.cjs (${(updaterSize / 1024).toFixed(1)} KB) — version: ${version}`);
