import { spawn } from 'node:child_process';
import type { EventEnvelope } from '../types.js';
import { getErrorMessage } from '../errors.js';

export interface DispatchResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs: number;
}

/**
 * Interpolate {{ payload.field }} and {{ field }} placeholders in a command string.
 * Allows subscribers.yml to reference payload fields directly in the command,
 * e.g.: flow run triage.yml --input taskId={{ payload.taskId }}
 */
function interpolateCommand(command: string, envelope: EventEnvelope): string {
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  return command.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const key = path.startsWith('payload.') ? path.slice('payload.'.length) : path;
    const value = payload[key];
    return value !== undefined && value !== null ? String(value) : '';
  });
}

export class CliTransport {
  async dispatch(command: string, envelope: EventEnvelope, timeoutMs: number): Promise<DispatchResult> {
    const start = Date.now();
    const interpolatedCommand = interpolateCommand(command, envelope);

    return new Promise<DispatchResult>((resolve) => {
      const child = spawn(interpolatedCommand, [], { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      child.on('close', (code) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;

        if (timedOut) {
          resolve({ success: false, error: `timeout after ${Math.round(timeoutMs / 1000)}s`, stdout, stderr, durationMs });
          return;
        }

        if (code === 0) {
          resolve({ success: true, stdout, stderr, durationMs });
        } else {
          resolve({ success: false, error: `exited with code ${code}`, stdout, stderr, durationMs });
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ success: false, error: getErrorMessage(err), durationMs: Date.now() - start });
      });

      try {
        child.stdin.write(JSON.stringify(envelope) + '\n');
        child.stdin.end();
      } catch {
        // stdin may already be closed
      }
    });
  }
}
