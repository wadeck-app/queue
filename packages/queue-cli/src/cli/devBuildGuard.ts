// A release is stamped by CI (ci/scripts/compute-version.sh) as YYYY.MM.DD-BBB-xxxxxxxx:
// zero-padded build number (3+ digits) and an 8-char lowercase hex commit hash.
// Anything else (0.0.0-dev, 0.1.0-dev, 0.0.0-test-integration, the local bundler's
// YYYY.MM.DD-HHMMSS-count-HASH fallback) is a repo-built dev bundle. Strict on purpose: a false
// "release" lets a dev build run `npm install -g`, a false "dev" only makes an update refuse loudly.
//
// Imported by the updater bundle: keep it free of any queue runtime import.
const CALVER_RE = /^\d{4}\.(0[1-9]|1[0-2])\.(0[1-9]|[12]\d|3[01])-\d{3,}-[0-9a-f]{8}$/;

export function isCalVer(version: string | undefined | null): boolean {
  return typeof version === 'string' && CALVER_RE.test(version);
}

/**
 * Actionable message printed (and logged) when a non-release build is asked to update. Such a
 * build must never touch the global install: an interrupted `npm install -g` leaves the CLI
 * uninstalled (incident 2026-10-24/25, integration tests ran `cli update` from a dev bundle).
 */
export function devBuildRefusalMessage(binary: string, version: string): string {
  return `dev build ${version}: refusing to update the global install of ${binary}; ` +
    `this is a repo-built bundle, not a CalVer release. Use the installed binary's \`${binary} cli update\` instead.`;
}
