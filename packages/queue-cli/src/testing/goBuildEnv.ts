/**
 * The environment for a test that starts a Go build (the launcher): `base` without TMPDIR, and with TEMP / TMP on the real temp dir when the leak guard gave one.
 *
 * Why no TMPDIR: the shared build.sh runs `TMPDIR=$(mktemp -d)` and copies a go.mod into that folder. When TMPDIR is already EXPORTED, that assignment changes
 * the variable go inherits, go takes the folder for the system temp root and prints "ignoring go.mod in system temp root"; with TMPDIR unset it stays a shell
 * variable go never sees. Setting TMPDIR to the real temp dir does not help, only removing it does (seen on the Linux CI runner, with the guard's TMPDIR and with the real one).
 */
export function goBuildEnv(base: NodeJS.ProcessEnv, realTmp: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (key.toLowerCase() !== 'tmpdir') {
      env[key] = value;
    }
  }
  if (realTmp !== undefined) {
    env['TEMP'] = realTmp;
    env['TMP'] = realTmp;
  }
  return env;
}
