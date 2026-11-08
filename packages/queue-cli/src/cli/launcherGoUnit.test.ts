/**
 * Runs the Go unit tests of the launcher's config dir resolution (ci/launcher-main_test.go) against the real template.
 * build.sh generates main.go from ci/launcher-main.go.tmpl and compiles it alone, so the test file cannot sit next to it in the repo: this test renders the template
 * the way build.sh does (same substitutions, same config file), adds the test file and a go.mod that replaces the SDK's go-launcher package, and runs `go test`.
 * Needs `go` in PATH (CI installs it, see the workflow); throws with instructions when it is missing, no silent skip.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { goBuildEnv } from '../testing/goBuildEnv.js';

const CI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ci');

interface LauncherConfig {
  appName: string;
  nodeScript: string;
  defaultConfigDir: string;
  cliFlags: string[];
  silentFlags?: string[];
  updateCmd?: string[];
}

/** The substitutions of the node snippet in the SDK's build.sh. */
function renderTemplate(template: string, config: LauncherConfig): string {
  const lines = (values: string[] | undefined): string => (values ?? []).map((v) => `\t\t\t"${v}",`).join('\n');
  return template
    .replace(/\{\{\.AppName\}\}/g, config.appName)
    .replace(/\{\{\.DefaultConfigDir\}\}/g, config.defaultConfigDir)
    .replace(/\{\{\.NodeScript\}\}/g, config.nodeScript)
    .replace(/\{\{range \.CLIFlags\}\}.*?\{\{end\}\}/s, `${lines(config.cliFlags)}\n`)
    .replace(/\{\{range \.SilentFlags\}\}.*?\{\{end\}\}/s, `${lines(config.silentFlags)}\n`)
    .replace(/\{\{range \.UpdateCmd\}\}.*?\{\{end\}\}/s, `${lines(config.updateCmd)}\n`);
}

describe('Go launcher: config dir resolution (go test)', () => {
  it('passes: --config, QUEUE_CONFIG_DIR, XDG_CONFIG_HOME, HOME/.config', () => {
    const sdkDir = join(dirname(createRequire(import.meta.url).resolve('@wadeck-app/singleton-daemon-kit/package.json')), 'go-launcher');
    const config = JSON.parse(readFileSync(join(CI_DIR, 'launcher-queue.config.json'), 'utf8')) as LauncherConfig;
    expect(config.defaultConfigDir, 'the Go tests resolve the app name "queue"').toBe('queue');
    // Outside the private temp root of the leak guard: go ignores a go.mod below the redirected temp root (seen on the Linux CI runner), and a Go module is no queue-* leak
    const realTmp = process.env['QUEUE_TEST_REAL_TMPDIR'] ?? tmpdir();
    const dir = mkdtempSync(join(realTmp, 'queue-launcher-gotest-'));
    try {
      writeFileSync(join(dir, 'main.go'), renderTemplate(readFileSync(join(CI_DIR, 'launcher-main.go.tmpl'), 'utf8'), config));
      copyFileSync(join(CI_DIR, 'launcher-main_test.go'), join(dir, 'main_test.go'));
      const sdkMod = readFileSync(join(sdkDir, 'go.mod'), 'utf8');
      const goVersion = /^go (\S+)/m.exec(sdkMod)?.[1];
      const toolchain = /^toolchain (\S+)/m.exec(sdkMod)?.[1];
      expect(goVersion, `no "go" line in ${join(sdkDir, 'go.mod')}`).toBeDefined();
      writeFileSync(join(dir, 'go.mod'), [
        'module consumer',
        '',
        `go ${goVersion}`,
        ...(toolchain === undefined ? [] : [`toolchain ${toolchain}`]),
        '',
        'require wadeck.ch/singleton-daemon-kit/go-launcher v0.0.0',
        '',
        'require golang.org/x/sys v0.47.0 // indirect',
        '',
        `replace wadeck.ch/singleton-daemon-kit/go-launcher => ${sdkDir.split(sep).join('/')}`,
        '',
      ].join('\n'));
      copyFileSync(join(sdkDir, 'go.sum'), join(dir, 'go.sum'));
      // The real environment on purpose: the Go module cache lives under the real home (an isolated home would make go download the modules). The Go tests set
      // their own HOME / XDG_CONFIG_HOME to throwaway directories.
      const result = spawnSync('go', ['test', './...'], { cwd: dir, encoding: 'utf8', timeout: 300_000, windowsHide: true, env: goBuildEnv(process.env, process.env['QUEUE_TEST_REAL_TMPDIR']) });
      if (result.error) {
        throw new Error(`Cannot run \`go test\` (${result.error.message}). Fix: install Go and put it in PATH (the CI workflow installs it with actions/setup-go).`);
      }
      expect(result.status, `go test failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
