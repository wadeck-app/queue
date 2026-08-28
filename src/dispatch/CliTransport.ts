import { spawn } from 'node:child_process';
import type { EventEnvelope } from '../types.js';

export interface DispatchResult {
  success: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs: number;
}

export class CliTransport {
  async dispatch(command: string, envelope: EventEnvelope, timeoutMs: number): Promise<DispatchResult> {
    const start = Date.now();

    return new Promise<DispatchResult>((resolve) => {
      const child = spawn(command, [], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });

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
        resolve({ success: false, error: err.message, durationMs: Date.now() - start });
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
