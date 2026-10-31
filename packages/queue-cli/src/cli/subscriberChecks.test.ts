import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSourceDeclaration, type SubscriberConfig } from '@wadeck-app/queue-core';
import { addProject, projectToolDir } from '@wadeck-app/project-sdk';
import { createBuiltinActionRegistry } from '../actions/builtinActions.js';
import { actionEntryProblems, checkActionLoops, undeclaredEventWarning } from './subscriberChecks.js';

const actions = createBuiltinActionRegistry();

describe('actionEntryProblems', () => {
  it('has nothing to say about a cli subscriber', () => {
    expect(actionEntryProblems({ type: 'cli', command: 'echo' }, 'onX', actions)).toEqual([]);
  });

  it('accepts a valid emit', () => {
    expect(actionEntryProblems({ type: 'action', name: 'a', action: 'emit', with: { event: 'agent.message' } }, 'onX', actions)).toEqual([]);
  });

  it('lists the available actions when --action is missing', () => {
    const [problem] = actionEntryProblems({ type: 'action', name: 'a' }, 'onX', actions);
    expect(problem).toContain('--action is required');
    expect(problem).toContain('emit');
  });

  it('names the available actions for an unknown one', () => {
    const [problem] = actionEntryProblems({ type: 'action', name: 'a', action: 'nope' }, 'onX', actions);
    expect(problem).toContain('unknown action "nope"');
    expect(problem).toContain('Available actions: emit');
  });

  it('returns what the plugin refuses, with the flags to fix', () => {
    const [problem] = actionEntryProblems({ type: 'action', name: 'a', action: 'emit', with: { event: 'agent.*' } }, 'onX', actions);
    expect(problem).toContain("action 'emit'");
    expect(problem).toContain('concrete event name');
    expect(problem).toContain('--set');
  });
});

describe('checks that read the disk', () => {
  let configDir: string;
  let registryDir: string;
  let projectDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'sub-checks-config-'));
    registryDir = mkdtempSync(join(tmpdir(), 'sub-checks-registry-'));
    projectDir = mkdtempSync(join(tmpdir(), 'sub-checks-project-'));
  });

  afterEach(() => {
    for (const dir of [configDir, registryDir, projectDir]) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  const emitEntry = (name: string, to: string): SubscriberConfig => ({ type: 'action', name, action: 'emit', with: { event: to } });

  describe('undeclaredEventWarning', () => {
    it('warns when no program declared the emitted event', () => {
      expect(undeclaredEventWarning(emitEntry('a', 'agent.message'), actions, configDir)).toContain("emits 'agent.message'");
    });

    it('says nothing once the event is in the catalog, nor for an entry that is not an action', () => {
      writeSourceDeclaration(configDir, { source: 'w-agent-wake', events: [{ name: 'agent.message', description: 'wake a session' }] });
      expect(undeclaredEventWarning(emitEntry('a', 'agent.message'), actions, configDir)).toBeUndefined();
      expect(undeclaredEventWarning({ type: 'cli', command: 'x' }, actions, configDir)).toBeUndefined();
    });
  });

  describe('checkActionLoops', () => {
    const base = () => ({ configDir, registryDir, cwd: projectDir, scope: 'global' as const, filePath: join(configDir, 'subscribers.yml'), actions });

    it('refuses a new action that closes a loop with the one already in the file', () => {
      const result = checkActionLoops({ ...base(), after: { onA: [emitEntry('a', 'onB')], onB: [emitEntry('b', 'onA')] }, changed: { event: 'onB', name: 'b' } });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('action loop');
      expect(result.warnings).toEqual([]);
    });

    it('a when: on the new action makes it a warning', () => {
      const result = checkActionLoops({
        ...base(),
        after: { onA: [emitEntry('a', 'onB')], onB: [{ ...emitEntry('b', 'onA'), when: 'payload.again=true' }] },
        changed: { event: 'onB', name: 'b' },
      });
      expect(result.errors).toEqual([]);
      expect(result.warnings).toHaveLength(1);
    });

    it('finds the loop through a subscribers.yml that is not the one being written (the global file seen from a project)', async () => {
      const project = await addProject(registryDir, { name: 'app', path: projectDir });
      writeFileSync(join(configDir, 'subscribers.yml'), 'subscribers:\n  onA:\n    - { type: action, name: a, action: emit, with: { event: onB } }\n');
      const projectFile = join(projectToolDir(registryDir, project.id, 'queue', 'config', { ensure: true }), 'subscribers.yml');
      const result = checkActionLoops({
        ...base(),
        scope: 'project',
        filePath: projectFile,
        after: { onB: [emitEntry('b', 'onA')] },
        changed: { event: 'onB', name: 'b' },
      });
      expect(result.errors).toHaveLength(1);
    });

    it('does not blame the change for a loop it is not part of', () => {
      const result = checkActionLoops({
        ...base(),
        after: { onA: [emitEntry('a', 'onB')], onB: [emitEntry('b', 'onA')], onZ: [emitEntry('z', 'onY')] },
        changed: { event: 'onZ', name: 'z' },
      });
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('says a file it could not read instead of skipping it silently', () => {
      writeFileSync(join(configDir, 'subscribers.yml'), 'subscribers: [broken\n');
      mkdirSync(join(configDir, 'other'), { recursive: true });
      const result = checkActionLoops({ ...base(), scope: 'project', filePath: join(configDir, 'other', 'subscribers.yml'), after: { onB: [emitEntry('b', 'onA')] }, changed: { event: 'onB', name: 'b' } });
      expect(result.notes.join(' ')).toContain('could not be read for the loop check');
    });
  });
});
