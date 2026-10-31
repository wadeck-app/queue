import { describe, it, expect } from 'vitest';
import { createActionRegistry } from './createActionRegistry.js';
import { findActionCycles, type CycleSubscriber } from './findActionCycles.js';
import type { ActionPlugin } from './ActionPlugin.js';

const registry = createActionRegistry();

function emitSub(name: string, listensTo: string, emits: string, extra: Partial<CycleSubscriber> = {}): CycleSubscriber {
  return { subscriberId: name, event: listensTo, type: 'action', action: 'emit', with: { event: emits }, ...extra };
}

describe('findActionCycles', () => {
  it('finds nothing in a chain that ends', () => {
    expect(findActionCycles([emitSub('a', 'on.a', 'on.b'), emitSub('b', 'on.b', 'on.c')], registry)).toEqual([]);
  });

  it('reports a two-action cycle without any when as an error that names the chain', () => {
    const findings = findActionCycles([emitSub('a', 'on.a', 'on.b'), emitSub('b', 'on.b', 'on.a')], registry);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.subscribers).toEqual(['a', 'b']);
    expect(findings[0]!.message).toContain("'a' (listens to 'on.a', emits 'on.b') -> 'b' (listens to 'on.b', emits 'on.a') -> back to 'a'");
    expect(findings[0]!.message).toContain('Fix:');
  });

  it('reports an action that listens to the event it emits', () => {
    const findings = findActionCycles([emitSub('self', 'on.x', 'on.x')], registry);
    expect(findings.map((f) => f.severity)).toEqual(['error']);
    expect(findings[0]!.subscribers).toEqual(['self']);
  });

  it('turns the error into a warning when a subscriber of the cycle has a when', () => {
    const findings = findActionCycles([emitSub('a', 'on.a', 'on.b'), emitSub('b', 'on.b', 'on.a', { when: 'payload.again == true' })], registry);
    expect(findings.map((f) => f.severity)).toEqual(['warning']);
    expect(findings[0]!.message).toContain('possible action loop');
  });

  it('a global > action with a when is a warning, not an error (it matches its own emitted event)', () => {
    const findings = findActionCycles([emitSub('mirror', '>', 'agent.message', { when: 'event == "on.ci"' })], registry);
    expect(findings.map((f) => f.severity)).toEqual(['warning']);
  });

  it('a global > action without a when is an error', () => {
    expect(findActionCycles([emitSub('mirror', '>', 'agent.message')], registry).map((f) => f.severity)).toEqual(['error']);
  });

  it('a wildcard pattern closes a cycle through another action', () => {
    const findings = findActionCycles([emitSub('a', 'on.*', 'build.done'), emitSub('b', 'build.>', 'on.again')], registry);
    expect(findings.map((f) => f.severity)).toEqual(['error']);
    expect(findings[0]!.subscribers.slice().sort()).toEqual(['a', 'b']);
  });

  it('reports one error, not a second warning, when a cycle without when shares nodes with a cycle through a when', () => {
    const findings = findActionCycles(
      [emitSub('a', 'x', 'y'), emitSub('b', 'y', 'x'), emitSub('c', 'y', 'z', { when: 'payload.k == 1' }), emitSub('d', 'z', 'x')],
      registry,
    );
    expect(findings.map((f) => f.severity)).toEqual(['error']);
  });

  it('does not follow an edge into the file of a descendant project (the default direction does not go down)', () => {
    const findings = findActionCycles(
      [
        emitSub('parent-action', 'on.a', 'on.b', { projectId: 'aaaaaaaa' }),
        emitSub('child-action', 'on.b', 'on.a', { projectId: 'bbbbbbbb' }),
      ],
      registry,
      { chains: new Map([['aaaaaaaa', ['aaaaaaaa']], ['bbbbbbbb', ['aaaaaaaa', 'bbbbbbbb']]]) },
    );
    // parent -> child is not an edge (the child's file is not reached from the parent); child -> parent is one
    expect(findings).toEqual([]);
  });

  it('follows the edge from a child to the file of its ancestor, and both ways inside one project', () => {
    const chains = new Map([['aaaaaaaa', ['aaaaaaaa']], ['bbbbbbbb', ['aaaaaaaa', 'bbbbbbbb']]]);
    expect(findActionCycles([emitSub('p', 'on.a', 'on.b', { projectId: 'bbbbbbbb' }), emitSub('q', 'on.b', 'on.a', { projectId: 'aaaaaaaa' })], registry, { chains })).toEqual([]);
    expect(findActionCycles([emitSub('p', 'on.a', 'on.b', { projectId: 'bbbbbbbb' }), emitSub('q', 'on.b', 'on.a', { projectId: 'bbbbbbbb' })], registry, { chains }).map((f) => f.severity)).toEqual(['error']);
  });

  it('two sibling projects never reach each other', () => {
    const chains = new Map([['aaaaaaaa', ['aaaaaaaa']], ['bbbbbbbb', ['bbbbbbbb']]]);
    const findings = findActionCycles([emitSub('p', 'on.a', 'on.b', { projectId: 'aaaaaaaa' }), emitSub('q', 'on.b', 'on.a', { projectId: 'bbbbbbbb' })], registry, { chains });
    expect(findings).toEqual([]);
  });

  it('a state machine whose steps are told apart by a when is a warning at most', () => {
    const findings = findActionCycles(
      [
        emitSub('step1', 'job.state', 'job.state', { when: 'payload.state == "queued"' }),
        emitSub('step2', 'job.state', 'job.state', { when: 'payload.state == "running"' }),
      ],
      registry,
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.severity === 'warning')).toBe(true);
  });

  it('ignores cli and http subscribers, to-children descendants and subscribers with a configuration problem', () => {
    const findings = findActionCycles(
      [
        { subscriberId: 'c', event: 'on.a', type: 'cli' },
        emitSub('d', 'on.a', 'on.a', { fromDescendant: true, projectId: 'bbbbbbbb' }),
        emitSub('e', 'on.a', 'on.a', { configProblem: 'unknown action' }),
        { subscriberId: 'f', event: 'on.a', type: 'action', action: 'not-registered', with: {} },
      ],
      registry,
    );
    expect(findings).toEqual([]);
  });

  it('uses the emits() of the plugin, so a plugin with a fixed event takes part', () => {
    const preset: ActionPlugin = {
      name: 'ping',
      validate: () => undefined,
      emits: () => 'agent.message',
      run: async () => ({ success: true }),
    };
    const findings = findActionCycles([{ subscriberId: 'p', event: 'agent.*', type: 'action', action: 'ping', with: {} }], createActionRegistry([preset]));
    expect(findings.map((f) => f.severity)).toEqual(['error']);
  });

  it('says which plugin threw when emits() throws', () => {
    const broken: ActionPlugin = { name: 'broken', validate: () => undefined, emits: () => { throw new Error('boom'); }, run: async () => ({ success: true }) };
    expect(() => findActionCycles([{ subscriberId: 'x', event: 'a', type: 'action', action: 'broken', with: {} }], createActionRegistry([broken]))).toThrow(/'broken' threw.*boom/);
  });
});
