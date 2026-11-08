import { SUBSCRIBER_KEYS } from './ConfigLoader.js';
import { nearestEventNames } from './catalog/EventListing.js';
import { isRecord } from './isRecord.js';

const TOP_LEVEL_KEYS = ['subscribers', 'cwd', 'env'];
const EVENT_OBJECT_KEYS = ['cwd', 'env', 'commands'];

export interface UnknownKeyFinding {
  /** The key that nothing reads. */
  key: string;
  /** Absent for a key at the top of the file. */
  event?: string;
  /** Position in the event's list, for a key of a subscriber. */
  index?: number;
  name?: string;
  /** The known key it is most likely a typo of. */
  suggestion?: string;
  /** A sentence for the user: where it is, that it is ignored and the near match. */
  message: string;
}

function finding(key: string, known: readonly string[], where: string, partial: Pick<UnknownKeyFinding, 'event' | 'index' | 'name'>): UnknownKeyFinding {
  const suggestion = nearestEventNames(key, [...known])[0];
  return {
    key,
    ...partial,
    ...(suggestion !== undefined && { suggestion }),
    message: `${where}: unknown key '${key}', the daemon ignores it${suggestion === undefined ? '' : ` (did you mean '${suggestion}'?)`}`,
  };
}

/**
 * The keys of a parsed subscribers.yml that nothing reads (the loader's schema strips them without a word, so a typo like `timout` would
 * silently do nothing). Works on the raw YAML value, before any schema has touched it; never throws: a value of the wrong shape is the
 * schema's to report, not this function's.
 */
export function findUnknownKeys(raw: unknown): UnknownKeyFinding[] {
  const found: UnknownKeyFinding[] = [];
  if (!isRecord(raw)) {
    return found;
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      found.push(finding(key, TOP_LEVEL_KEYS, 'top level of the file', {}));
    }
  }
  const subscribers = raw['subscribers'];
  if (!isRecord(subscribers)) {
    return found;
  }
  for (const [event, value] of Object.entries(subscribers)) {
    let list: unknown = value;
    if (isRecord(value)) {
      for (const key of Object.keys(value)) {
        if (!EVENT_OBJECT_KEYS.includes(key)) {
          found.push(finding(key, EVENT_OBJECT_KEYS, `event '${event}'`, { event }));
        }
      }
      list = value['commands'];
    }
    if (!Array.isArray(list)) {
      continue;
    }
    list.forEach((entry: unknown, index) => {
      if (!isRecord(entry)) {
        return;
      }
      const name = typeof entry['name'] === 'string' ? entry['name'] : undefined;
      for (const key of Object.keys(entry)) {
        if (!SUBSCRIBER_KEYS.includes(key)) {
          found.push(finding(key, SUBSCRIBER_KEYS, `subscriber ${event}[${index}]${name === undefined ? '' : ` '${name}'`}`, { event, index, ...(name !== undefined && { name }) }));
        }
      }
    });
  }
  return found;
}
