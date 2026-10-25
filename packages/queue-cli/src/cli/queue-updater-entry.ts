// queue-updater-entry.ts -- background auto-update entry point
// This module is bundled separately as queue-updater.cjs.
// It must NOT import any queue runtime modules.
import { runUpdater, execNpm, appendLog } from '@wadeck-app/shared-updater';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { join } from 'node:path';
import { registerAfterUpdate, readAppModuleVersion } from './registerAfterUpdate.js';
import { registerWithAppCore } from '../daemon/AppCoreRegistration.js';
import { isReleaseVersion, devBuildRefusalMessage } from '@wadeck-app/shared-cli/ReleaseVersion';

// Injected by esbuild at bundle time via define; falls back to dev placeholder.
declare const __QUEUE_CLI_VERSION__: string;

const PKG_NAME = '@wadeck-app/queue-cli';
const configDir = process.env['QUEUE_CONFIG_DIR'] ?? ConfigDir.get('queue');
const currentVersion = typeof __QUEUE_CLI_VERSION__ !== 'undefined' ? __QUEUE_CLI_VERSION__ : '0.0.0-dev';

// A repo-built bundle (version not CalVer) must never modify the global install: an interrupted
// `npm install -g` leaves the CLI uninstalled (incident 2026-10-24/25). Runs before anything with a
// side effect. Exit 1 when the user explicitly asked (`cli update` sets UPDATER_FORCE=1) so the
// refusal is not mistaken for "already up to date"; exit 0 for a background invocation.
if (!isReleaseVersion(currentVersion)) {
    const msg = devBuildRefusalMessage('queue', currentVersion);
    process.stderr.write(`[queue-updater] ${msg}\n`);
    try { appendLog(configDir, 'warn', msg); } catch { /* the message above is already visible */ }
    process.exit(process.env['UPDATER_FORCE'] === '1' ? 1 : 0);
}

// Compute self-check command so shared-updater can verify the install after upgrade.
// Must be set before runUpdater() reads UPDATER_SELF_CHECK_CMD.
let npmRoot: string | undefined;
try {
    npmRoot = execNpm(['root', '-g'], { timeout: 10_000 }).trim();
    const selfCheckCmd = `${process.execPath} ${join(npmRoot, PKG_NAME, 'queue.cjs')} cli self-check`;
    if (!process.env['UPDATER_SELF_CHECK_CMD']) {
        process.env['UPDATER_SELF_CHECK_CMD'] = selfCheckCmd;
    }
} catch {
    // Skip self-check if npm root is unavailable - update proceeds without verification.
}

const appModuleManifest = npmRoot === undefined ? undefined : join(npmRoot, PKG_NAME, 'app-module', 'manifest.json');
// Read before the install replaces the files: registerAfterUpdate registers only if this changed.
const appModuleBefore = appModuleManifest === undefined ? undefined : readAppModuleVersion(appModuleManifest);

runUpdater({
    pkgName: PKG_NAME,
    configDir,
    currentVersion,
    strategy: 'without-daemon',
    onUpdateAvailable: async (_newVersion: string) => 'apply-now' as const,
}).then(async () => {
    // The update does not restart the daemon (it registers on its own start), so a running app-core would
    // keep the previous app-module until the next daemon start: tell it now, from the new install.
    if (appModuleManifest === undefined || appModuleBefore === undefined) {
        process.stderr.write('[queue-updater] app-core: not re-registering the app-module, "npm root -g" failed earlier\n');
        return;
    }
    await registerAfterUpdate({
        manifestPath: appModuleManifest,
        before: appModuleBefore,
        register: registerWithAppCore,
        log: (line) => process.stdout.write(`[queue-updater] ${line}\n`),
    });
}).catch(err => {
    process.stderr.write(`[queue-updater] fatal: ${err}\n`);
    process.exit(1);
});
