/**
 * The relay.yml example, in one place: `queue relay --help`, `queue relay start` and `queue relay webhook ...` all show it
 * when there is no relay.yml, and must never drift apart.
 */
export const RELAY_YML_TEMPLATE_LINES: readonly string[] = [
  'relayUrl: wss://<relay-host>/relay-ws',
  'plugins:',
  "  - module: '@wadeck-app/plugin-github'",
  '    subscriptions:',
  // payloadMatch: the relay compares top-level keys only; the client also resolves dotted keys (max 8 segments, strict equality)
  '      - eventType: [push, pull_request]',
  '        # payloadMatch compares payload keys by equality; a dotted key (repository.full_name) is checked by this client only, the relay itself only sees top-level keys',
  '        payloadMatch: { action: opened }',
];

/** The template, every line indented by `indent`. */
export function relayYmlTemplate(indent: string): string {
  return RELAY_YML_TEMPLATE_LINES.map((line) => `${indent}${line}\n`).join('');
}

/** The sentence block that follows the template: where the relay token lives. */
export const RELAY_TOKEN_NOTE = `The relay token is stored in <QUEUE_CONFIG_DIR>/_secrets_/.env.local:
  QUEUE_RELAY_TOKEN=<your-relay-consumer-token>
See 'queue relay --help' for more details.
`;

/** What every command that needs relay.yml says when it is missing (the caller prefixes nothing, writes it to stderr). */
export function missingRelayYmlMessage(configDir: string): string {
  return `[fail] No relay.yml in ${configDir}. Create it as:\n${relayYmlTemplate('  ')}\n${RELAY_TOKEN_NOTE}`;
}
