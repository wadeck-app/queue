import { hostname, platform } from 'node:os';

/** The relay clips the `client` string of the auth message at this many characters (control characters removed, trimmed). */
export const RELAY_CLIENT_MAX_LENGTH = 64;

/** What the relay console shows to tell which machine a listener is: no secret, the program, its version, the short host name and, when it fits, the platform. */
export interface ClientIdentity {
  /** `queue-cli/<version>`, also the User-Agent of the WebSocket handshake. */
  userAgent: string;
  /** The `client` string of the auth message. */
  client: string;
}

/**
 * `queue-cli/<version> host=<short hostname>[ os=<platform>]`. The host comes before the os and the whole stays within {@link RELAY_CLIENT_MAX_LENGTH}, so the relay's clip never
 * cuts the host: a long host name is shortened to the first label (before the first dot), then cut to fit; the os is added only when it fits whole.
 */
export function clientIdentity(version: string, host: string = hostname(), os: string = platform()): ClientIdentity {
  // eslint-disable-next-line no-control-regex
  const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const userAgent = `queue-cli/${clean(version)}`;
  const shortHost = clean(host).split('.')[0] ?? '';
  const room = RELAY_CLIENT_MAX_LENGTH - `${userAgent} host=`.length;
  const hostText = shortHost.slice(0, Math.max(room, 0));
  const withHost = hostText === '' ? userAgent : `${userAgent} host=${hostText}`;
  const withOs = `${withHost} os=${clean(os)}`;
  return { userAgent, client: withOs.length <= RELAY_CLIENT_MAX_LENGTH ? withOs : withHost.slice(0, RELAY_CLIENT_MAX_LENGTH) };
}
