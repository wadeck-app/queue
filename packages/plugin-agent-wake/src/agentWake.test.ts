import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HistoryReader, createActionRegistry, createQueueService, findActionCycles, readCatalog, validateSourceDeclaration,
  type ActionContext, type ActionPushResult, type EventEnvelope,
} from '@wadeck-app/queue-core';
import { agentWakeAction, AGENT_MESSAGE_EVENT, MAX_TEXT_BYTES } from './agentWake.js';

const SESSION = '3f2b8c1e-5a47-4d9e-9b1a-0c6d2e7f8a90';

const envelope: EventEnvelope = {
  id: 'wal-id',
  timestamp: '2026-01-02T03:04:05.000Z',
  event: 'on.github.check_run',
  payload: { branch: 'main', session: SESSION, folder: 'Mon projet (été)', empty: '', multi: 'a\nb', big: 'x'.repeat(MAX_TEXT_BYTES + 1) },
  meta: { eventId: 'first-push' },
};

function context(result: ActionPushResult = { success: true, eventId: 'new-id' }): ActionContext & { push: ReturnType<typeof vi.fn> } {
  return { push: vi.fn().mockResolvedValue(result) };
}

const validate = (config: Record<string, unknown>): string | undefined => agentWakeAction.validate(config, { event: 'onX' });

describe('agent-wake: validate (when the configuration is loaded)', () => {
  it.each([
    [{ to: SESSION, text: 'hi' }],
    [{ to: SESSION.toUpperCase(), text: 'hi' }],
    [{ to: 'project:my-app', text: 'hi' }],
    [{ to: 'project:Mon projet (été) v2', text: 'hi' }],
    [{ to: `project:${'p'.repeat(200)}`, text: 'hi' }],
    [{ to: '{{ payload.session }}', text: 'CI failed on {{ payload.branch }}' }],
    [{ to: 'project:{{ payload.folder }}', text: 'hi' }],
    [{ to: 'project:x', text: 'hi', from: 'queue:ci', mode: 'passive', ref: 'fixed-ref' }],
    [{ to: 'project:x', text: 'hi', mode: 'wake' }],
  ])('accepts %j', (config) => {
    expect(validate(config)).toBeUndefined();
  });

  it.each([
    [{}, /'to' is required/],
    [{ text: 'hi' }, /'to' is required/],
    [{ to: '', text: 'hi' }, /'to' is required/],
    [{ to: 5, text: 'hi' }, /'to' is required/],
    [{ to: 'my-app', text: 'hi' }, /'to' must be a session id/],
    [{ to: 'project:', text: 'hi' }, /'to' must be a session id/],
    [{ to: 'project:   ', text: 'hi' }, /'to' must be a session id/],
    [{ to: `project:${'p'.repeat(201)}`, text: 'hi' }, /'to' must be a session id/],
    [{ to: 'project:a\nb', text: 'hi' }, /'to' must be a session id/],
    [{ to: 'project:a\tb', text: 'hi' }, /'to' must be a session id/],
    [{ to: 'project:a\u2028b', text: 'hi' }, /'to' must be a session id/],
    [{ to: 'project:a\u0085b', text: 'hi' }, /'to' must be a session id/],
    [{ to: 'session {{ payload.session }}', text: 'hi' }, /template has to start with a placeholder/],
    [{ to: '{{ session }}', text: 'hi' }, /payload\.session/],
    [{ to: SESSION }, /'text' is required/],
    [{ to: SESSION, text: '' }, /'text' is required/],
    [{ to: SESSION, text: 7 }, /'text' is required/],
    [{ to: SESSION, text: 'x'.repeat(MAX_TEXT_BYTES + 1) }, /over the 16384 bytes/],
    [{ to: SESSION, text: '{{ text }}' }, /'text'.*payload\.text/],
    [{ to: SESSION, text: 'hi', from: '' }, /'from' must be a non-empty string/],
    [{ to: SESSION, text: 'hi', from: 'a\nb' }, /'from' must be one line/],
    [{ to: SESSION, text: 'hi', from: 3 }, /'from' must be a non-empty string/],
    [{ to: SESSION, text: 'hi', from: 'f'.repeat(201) }, /'from' is 201 characters/],
    [{ to: SESSION, text: 'hi', ref: 'r'.repeat(201) }, /'ref' is 201 characters/],
    [{ to: SESSION, text: 'hi', mode: 'loud' }, /'mode' must be one of wake, passive/],
    [{ to: SESSION, text: 'hi', mode: '{{ payload.mode }}' }, /'mode' must be one of wake, passive.*a payload must not choose it/],
    [{ to: SESSION, text: 'hi', priority: 'high' }, /unknown field 'priority' in 'with' \(allowed: to, text, from, mode, ref\)/],
  ])('refuses %j', (config, message) => {
    expect(validate(config)).toMatch(message);
  });
});

