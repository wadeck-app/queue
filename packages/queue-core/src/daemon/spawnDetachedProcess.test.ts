import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLaunchScript, spawnDetachedProcess } from './spawnDetachedProcess';
import { waitFor } from '../waitFor.testUtil.js';

// violations-suppress: shared/no-out-of-repo-path fixture string for the VBScript builder, never touched on disk
const NODE_PATH = 'C:\\Node\\node.exe';
// violations-suppress: shared/no-out-of-repo-path fixture string for the VBScript builder, never touched on disk
const SCRIPT_PATH = 'C:\\script.js';

describe('buildLaunchScript', () => {
  it('should include environment variable lines', () => {
    const script = buildLaunchScript(NODE_PATH, SCRIPT_PATH, {
      FOO: 'bar',
      BAZ: 'qux',
    });
    expect(script).toContain('oShell.Environment("Process")("FOO") = "bar"');
    expect(script).toContain('oShell.Environment("Process")("BAZ") = "qux"');
  });

  it('should include the Run line with SW_HIDE (0) and False', () => {
    const script = buildLaunchScript(NODE_PATH, SCRIPT_PATH, {});
    expect(script).toContain('oShell.Run');
    // Format: oShell.Run """node.exe"" ""script.js""", 0, False
    expect(script).toContain(', 0, False');
  });

  it('should escape double quotes in paths', () => {
    // violations-suppress: shared/no-out-of-repo-path fixture string for the VBScript builder, never touched on disk
    const quotedNode = 'C:\\Program Files\\Node "test"\\node.exe';
    // violations-suppress: shared/no-out-of-repo-path fixture string for the VBScript builder, never touched on disk
    const quotedScript = 'C:\\Scripts\\"my script".js';
    // violations-suppress: shared/no-out-of-repo-path fixture string for the VBScript builder, never touched on disk
    const escapedNode = 'C:\\Program Files\\Node ""test""\\node.exe';
    // violations-suppress: shared/no-out-of-repo-path fixture string for the VBScript builder, never touched on disk
    const escapedScript = 'C:\\Scripts\\""my script"".js';

    const script = buildLaunchScript(quotedNode, quotedScript, {});

    expect(script).toContain(escapedNode);
    expect(script).toContain(escapedScript);
  });

  it('should escape double quotes in environment values', () => {
    const script = buildLaunchScript(NODE_PATH, SCRIPT_PATH, {
      QUOTED_VAR: 'value with "quotes" inside',
    });
    expect(script).toContain('oShell.Environment("Process")("QUOTED_VAR") = "value with ""quotes"" inside"');
  });

  it('should include self-delete statement at the end after Run line', () => {
    const script = buildLaunchScript(NODE_PATH, SCRIPT_PATH, {
      FOO: 'bar',
    });
    const lines = script.split('\r\n');
    // Find the Run line
    const runLineIndex = lines.findIndex(line => line.includes('oShell.Run'));
    const deleteLineIndex = lines.findIndex(line =>
      line.includes('CreateObject("Scripting.FileSystemObject").DeleteFile')
    );
    expect(deleteLineIndex).toBeGreaterThan(runLineIndex);
    expect(deleteLineIndex).toBe(lines.length - 1);
  });

  it('ignores an error of the self-delete only: On Error Resume Next sits right before it, after the Run line', () => {
    const lines = buildLaunchScript(NODE_PATH, SCRIPT_PATH, { FOO: 'bar' }).split('\r\n');
    const run = lines.findIndex((line) => line.includes('oShell.Run'));
    const del = lines.findIndex((line) => line.includes('DeleteFile'));
    expect(lines[del - 1]).toBe('On Error Resume Next');
    expect(del - 1).toBeGreaterThan(run);
    expect(lines.some((line, i) => i < run && /On Error/i.test(line))).toBe(false);
  });

  // The user saw a modal "Fichier introuvable" (800A0035) dialog when another process deleted the script before its last line ran
  it.skipIf(process.platform !== 'win32')('does not fail when the script file is already gone at the self-delete (no dialog); without the guard it does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'queue-vbs-'));
    try {
      const jsPath = join(dir, 'noop.js');
      writeFileSync(jsPath, '', 'utf-8');
      const generated = buildLaunchScript(process.execPath, jsPath, {});
      // A second self-delete after the first: the file is gone by then, exactly the situation of the dialog
      const secondDelete = '\r\nCreateObject("Scripting.FileSystemObject").DeleteFile WScript.ScriptFullName';
      const guarded = join(dir, 'guarded.vbs');
      const unguarded = join(dir, 'unguarded.vbs');
      writeFileSync(guarded, generated + secondDelete, 'utf-8');
      writeFileSync(unguarded, (generated + secondDelete).replace('On Error Resume Next\r\n', ''), 'utf-8');
      // cscript runs the same VBScript engine as wscript but never opens a dialog: a runtime error is PRINTED (language of the machine) and the exit code
      // stays 0, so the signal is any output at all (these scripts print nothing); wscript //B swallows errors silently and cannot tell them apart
      const output = (file: string): string => {
        const run = spawnSync('cscript.exe', ['//NoLogo', file], { windowsHide: true, timeout: 300_000, encoding: 'utf-8' });
        return `${run.stdout}${run.stderr}`.trim();
      };
      expect(output(unguarded), 'the control (no guard) must report an error, otherwise this test proves nothing').not.toBe('');
      expect(output(guarded)).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('should have proper VBScript structure', () => {
    const script = buildLaunchScript(NODE_PATH, SCRIPT_PATH, {
      FOO: 'bar',
    });
    expect(script).toMatch(/^Dim oShell\r\nSet oShell = CreateObject\("WScript\.Shell"\)/);
  });

  it.skipIf(process.platform !== 'win32')(
    'should delete its own vbs file after execution',
    async () => {
      // Create a temp directory for this test
      const testTmpDir = mkdtempSync(join(tmpdir(), 'queue-test-'));
      const testJsPath = join(testTmpDir, 'test-script.js');
      const vbsPath = join(testTmpDir, 'test-launch.vbs');

      // Write a minimal JS file in the test directory
      try {
        writeFileSync(testJsPath, 'console.log("test");', 'utf-8');

        // Build the launch script
        const script = buildLaunchScript(process.execPath, testJsPath, {});
        writeFileSync(vbsPath, script, 'utf-8');

        // Verify the file exists before launch
        expect(existsSync(vbsPath)).toBe(true);

        // Spawn the VBS file with wscript
        const { spawn } = require('node:child_process');
        const child = spawn('wscript.exe', [vbsPath], {
          stdio: 'ignore',
          windowsHide: true,
        });

        // Wait for the process to complete (the watchdog only guards against a hang, never a performance limit)
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('wscript did not exit within 5 minutes (hung?)'));
          }, 300_000);

          child.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });

          child.on('error', (error: Error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });

        // The VBS deletes itself as its last line: wait for that to be visible instead of sleeping
        await waitFor(`wscript deleting its own script ${vbsPath}`, () => !existsSync(vbsPath));

        // Assert that the VBS file no longer exists
        expect(existsSync(vbsPath)).toBe(false);
      } finally {
        // Clean up test directory (Windows may hold a file for a moment after the process exited)
        rmSync(testTmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  );
});

describe('spawnDetachedProcess', () => {
  it('should keep the same public signature', () => {
    // Verify the function accepts the expected parameters
    expect(spawnDetachedProcess.length).toBe(2);
  });
});
