import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { readFileSync, statSync, mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
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
  build({
    // Relay daemon entry: self-contained bundle with GitHub plugin built-in,
    // so it doesn't depend on node_modules lookup after publishing
    entryPoints: [join(rootDir, 'src/relay/relay-daemon-entry.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    outfile: join(rootDir, 'dist-bundle/queue-relay-daemon.cjs'),
    banner: sharedBanner,
    define: sharedDefine,
    external: [],
    supported: { 'top-level-await': false },
  }),
]);

// The app-module is built by its own package: `npm run bundle` there runs `app-core-cli package` (backend bundle with
// the loader-compatible export, JSON views, packaged manifest stamped with this build's version). queue-cli only
// copies the resulting dist-module/ next to the daemon bundle; it no longer reads the module's sources.
const appModuleDir = join(rootDir, '../app-module-queue');
const appModuleOutDir = join(rootDir, 'dist-bundle/app-module');
execSync('npm run bundle', {
  cwd: appModuleDir,
  env: { ...process.env, BUNDLE_VERSION: version },
  stdio: 'inherit',
  windowsHide: true,
});
const packagedModule = join(appModuleDir, 'dist-module');
if (!existsSync(join(packagedModule, 'manifest.json'))) {
  throw new Error(`app-module-queue produced no ${packagedModule}/manifest.json: run "npm run bundle" in packages/app-module-queue and read its output.`);
}
rmSync(appModuleOutDir, { recursive: true, force: true });
mkdirSync(dirname(appModuleOutDir), { recursive: true });
cpSync(packagedModule, appModuleOutDir, { recursive: true });

const updaterSize = statSync(updaterOutfile).size;
if (updaterSize > MAX_UPDATER_SIZE) {
  throw new Error(
    `queue-updater.cjs is ${updaterSize} bytes (${(updaterSize / 1024).toFixed(1)} KB) — exceeds 500 KB limit.\n` +
    'The queue runtime may have been accidentally included. Check queue-updater-entry.ts imports.'
  );
}

console.log(`Bundled queue.cjs + queue-updater.cjs (${(updaterSize / 1024).toFixed(1)} KB) — version: ${version}`);