describe('agent-wake: run', () => {
  it('pushes agent.message with the defaults: from queue:<event>, mode wake, ref = the id of the first push', async () => {
    const ctx = context();
    const result = await agentWakeAction.run({ to: 'project:my-app', text: 'CI failed on {{ payload.branch }}' }, envelope, ctx);
    expect(ctx.push).toHaveBeenCalledWith({
      event: AGENT_MESSAGE_EVENT,
      payload: { to: 'project:my-app', text: 'CI failed on main', from: 'queue:on.github.check_run', mode: 'wake', ref: 'first-push' },
    });
    expect(result.success).toBe(true);
    expect(result.detail).toContain('new-id');
    // The text and the recipient never reach the log line
    expect(result.detail).not.toContain('CI failed');
    expect(result.detail).not.toContain('my-app');
  });

  it('the ref default is the id of the first push, not the WAL id of a retry', async () => {
    const ctx = context();
    await agentWakeAction.run({ to: 'project:x', text: 't' }, { ...envelope, id: 'another-wal-id' }, ctx);
    expect((ctx.push.mock.calls[0]![0] as { payload: { ref: string } }).payload.ref).toBe('first-push');
  });

  it('falls back to the envelope id when the event carries no meta.eventId', async () => {
    const ctx = context();
    await agentWakeAction.run({ to: 'project:x', text: 't' }, { ...envelope, meta: {} }, ctx);
    expect((ctx.push.mock.calls[0]![0] as { payload: { ref: string } }).payload.ref).toBe('wal-id');
  });

  it('honours an explicit from, mode and ref (rendered)', async () => {
    const ctx = context();
    await agentWakeAction.run({ to: SESSION, text: 't', from: 'queue:ci-{{ payload.branch }}', mode: 'passive', ref: 'r-{{ payload.branch }}' }, envelope, ctx);
    expect(ctx.push.mock.calls[0]![0]).toEqual({ event: AGENT_MESSAGE_EVENT, payload: { to: SESSION, text: 't', from: 'queue:ci-main', mode: 'passive', ref: 'r-main' } });
  });

  describe('a recipient rendered from the payload', () => {
    it('accepts a rendered session id and a rendered project with spaces, parentheses and accents', async () => {
      const bySession = context();
      expect((await agentWakeAction.run({ to: '{{ payload.session }}', text: 't' }, envelope, bySession)).success).toBe(true);
      expect((bySession.push.mock.calls[0]![0] as { payload: { to: string } }).payload.to).toBe(SESSION);

      const byProject = context();
      expect((await agentWakeAction.run({ to: 'project:{{ payload.folder }}', text: 't' }, envelope, byProject)).success).toBe(true);
      expect((byProject.push.mock.calls[0]![0] as { payload: { to: string } }).payload.to).toBe('project:Mon projet (été)');
    });

    it.each([
      ['a payload field that is not a recipient', { to: '{{ payload.branch }}', text: 't' }, /with\.to.*'to' must be a session id/],
      ['a missing payload field (rendered empty)', { to: '{{ payload.nope }}', text: 't' }, /with\.to/],
      ['project: followed by an empty field', { to: 'project:{{ payload.empty }}', text: 't' }, /with\.to.*'to' must be a session id/],
      ['a line break in the project name', { to: 'project:{{ payload.multi }}', text: 't' }, /with\.to.*'to' must be a session id/],
    ])('refuses %s, permanently, naming the field and without echoing the payload', async (_name, config, message) => {
      const ctx = context();
      const result = await agentWakeAction.run(config, envelope, ctx);
      expect(result).toMatchObject({ success: false, permanent: true });
      expect(result.error).toMatch(message);
      expect(ctx.push).not.toHaveBeenCalled();
    });
  });

  it.each([
    ['text rendered empty', { to: SESSION, text: '{{ payload.empty }}' }, /with\.text.*rendered empty/],
    ['text over the cap once rendered', { to: SESSION, text: '{{ payload.big }}' }, /with\.text.*16384 bytes/],
    ['from rendered with a line break', { to: SESSION, text: 't', from: '{{ payload.multi }}' }, /with\.from.*line break/],
    ['ref rendered empty', { to: SESSION, text: 't', ref: '{{ payload.empty }}' }, /with\.ref.*rendered empty/],
  ])('refuses %s, permanently', async (_name, config, message) => {
    const ctx = context();
    const result = await agentWakeAction.run(config, envelope, ctx);
    expect(result).toMatchObject({ success: false, permanent: true });
    expect(result.error).toMatch(message);
    expect(ctx.push).not.toHaveBeenCalled();
  });

  it('refuses a misconfigured config at run time too (the last line before the push)', async () => {
    const ctx = context();
    const result = await agentWakeAction.run({ to: 'nope', text: 't' }, envelope, ctx);
    expect(result).toMatchObject({ success: false, permanent: true });
    expect(result.error).toContain('misconfigured');
    expect(ctx.push).not.toHaveBeenCalled();
  });

  it('passes on a refusal of the daemon: permanent stays permanent, a transient one stays retryable', async () => {
    expect(await agentWakeAction.run({ to: SESSION, text: 't' }, envelope, context({ success: false, error: 'loop guard', permanent: true }))).toEqual({ success: false, error: 'loop guard', permanent: true });
    expect(await agentWakeAction.run({ to: SESSION, text: 't' }, envelope, context({ success: false, error: 'aborted' }))).toEqual({ success: false, error: 'aborted' });
  });
});

