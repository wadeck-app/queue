import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Creates a fake `queue` executable in a directory: `queue.cmd` on Windows, an executable shell script elsewhere. It records
// its arguments and the QUEUE_CONFIG_DIR it saw into `logFile`, then exits with `exitCode`. Test helper only.

export interface FakeQueueOptions {
  exitCode: number;
  logFile: string;
}

export function makeFakeQueue(binDir: string, options: FakeQueueOptions): string {
  mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const path = join(binDir, 'queue.cmd');
    const lines = ['@echo off', `echo args=%*> "${options.logFile}"`, `echo config=%QUEUE_CONFIG_DIR%>> "${options.logFile}"`, `exit /b ${options.exitCode}`];
    writeFileSync(path, `${lines.join('\r\n')}\r\n`);
    return path;
  }
  const path = join(binDir, 'queue');
  const lines = ['#!/bin/sh', `echo "args=$*" > "${options.logFile}"`, `echo "config=$QUEUE_CONFIG_DIR" >> "${options.logFile}"`, `exit ${options.exitCode}`];
  writeFileSync(path, `${lines.join('\n')}\n`);
  chmodSync(path, 0o755);
  return path;
}
