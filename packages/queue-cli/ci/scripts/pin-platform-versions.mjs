// Publish-time only: pins every optionalDependencies entry of the main package to the EXACT version being published.
// Why: the generated range ">=0.0.0-0" does not match a CalVer version (2026.10.31-244-x is a semver prerelease) and an already
// installed platform package (which holds the Go launcher) was never replaced by `npm install -g @wadeck-app/queue-cli@<new>`.
// Usage: node pin-platform-versions.mjs <package.json> <version>
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function pinOptionalDependencies(pkg, version) {
  const deps = pkg.optionalDependencies;
  if (deps === undefined || Object.keys(deps).length === 0) {
    throw new Error(`package ${pkg.name} has no optionalDependencies to pin: the platform packages would not be installed`);
  }
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('a non-empty version is required');
  }
  for (const name of Object.keys(deps)) deps[name] = version;
  return pkg;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, version] = process.argv.slice(2);
  if (!file || !version) {
    process.stderr.write('usage: node pin-platform-versions.mjs <package.json> <version>\n');
    process.exit(4);
  }
  try {
    const pkg = pinOptionalDependencies(JSON.parse(readFileSync(file, 'utf8')), version);
    writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
    process.stdout.write(`pinned ${Object.keys(pkg.optionalDependencies).length} optionalDependencies of ${pkg.name} to ${version}\n`);
  } catch (e) {
    process.stderr.write(`pin-platform-versions: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
