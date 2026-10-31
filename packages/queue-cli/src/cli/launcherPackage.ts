import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface LauncherCheck {
  name: string;
  ok: boolean;
  detail?: string;
  /** Non-fatal findings: the check still passes (the shared self-check runner has no warn level), the caller must print them. */
  warnings?: string[];
}

export interface LauncherCheckDeps {
  /** Version of the running queue-cli bundle. */
  version: string;
  platform: string;
  arch: string;
  /** Resolves a module path (require.resolve); throws when not found. */
  resolve: (request: string) => string;
  readFile?: (path: string) => string;
  /** Directory of the running queue-cli package (where queue.cjs lives); enables the shadowed-copy warning. */
  packageDir?: string;
}

/**
 * A same-named platform package of ANOTHER version in the `@wadeck-app` directory next to queue-cli (typically a stale
 * top-level copy left by an unversioned install, shadowed by the right nested one). Harmless today, bites if resolution changes.
 */
function findShadowedCopy(pkg: string, packageDir: string, version: string, readFile: (p: string) => string): string | undefined {
  const scopeDir = dirname(packageDir);
  if (basename(scopeDir) !== '@wadeck-app') return undefined;
  const otherDir = join(scopeDir, pkg.slice('@wadeck-app/'.length));
  let other: string;
  try {
    const parsed = JSON.parse(readFile(join(otherDir, 'package.json'))) as { version?: unknown };
    if (typeof parsed.version !== 'string') return undefined;
    other = parsed.version;
  } catch {
    // Absent copy is the normal case
    return undefined;
  }
  if (other === version) return undefined;
  return `a stale ${pkg} ${other} sits at ${otherDir} (queue-cli ${version} is at ${packageDir}); it is not used today but can shadow the right one. Cleanup: npm uninstall -g ${pkg}`;
}

/**
 * The Go launcher (queue.exe) ships in a separate per-platform package that must have the SAME version as
 * queue-cli. A stale one silently runs an old launcher (e.g. without the QUEUE_CONFIG_DIR fix), so a mismatch is a failure.
 */
export function checkLauncherPackage(deps: LauncherCheckDeps): LauncherCheck {
  const name = 'launcher-package';
  // Local/dev builds are not installed from the registry: there is no platform package to compare with
  if (!/^\d{4}\.\d{1,2}\.\d{1,2}-/.test(deps.version)) {
    return { name, ok: true, detail: `skipped (version ${deps.version} is not a published CalVer build)` };
  }
  const arch = deps.arch === 'arm64' ? 'arm64' : 'x64';
  const pkg = `@wadeck-app/queue-cli-${deps.platform}-${arch}`;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  let installed: string;
  try {
    const parsed = JSON.parse(readFile(deps.resolve(`${pkg}/package.json`))) as { version?: unknown };
    if (typeof parsed.version !== 'string') {
      return { name, ok: false, detail: `${pkg} has no version field in its package.json. Fix: npm install -g ${pkg}@${deps.version}` };
    }
    installed = parsed.version;
  } catch (e: unknown) {
    const why = e instanceof Error ? e.message : String(e);
    return { name, ok: false, detail: `${pkg} cannot be read (${why}). Fix: npm install -g ${pkg}@${deps.version}` };
  }
  if (installed !== deps.version) {
    return {
      name,
      ok: false,
      detail: `${pkg} is ${installed} but queue-cli is ${deps.version}: the launcher is stale. Fix: npm install -g ${pkg}@${deps.version}`,
    };
  }
  const result: LauncherCheck = { name, ok: true, detail: `${pkg} ${installed}` };
  const shadow = deps.packageDir ? findShadowedCopy(pkg, deps.packageDir, deps.version, readFile) : undefined;
  if (shadow) result.warnings = [shadow];
  return result;
}
