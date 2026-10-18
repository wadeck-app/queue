import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerAfterUpdate } from './registerAfterUpdate.js';

let configDir: string;
const startedAtMs = 1_000_000;
const register = vi.fn();
let lines: string[];
const log = (line: string): void => { lines.push(line); };

function writeState(state: Record<string, unknown>): void {
  writeFileSync(join(configDir, 'update-state.json'), JSON.stringify(state));
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'register-after-update-'));
  lines = [];
  register.mockReset();
  register.mockResolvedValue(undefined);
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe('registerAfterUpdate', () => {
  it('registers the newly installed app-module when this updater run ended with a success', async () => {
    writeState({ status: 'success', timestamp: startedAtMs + 5_000 });
    await registerAfterUpdate({ configDir, manifestPath: '/npm/root/queue-cli/app-module/manifest.json', startedAtMs, register, log });
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toBe('/npm/root/queue-cli/app-module/manifest.json');
  });

  it('does not register on a stale success from an earlier run (already up to date this time)', async () => {
    writeState({ status: 'success', timestamp: startedAtMs - 5_000 });
    await registerAfterUpdate({ configDir, manifestPath: '/m.json', startedAtMs, register, log });
    expect(register).not.toHaveBeenCalled();
  });

  it.each(['failed', 'rolled-back', 'deferred'])('does not register when the update ended as "%s" (the installed version did not change)', async (status) => {
    writeState({ status, timestamp: startedAtMs + 5_000 });
    await registerAfterUpdate({ configDir, manifestPath: '/m.json', startedAtMs, register, log });
    expect(register).not.toHaveBeenCalled();
  });

  it('says so, instead of staying silent, when the update state file is missing', async () => {
    await registerAfterUpdate({ configDir, manifestPath: '/m.json', startedAtMs, register, log });
    expect(register).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('update-state.json');
  });

  it('says so when the update state file is corrupt', async () => {
    writeFileSync(join(configDir, 'update-state.json'), '{not json');
    await registerAfterUpdate({ configDir, manifestPath: '/m.json', startedAtMs, register, log });
    expect(register).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain('update-state.json');
  });
});
