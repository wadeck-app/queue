import { SUBSCRIBER_NAME_FORMAT, isValidSubscriberName } from '@wadeck-app/queue-core';
import type { SubscriberConfig } from '@wadeck-app/queue-core';

export function parseSubFlags(args: string[]): { config: Partial<SubscriberConfig>; errors: string[] } {
  const errors: string[] = [];
  const config: Partial<SubscriberConfig> = {};

  const getArg = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1) {
      return undefined;
    }
    const next = args[idx + 1];
    if (!next || next.startsWith('--')) {
      return undefined;
    }
    return next;
  };

  const nameIdx = args.indexOf('--name');
  if (nameIdx !== -1) {
    const nameVal = args[nameIdx + 1];
    if (!nameVal || nameVal.startsWith('--')) {
      errors.push('--name needs a value, e.g. --name notify');
    } else if (!isValidSubscriberName(nameVal)) {
      errors.push(`--name ${JSON.stringify(nameVal)} is not valid: use ${SUBSCRIBER_NAME_FORMAT} (lowercase letters, digits, '.', '_', '-'; at most 64 characters)`);
    } else {
      config.name = nameVal;
    }
  }

  const typeVal = getArg('--type');
  if (typeVal === 'cli' || typeVal === 'http') {
    config.type = typeVal;
  }
  else if (typeVal) {
    errors.push(`--type must be cli or http, got: ${typeVal}`);
  }

  const commandVal = getArg('--command');
  if (commandVal) {
    config.command = commandVal;
  }

  const urlVal = getArg('--url');
  if (urlVal) {
    config.url = urlVal;
  }

  const methodVal = getArg('--method');
  if (methodVal) {
    config.method = methodVal;
  }

  const headers: Record<string, string> = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--header') {
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        const colonIdx = val.indexOf(':');
        if (colonIdx === -1) {
          errors.push(`Invalid --header format: "${val}" (expected "key:value")`);
        } else {
          headers[val.slice(0, colonIdx).trim()] = val.slice(colonIdx + 1).trim();
        }
      }
    }
  }
  if (Object.keys(headers).length > 0) {
    config.headers = headers;
  }

  const timeoutVal = getArg('--timeout');
  if (timeoutVal) {
    if (!/^\d+(ms|s|m|h)$/.test(timeoutVal)) {
      errors.push(`Invalid timeout: ${timeoutVal} (use e.g. 30s, 5m, 1h)`);
    } else {
      config.timeout = timeoutVal;
    }
  }

  const retriesVal = getArg('--retries');
  if (retriesVal !== undefined) {
    const n = parseInt(retriesVal, 10);
    if (isNaN(n) || n < 0) {
      errors.push(`--retries must be a non-negative integer, got: ${retriesVal}`);
    }
    else config.retries = n;
  }

  const backoffVal = getArg('--backoff');
  if (backoffVal === 'exponential' || backoffVal === 'linear') {
    config.backoff = backoffVal;
  }
  else if (backoffVal) {
    errors.push(`--backoff must be exponential or linear, got: ${backoffVal}`);
  }

  const whenVal = getArg('--when');
  if (whenVal) {
    config.when = whenVal;
  }

  return { config, errors };
}

/**
 * The entry written to subscribers.yml for a set of flags. On edit, `previous` is the entry it replaces: what the flags
 * cannot express (name unless --name is given, cwd, env) is kept instead of being dropped silently.
 */
export function buildSubscriberEntry(config: Partial<SubscriberConfig>, previous?: SubscriberConfig): SubscriberConfig {
  const entry: SubscriberConfig = { type: config.type ?? 'cli' };
  const name = config.name ?? previous?.name;
  if (name) {
    entry.name = name;
  }
  if (config.command) {
    entry.command = config.command;
  }
  if (config.url) {
    entry.url = config.url;
  }
  if (config.method) {
    entry.method = config.method;
  }
  if (config.headers && Object.keys(config.headers).length > 0) {
    entry.headers = config.headers;
  }
  if (config.timeout) {
    entry.timeout = config.timeout;
  }
  if (config.retries !== undefined) {
    entry.retries = config.retries;
  }
  if (config.backoff) {
    entry.backoff = config.backoff;
  }
  if (config.when) {
    entry.when = config.when;
  }
  if (previous?.cwd) {
    entry.cwd = previous.cwd;
  }
  if (previous?.env) {
    entry.env = previous.env;
  }
  return entry;
}

/** Which subscriber of an event `queue sub remove|edit` targets: --index wins, else --name; an error says what to fix. */
export function locateSubscriber(subs: SubscriberConfig[], event: string, args: string[]): { index: number } | { error: string } {
  const flagValue = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    const value = at === -1 ? undefined : args[at + 1];
    return value === undefined || value.startsWith('--') ? undefined : value;
  };
  const indexText = flagValue('--index');
  if (indexText !== undefined) {
    const index = Number(indexText);
    if (!Number.isInteger(index) || index < 0) {
      return { error: '--index must be a non-negative integer' };
    }
    if (index >= subs.length) {
      return { error: `No subscriber at index ${index} for event '${event}' (found ${subs.length})` };
    }
    return { index };
  }
  const name = flagValue('--name');
  if (name === undefined) {
    return { error: '--index <N> or --name <name> is required' };
  }
  const index = subs.findIndex((s) => s.name === name);
  if (index === -1) {
    const names = subs.flatMap((s) => (s.name === undefined ? [] : [s.name]));
    return { error: `No subscriber named '${name}' for event '${event}' (named: ${names.length === 0 ? 'none, use --index' : names.join(', ')})` };
  }
  return { index };
}

/**
 * `queue sub edit <event> --index N --name x` with no other flag only names the entry (the fix the unnamed-subscriber warning gives);
 * undefined when the flags ask for more, then edit replaces the entry.
 */
export function renameSubscriber(subs: SubscriberConfig[], index: number, config: Partial<SubscriberConfig>): { subs: SubscriberConfig[] } | { error: string } | undefined {
  const keys = Object.keys(config);
  if (config.name === undefined || keys.length !== 1) {
    return undefined;
  }
  const clash = subs.findIndex((s, i) => i !== index && s.name === config.name);
  if (clash !== -1) {
    return { error: `The name '${config.name}' is already used by the subscriber at index ${clash} of this event: names are unique per event within a file` };
  }
  return { subs: subs.map((s, i) => (i === index ? { ...s, name: config.name } : s)) };
}

/** The warning for a subscriber of a subscribers.yml without a name (the file will not load), with the command that fixes it. */
export function unnamedLine(event: string, index: number, scope: 'global' | 'project'): string {
  return (
    `[warn] subscriber ${event}[${index}] has no name: a name is required, so the daemon refuses to load this file. ` +
    `Fix: queue sub edit ${event} --index ${index} --name <name>${scope === 'project' ? ' --scope project' : ''}`
  );
}