describe('agent-wake: what it declares', () => {
  it('emits agent.message whatever the configuration', () => {
    expect(agentWakeAction.emits?.({})).toBe('agent.message');
    expect(agentWakeAction.emits?.({ to: SESSION, text: 't' })).toBe('agent.message');
  });

  it('has a catalog entry with the agreed text that the daemon accepts', () => {
    const [declared] = agentWakeAction.events!;
    expect(declared!.name).toBe('agent.message');
    expect(declared!.description).toBe('agent.message { to, text, from?, mode?, ref? }: wake an idle Claude Code session (to = session id or project:<folder>)');
    expect(validateSourceDeclaration({ source: 'action-agent-wake', events: agentWakeAction.events })).toMatchObject({ ok: true });
  });

  it('takes part in the loop check: a subscriber that listens to agent.* and wakes agents is a loop', () => {
    const registry = createActionRegistry([agentWakeAction]);
    const findings = findActionCycles([{ subscriberId: 'w', event: 'agent.>', type: 'action', action: 'agent-wake', with: { to: SESSION, text: 't' } }], registry);
    expect(findings.map((finding) => finding.severity)).toEqual(['error']);
  });
});

describe('agent-wake end to end through QueueService with a real subscribers.yml', () => {
  let configDir: string;
  let projectDir: string;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'agent-wake-config-'));
    projectDir = mkdtempSync(join(tmpdir(), 'agent-wake-project-'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(projectDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // Polls until the condition holds; the deadline only guards against a test that hangs, it is not a performance limit
  async function until<T>(what: string, read: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 120_000;
    for (;;) {
      const value = read();
      if (value !== undefined) {
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for ' + what);
      }
    }
  }

  const SUBSCRIBERS = [
    'subscribers:',
    '  on.ci.failed:',
    '    - type: action',
    '      name: wake-owner',
    '      action: agent-wake',
    '      with:',
    '        to: project:my-app',
    '        text: "CI failed on {{ payload.branch }}: {{ payload.title }}"',
    '        mode: passive',
    '  on.ci.dynamic:',
    '    - type: action',
    '      name: wake-dynamic',
    '      action: agent-wake',
    '      with:',
    '        to: "{{ payload.to }}"',
    '        text: "{{ payload.text }}"',
    '',
  ].join('\n');

  it('a source event wakes a session: agent.message is recorded with the rendered payload and the default ref', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), SUBSCRIBERS);
    const service = createQueueService(configDir, { actions: createActionRegistry([agentWakeAction]) });
    service.onStart();
    const pushed = await service.commands.push({ event: 'on.ci.failed', payload: { branch: 'main', title: 'build' }, cwd: projectDir });
    expect(pushed).toMatchObject({ status: 'queued', subscriberCount: 1 });
    const sourceId = (pushed as { eventId: string }).eventId;

    const history = new HistoryReader(join(configDir, 'history'));
    const message = await until('agent.message in the history', () => history.read({ event: AGENT_MESSAGE_EVENT })[0]);
    expect(message.payload).toEqual({ to: 'project:my-app', text: 'CI failed on main: build', from: 'queue:on.ci.failed', mode: 'passive', ref: sourceId });
    const source = await until('the action to be recorded as delivered', () => {
      const entry = history.read({ event: 'on.ci.failed' })[0];
      return entry?.subscribers.some((sub) => sub.status === 'success') ? entry : undefined;
    });
    expect(source.subscribers[0]).toMatchObject({ subscriberId: 'wake-owner', target: 'action:agent-wake' });
  });

  it('declares agent.message in the event catalog when the daemon starts', () => {
    writeFileSync(join(configDir, 'subscribers.yml'), SUBSCRIBERS);
    createQueueService(configDir, { actions: createActionRegistry([agentWakeAction]) }).onStart();
    const catalog = readCatalog(configDir);
    expect(catalog.sources.map((source) => source.source)).toEqual(['action-agent-wake']);
    expect(catalog.sources[0]!.events[0]!.name).toBe('agent.message');
  });

  it('a payload that names a recipient which is not a session or a project ends in the DLQ at once, and nothing is emitted', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), SUBSCRIBERS);
    const service = createQueueService(configDir, { actions: createActionRegistry([agentWakeAction]) });
    await service.commands.push({ event: 'on.ci.dynamic', payload: { to: 'everyone', text: 'hi' }, cwd: projectDir });
    const dlq = await until('the entry in the DLQ', () => {
      const entries = (service.commands['dlq-list']() as { entries: Array<{ lastError: string; attempts: number }> }).entries;
      return entries.length === 1 ? entries[0] : undefined;
    });
    expect(dlq.lastError).toContain('with.to');
    expect(dlq.attempts).toBe(1);
    expect(new HistoryReader(join(configDir, 'history')).read({ event: AGENT_MESSAGE_EVENT })).toEqual([]);
  });

  it('refuses the file at load time when the with block is wrong, naming the subscriber', async () => {
    writeFileSync(join(configDir, 'subscribers.yml'), 'subscribers:\n  on.x:\n    - { type: action, name: bad, action: agent-wake, with: { to: nobody, text: hi } }\n');
    const service = createQueueService(configDir, { actions: createActionRegistry([agentWakeAction]) });
    const response = await service.commands.push({ event: 'on.x', payload: {}, cwd: projectDir });
    expect(response).toMatchObject({ status: 'aborted' });
    expect((response as { reason: string }).reason).toMatch(/action 'agent-wake'.*'to' must be a session id/);
  });
});
