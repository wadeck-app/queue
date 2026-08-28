import * as esbuild from 'esbuild';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');

function getCalVer(): string {
  try {
    const count = execSync('git rev-list --count HEAD', { cwd: rootDir, encoding: 'utf8' }).trim();
    const hash = execSync('git rev-parse --short=8 HEAD', { cwd: rootDir, encoding: 'utf8' }).trim();
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${yyyy}.${mm}.${dd}-${hh}${min}${ss}-${count.trim()}-${hash}`;
  } catch {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf-8')) as { version: string };
    return pkg.version;
  }
}

const version = getCalVer();

await esbuild.build({
  entryPoints: [join(rootDir, 'src/cli/QueueIndex.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  outfile: join(rootDir, 'dist-bundle/queue.cjs'),
  banner: {
    js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
  define: {
    'import.meta.url': '__importMetaUrl',
    __QUEUE_CLI_VERSION__: JSON.stringify(version),
  },
  external: [],
  supported: { 'top-level-await': false },
});

console.log(`Bundled queue.cjs (version: ${version})`);
