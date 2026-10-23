// Builds the CommonJS entry points next to the ESM output of tsc, so `require('@wadeck-app/queue-sdk')` works for consumers
// that are not ESM (the package is type "module"). The type declarations of the ESM build serve both.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const entry of ['index', 'protocol']) {
  await build({
    entryPoints: [join(packageDir, 'src', `${entry}.ts`)],
    outfile: join(packageDir, 'dist', 'cjs', `${entry}.cjs`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'warning',
  });
}
console.log('built dist/cjs');
