import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { buildLaunchScript, spawnDetachedProcess } from './spawnDetachedProcess';

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
      const testTmpDir = join(tmpdir(), `queue-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const testJsPath = join(testTmpDir, 'test-script.js');
      const vbsPath = join(testTmpDir, 'test-launch.vbs');

      // Create test directory and a minimal JS file
      try {
        if (!existsSync(testTmpDir)) {
          require('node:fs').mkdirSync(testTmpDir, { recursive: true });
        }
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

        // Wait for the process to complete (max 5 seconds)
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('Timeout waiting for wscript process'));
          }, 5000);

          child.on('exit', () => {
            clearTimeout(timeout);
            resolve();
          });

          child.on('error', (error: Error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });

        // Give the VBS a bit more time to delete itself
        await new Promise(resolve => setTimeout(resolve, 200));

        // Assert that the VBS file no longer exists
        expect(existsSync(vbsPath)).toBe(false);
      } finally {
        // Clean up test directory
        try {
          if (existsSync(testJsPath)) {
            unlinkSync(testJsPath);
          }
          if (existsSync(vbsPath)) {
            unlinkSync(vbsPath);
          }
          if (existsSync(testTmpDir)) {
            require('node:fs').rmdirSync(testTmpDir);
          }
        } catch {
          // Ignore cleanup errors
        }
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
