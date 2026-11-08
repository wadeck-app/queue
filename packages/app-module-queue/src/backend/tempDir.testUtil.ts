import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Test helpers shared by the backend tests (named *.testUtil.ts like registeredRoutes.testUtil.ts: not a test file, never part of the module).

/** A fresh empty temp directory (mkdtemp, never a fixed name) with the given sub-folders created. Remove it with `removeTempDir`. */
export function makeTempDir(prefix: string, subFolders: readonly string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const folder of subFolders) {
    mkdirSync(join(dir, folder), { recursive: true });
  }
  return dir;
}

/** Windows keeps files open for a moment after a test: retry before failing. */
export function removeTempDir(...dirs: string[]): void {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** Writes `<configDir>/<folder>/<day>.ndjson` with one JSON line per record (the folder is created when missing). */
export function writeNdjsonDay(configDir: string, folder: 'history' | 'logs', day: string, records: readonly object[]): void {
  mkdirSync(join(configDir, folder), { recursive: true });
  writeFileSync(join(configDir, folder, `${day}.ndjson`), records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

/** The history file of a day. */
export function writeHistoryDay(configDir: string, day: string, records: readonly object[]): void {
  writeNdjsonDay(configDir, 'history', day, records);
}

/** The daemon log file of a day. */
export function writeLogDay(configDir: string, day: string, records: readonly object[]): void {
  writeNdjsonDay(configDir, 'logs', day, records);
}
