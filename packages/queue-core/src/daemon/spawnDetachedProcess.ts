import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Spawns `node <scriptPath>` fully detached from the current process, with no
 * visible console window on Windows. Plain `spawn(..., { windowsHide: true })`
 * is unreliable on Windows regardless of process-tree depth; wscript.exe's
 * SW_HIDE hides the window at the Win32 API level instead. See
 * docs/windows-hidden-process.md. Extracted so both the CLI's own daemon
 * spawn and the relay client's "wake the sleeping daemon" path share one
 * implementation instead of duplicating the Windows-hiding trick.
 */
export function spawnDetachedProcess(scriptPath: string, env: Record<string, string>): void {
  const childEnv = { ...process.env, ...env };

  if (process.platform === 'win32') {
    const vbsPath = join(tmpdir(), `queue-spawn-${Date.now()}-${Math.random().toString(36).slice(2)}.vbs`);
    const safeNode = process.execPath.replace(/"/g, '""');
    const safeScript = scriptPath.replace(/"/g, '""');
    const envLines = Object.entries(env).map(
      ([key, value]) => `oShell.Environment("Process")("${key}") = "${value.replace(/"/g, '""')}"`
    );
    writeFileSync(vbsPath, [
      'Dim oShell',
      'Set oShell = CreateObject("WScript.Shell")',
      ...envLines,
      `oShell.Run """${safeNode}"" ""${safeScript}""", 0, False`,
    ].join('\r\n'));
    const child = spawn('wscript.exe', [vbsPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: childEnv,
    });
    child.unref();
  } else {
    const child = spawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: 'ignore',
      env: childEnv,
    });
    child.unref();
  }
}
