/**
 * The relay.yml example is written once (relayYmlTemplate.ts): the relay help, `queue relay start` and `queue relay webhook ...` show the same lines,
 * and the relay help names only the sources that exist (GitHub, GitLab).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RELAY_YML_TEMPLATE_LINES, missingRelayYmlMessage } from './relayYmlTemplate.js';
import { relayStart, type RelayStartDeps } from './relayStart.js';
import { RELAY_GROUP_HELP, usageText } from './QueueIndex.js';

describe('the relay.yml example', () => {
  it('is the same text in `queue relay --help` and in the missing-relay.yml message of `queue relay start`', async () => {
    const stderr: string[] = [];
    const deps = {
      client: { isRunning: vi.fn().mockResolvedValue(false) },
      loadConfig: vi.fn().mockReturnValue(null),
      io: { stdout: { write: vi.fn() }, stderr: { write: (s: string) => { stderr.push(s); } } },
    } as unknown as RelayStartDeps;

    expect(await relayStart(deps, '/cfg')).toBe(1);

    const started = stderr.join('');
    expect(started).toContain(missingRelayYmlMessage('/cfg'));
    for (const line of RELAY_YML_TEMPLATE_LINES) {
      expect(RELAY_GROUP_HELP, `help is missing: ${line}`).toContain(`  ${line}\n`);
      expect(started, `queue relay start is missing: ${line}`).toContain(`  ${line}\n`);
    }
  });

  it('the relay help names GitHub and GitLab only: Slack and Jira sources do not exist', () => {
    expect(RELAY_GROUP_HELP).toContain('GitHub/GitLab webhook relay client');
    expect(RELAY_GROUP_HELP).not.toMatch(/slack|jira/i);
    expect(usageText()).not.toMatch(/slack|jira/i);
  });

  it('the GitLab events the help gives as examples have a fixture in the plugin tests (none was seen on a real delivery, so a documented shape is the minimum)', () => {
    const pluginTests = readFileSync(fileURLToPath(new URL('../../../plugin-gitlab/src/summarize.test.ts', import.meta.url)), 'utf8');
    const examples = [...RELAY_GROUP_HELP.matchAll(/on\.gitlab\.([a-z_]+)/g)].map((match) => match[1]!);

    expect(examples.length).toBeGreaterThan(0);
    for (const type of examples) {
      expect(pluginTests, `the help advertises on.gitlab.${type} but plugin-gitlab's summarize tests have no object_kind: '${type}' fixture`).toContain(`object_kind: '${type}'`);
    }
  });
});
