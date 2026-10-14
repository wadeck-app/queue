import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as fs from 'node:fs';
import { createRelayLogger } from './RelayLogger.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `queue-relay-logger-test-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('RelayLogger', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('appends lines with ISO timestamp', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'relay.log');
    const logger = createRelayLogger(logPath);

    // Mock Date to control timestamp
    const mockDate = new Date('2026-10-13T12:34:56.789Z');
    vi.useFakeTimers();
    vi.setSystemTime(mockDate);

    logger('test line 1');
    logger('test line 2');

    vi.useRealTimers();

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^2026-10-13T12:34:56\.789Z test line 1$/);
    expect(lines[1]).toMatch(/^2026-10-13T12:34:56\.789Z test line 2$/);
  });

  it('creates parent directories if they do not exist', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'some', 'nested', 'dir', 'relay.log');

    expect(existsSync(join(tmpDir, 'some', 'nested', 'dir'))).toBe(false);

    const logger = createRelayLogger(logPath);
    logger('test');

    expect(existsSync(join(tmpDir, 'some', 'nested', 'dir'))).toBe(true);
    expect(readFileSync(logPath, 'utf-8')).toMatch(/test/);
  });

  it('rotates log file when exceeding threshold', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'relay.log');
    const rotatedPath = join(tmpDir, 'relay.log.1');

    // Use a small threshold for testing (100 bytes)
    const logger = createRelayLogger(logPath, { rotationThresholdBytes: 100 });

    // Write a line that will exceed the threshold
    logger('a'.repeat(80)); // This line plus timestamp will exceed 100 bytes
    logger('b'.repeat(80)); // This should trigger rotation

    // The old log should be rotated to .1
    expect(existsSync(rotatedPath)).toBe(true);

    // New log should contain the most recent write
    const newContent = readFileSync(logPath, 'utf-8');
    expect(newContent).toContain('b'.repeat(80));

    // Rotated log should contain the old write
    const rotatedContent = readFileSync(rotatedPath, 'utf-8');
    expect(rotatedContent).toContain('a'.repeat(80));
  });

  it('overwrites existing .1 file on rotation', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'relay.log');
    const rotatedPath = join(tmpDir, 'relay.log.1');

    // Create an old .1 file
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(rotatedPath, 'old rotated content\n');

    const logger = createRelayLogger(logPath, { rotationThresholdBytes: 100 });

    logger('a'.repeat(80));
    logger('b'.repeat(80)); // Trigger rotation

    // New rotated file should have the old main log content, not the old .1 content
    const rotatedContent = readFileSync(rotatedPath, 'utf-8');
    expect(rotatedContent).toContain('a'.repeat(80));
    expect(rotatedContent).not.toContain('old rotated content');
  });

  it('does not throw on write failure and emits one stderr message', () => {
    tmpDir = makeTmpDir();

    // Create a file where the parent directory should be
    const parentPath = join(tmpDir, 'parent');
    writeFileSync(parentPath, 'not a directory');

    // Try to create a logger with a path whose parent is a file
    const logPath = join(parentPath, 'relay.log');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const logger = createRelayLogger(logPath);

    // Should not throw
    expect(() => {
      logger('test line');
    }).not.toThrow();

    // Should have written exactly one stderr message
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const stderrCall = stderrSpy.mock.calls[0][0];
    expect(stderrCall).toContain(logPath);
    // Windows returns ENOENT, Unix returns ENOTDIR, macOS returns EISDIR
    expect(stderrCall).toMatch(/ENOENT|ENOTDIR|EACCES|EISDIR/);

    stderrSpy.mockRestore();
  });

  it('uses default rotation threshold of 1 MiB', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'relay.log');

    const logger = createRelayLogger(logPath);

    // This should not throw; if we had a real 1 MiB file, it would rotate
    // but we're just checking that the logger initializes without error
    expect(() => {
      logger('small line');
    }).not.toThrow();
  });

  it('handles multiple writes after failure by only emitting one stderr message', () => {
    tmpDir = makeTmpDir();

    const parentPath = join(tmpDir, 'parent');
    writeFileSync(parentPath, 'not a directory');

    const logPath = join(parentPath, 'relay.log');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const logger = createRelayLogger(logPath);

    // Multiple writes should not generate multiple stderr messages
    logger('test 1');
    logger('test 2');
    logger('test 3');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    stderrSpy.mockRestore();
  });

  it('reports rotation rename failure but continues writing all lines', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'relay.log');
    const rotatedPath = join(tmpDir, 'relay.log.1');

    // Pre-create .1 as a directory; when rotation tries to rename to it, it will fail
    mkdirSync(rotatedPath);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createRelayLogger(logPath, { rotationThresholdBytes: 50 });

    // Write a small line first (will succeed since file doesn't exist and no rotation attempted)
    logger('line1');

    // This will trigger rotation attempt (file size >= 50 bytes)
    // The renameSync will fail because .1 is a directory
    // But append should still happen, and line2 should be written
    logger('line2');

    // Another write after rotation failure
    logger('line3');

    // Should have emitted exactly one stderr message mentioning rotation
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const stderrCall = stderrSpy.mock.calls[0][0] as string;
    // Message should mention the path and rotation failure
    expect(stderrCall).toContain(logPath);
    expect(stderrCall).toMatch(/rotat/i); // rotation or rotate
    // Rotation failures should say "keep growing", NOT "NOT being persisted"
    expect(stderrCall).toContain('keep growing');
    expect(stderrCall).not.toContain('NOT being persisted');

    // All three lines should be in the main log file (this is the critical test)
    const content = readFileSync(logPath, 'utf-8');
    expect(content).toContain('line1');
    expect(content).toContain('line2');
    expect(content).toContain('line3');
    // Verify no throw occurred
    expect(() => {
      logger('line4');
    }).not.toThrow();

    stderrSpy.mockRestore();
  });

  it('getLastError returns null initially and error string after failure', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'relay.log');

    const logger = createRelayLogger(logPath) as any;

    // Should have getLastError method
    expect(typeof logger.getLastError).toBe('function');

    // Initially null
    expect(logger.getLastError()).toBe(null);

    // Create a failure condition
    const parentPath = join(tmpDir, 'parent');
    writeFileSync(parentPath, 'not a directory');

    const logPath2 = join(parentPath, 'relay.log');
    const logger2 = createRelayLogger(logPath2) as any;

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Trigger a write to cause failure
    logger2('test');

    // Now getLastError should return a string
    const lastError = logger2.getLastError();
    expect(typeof lastError).toBe('string');
    expect(lastError.length).toBeGreaterThan(0);
    expect(lastError).toContain(logPath2);

    stderrSpy.mockRestore();
  });

  it('error message contains error code if available', () => {
    tmpDir = makeTmpDir();
    const parentPath = join(tmpDir, 'parent');
    writeFileSync(parentPath, 'not a directory');

    const logPath = join(parentPath, 'relay.log');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const logger = createRelayLogger(logPath);
    logger('test');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const stderrCall = stderrSpy.mock.calls[0][0];
    // Should include the path, error message, and actionable guidance
    expect(stderrCall).toContain('[queue-relay-client]');
    expect(stderrCall).toContain(logPath);
    expect(stderrCall).toContain('writable');
    expect(stderrCall).toContain('free disk space');
    // Append failure should say "NOT being persisted"
    expect(stderrCall).toContain('NOT being persisted');

    stderrSpy.mockRestore();
  });

  it('getLastError keeps describing the failure after repeated failures while stderr only emits once', () => {
    tmpDir = makeTmpDir();

    // Create a condition where append will fail
    const parentPath = join(tmpDir, 'parent');
    writeFileSync(parentPath, 'not a directory');

    const logPath2 = join(parentPath, 'relay.log');
    const logger = createRelayLogger(logPath2) as any;

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // First write fails
    logger('test1');
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const firstError = logger.getLastError();
    // A file used as a directory is ENOENT on Windows and ENOTDIR on Linux/macOS
    expect(firstError).toMatch(/Cannot write relay log .*\((ENOENT|ENOTDIR)\)/);

    // Second write also fails (same condition) - stderr should NOT emit again
    logger('test2');
    expect(stderrSpy).toHaveBeenCalledTimes(1); // Still only once

    // But lastErrorMessage should still contain the error info (same error)
    const secondError = logger.getLastError();
    expect(secondError).toBe(firstError); // Same error condition

    stderrSpy.mockRestore();
  });

  it('rotation failure message mentions "keep growing" and not "NOT being persisted"', () => {
    tmpDir = makeTmpDir();
    const logPath = join(tmpDir, 'relay.log');
    const rotatedPath = join(tmpDir, 'relay.log.1');

    // Pre-create .1 as a directory to force rotation failure
    mkdirSync(rotatedPath);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = createRelayLogger(logPath, { rotationThresholdBytes: 50 });

    // Write large line first (will succeed, no rotation attempted)
    logger('a'.repeat(50));

    // This triggers rotation attempt (file now >= 50 bytes), fails, but append should succeed
    logger('b'.repeat(30));

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const message = stderrSpy.mock.calls[0][0] as string;

    // Rotation messages should be specific about the behavior
    expect(message).toContain('keep growing');
    expect(message).toContain('rotate');
    expect(message).not.toContain('NOT being persisted');
    expect(message).toContain('.1');

    stderrSpy.mockRestore();
  });

  it('append failure message mentions "NOT being persisted"', () => {
    tmpDir = makeTmpDir();

    const parentPath = join(tmpDir, 'parent');
    writeFileSync(parentPath, 'not a directory');

    const logPath = join(parentPath, 'relay.log');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const logger = createRelayLogger(logPath);
    logger('test');

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const message = stderrSpy.mock.calls[0][0] as string;

    // Append failure should indicate data loss
    expect(message).toContain('NOT being persisted');
    expect(message).toContain('Cannot write');
    expect(message).not.toContain('keep growing');

    stderrSpy.mockRestore();
  });
});
