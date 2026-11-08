import { SUBSCRIBER_NAME_FORMAT, isValidSubscriberName } from '../ConfigLoader.js';

/** The shape of a waiter name: a subscriber name that has at least one dot between non-empty parts, `<who>.<what>`. */
export const WAITER_NAME_FORMAT = SUBSCRIBER_NAME_FORMAT;

const FILE_PREFIX = 'waiter-';
const FILE_SUFFIX = '.json';

/** Why `name` cannot name a waiter (with an example of one that can), undefined when it can. */
export function waiterNameProblem(name: string): string | undefined {
  const shape = `must look like <who>.<what> (${WAITER_NAME_FORMAT}, at most 64 characters), e.g. w-agent-wake.ab12cd34`;
  if (!isValidSubscriberName(name)) {
    return `--name '${name}' ${shape}.`;
  }
  if (name.split('.').some((part) => part === '')) {
    return `--name '${name}' ${shape}: it has an empty part (a doubled or trailing dot).`;
  }
  if (!name.includes('.')) {
    return `--name '${name}' ${shape}: it has no dot between the who and the what.`;
  }
  return undefined;
}

export function isValidWaiterName(name: string): boolean {
  return waiterNameProblem(name) === undefined;
}

/** `waiter-<name>.json`: the prefix keeps a name such as `con.x` from being a Windows device name. Throws for an invalid name: no path is ever built from one. */
export function waiterFileName(name: string): string {
  const problem = waiterNameProblem(name);
  if (problem !== undefined) {
    throw new Error(problem);
  }
  return `${FILE_PREFIX}${name}${FILE_SUFFIX}`;
}

/** The name in a waiter file name, undefined for any other file. The name is NOT validated here (the reader reports a bad one). */
export function waiterNameOfFile(fileName: string): string | undefined {
  if (!fileName.startsWith(FILE_PREFIX) || !fileName.endsWith(FILE_SUFFIX)) {
    return undefined;
  }
  const name = fileName.slice(FILE_PREFIX.length, fileName.length - FILE_SUFFIX.length);
  return name === '' ? undefined : name;
}
