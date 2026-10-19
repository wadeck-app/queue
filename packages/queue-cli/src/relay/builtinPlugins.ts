import githubPlugin from '@wadeck-app/plugin-github';
import type { RelayPlugin } from '@wadeck-app/queue-relay-client';

/** The relay plugins shipped inside the CLI: the relay daemon registers them, the webhook history reads their summaries. */
export const BUILTIN_RELAY_PLUGINS: ReadonlyArray<{ name: string; aliases: string[]; plugin: RelayPlugin }> = [
  { name: '@wadeck-app/plugin-github', aliases: ['github'], plugin: githubPlugin },
];
