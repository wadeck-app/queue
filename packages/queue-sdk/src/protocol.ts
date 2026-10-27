import { getErrorMessage } from './errors.js';
import { parseRange, parseVersion, satisfies, compareVersions } from './semver.js';

// The push wire contract has its own SemVer version, independent from the package versions (see docs/push-protocol.md in the
// queue repository): MAJOR = breaking, MINOR = additive, PATCH = no wire change. Both ends read these constants, queue-core
// included, so there is exactly one place that says what version is spoken.

/** The protocol version this SDK speaks and the daemon of the same release implements. */
export const PROTOCOL_VERSION = '1.4.0';
/** Daemon protocol versions whose answers this SDK can read. */
export const SDK_UNDERSTANDS = '^1.0.0';
/** Client protocol versions the daemon accepts. While a MAJOR is deprecated, both stay listed (e.g. `^1.0.0 || ^2.0.0`). */
export const DAEMON_ACCEPTS = '^1.0.0';

export interface QueueProtocolInfo {
  /** The protocol version the daemon implements. */
  version: string;
  /** SemVer range of the client protocol versions it accepts. */
  accepts: string;
}

/** The protocol version that added the event catalog (`register-events`); an older daemon answers 404 to it. */
export const EVENT_CATALOG_MIN_VERSION = '1.1.0';

/** Whether a daemon that implements protocol `daemonProtocolVersion` has the event catalog. */
export function daemonSupportsEventCatalog(daemonProtocolVersion: string): boolean {
  return satisfies(daemonProtocolVersion, `>=${EVENT_CATALOG_MIN_VERSION}`);
}

/** The protocol version that added the optional `project` (a project-sdk project id) to `push`; an older daemon ignores the field. */
export const PUSH_PROJECT_MIN_VERSION = '1.2.0';

/** Whether a daemon that implements protocol `daemonProtocolVersion` honours the `project` of a push. */
export function daemonSupportsPushProject(daemonProtocolVersion: string): boolean {
  return satisfies(daemonProtocolVersion, `>=${PUSH_PROJECT_MIN_VERSION}`);
}

/** The protocol version from which `cwd` is optional when `project` is named (an event of a virtual project, which has no folder); an older daemon answers 500 to a push without cwd. */
export const PUSH_WITHOUT_CWD_MIN_VERSION = '1.3.0';

/** Whether a daemon that implements protocol `daemonProtocolVersion` accepts a push with a `project` and no `cwd`. */
export function daemonSupportsPushWithoutCwd(daemonProtocolVersion: string): boolean {
  return satisfies(daemonProtocolVersion, `>=${PUSH_WITHOUT_CWD_MIN_VERSION}`);
}

/** The protocol version that added `direction` to `push`; an older daemon ignores it and would fire the ancestors only. */
export const PUSH_DIRECTION_MIN_VERSION = '1.4.0';

/** Whether a daemon that implements protocol `daemonProtocolVersion` honours the `direction` of a push. */
export function daemonSupportsPushDirection(daemonProtocolVersion: string): boolean {
  return satisfies(daemonProtocolVersion, `>=${PUSH_DIRECTION_MIN_VERSION}`);
}

/**
 * The directions an event can propagate in from the project it is emitted in (the emitter's own subscribers fire in both cases):
 * `to-parents` = the emitter and its ancestors, root first (the default); `to-children` = the emitter and its descendants (the own file of each).
 */
export const PUSH_DIRECTIONS = ['to-parents', 'to-children'] as const;
export type PushDirection = (typeof PUSH_DIRECTIONS)[number];

export type DirectionCheck = { ok: true; directions: PushDirection[] } | { ok: false; reason: string };

/** Validates the `direction` of a push: absent is `['to-parents']`; else a non-empty list of known values (duplicates dropped). */
export function checkPushDirection(value: unknown): DirectionCheck {
  const accepted = PUSH_DIRECTIONS.join(', ');
  if (value === undefined) {
    return { ok: true, directions: ['to-parents'] };
  }
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, reason: `invalid direction ${JSON.stringify(value)}: expected a non-empty list of ${accepted}, e.g. ["to-children"]` };
  }
  const known = (candidate: unknown): candidate is PushDirection => PUSH_DIRECTIONS.some((direction) => direction === candidate);
  const unknown = value.filter((item) => !known(item));
  if (unknown.length > 0) {
    return { ok: false, reason: `unknown direction ${unknown.map((item) => JSON.stringify(item)).join(', ')}: the accepted values are ${accepted}` };
  }
  return { ok: true, directions: [...new Set(value.filter(known))] };
}

/** A daemon whose GET /version has no `queueProtocol` predates versioning and speaks the original contract. */
export const LEGACY_DAEMON_PROTOCOL: QueueProtocolInfo = { version: '1.0.0', accepts: '^1.0.0' };

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads `queueProtocol` out of a GET /version answer. Missing = legacy daemon; present but malformed = ProtocolError. */
export function parseDaemonProtocol(versionAnswer: unknown): QueueProtocolInfo {
  if (!isRecord(versionAnswer)) {
    throw new ProtocolError(`GET /version answered ${JSON.stringify(versionAnswer)}, expected a JSON object`);
  }
  const info = versionAnswer['queueProtocol'];
  if (info === undefined) {
    return LEGACY_DAEMON_PROTOCOL;
  }
  if (!isRecord(info) || typeof info['version'] !== 'string' || typeof info['accepts'] !== 'string') {
    throw new ProtocolError(`GET /version has a malformed queueProtocol ${JSON.stringify(info)}, expected { version: string, accepts: string }`);
  }
  try {
    parseVersion(info['version']);
    parseRange(info['accepts']);
  } catch (error) {
    throw new ProtocolError(`GET /version has a malformed queueProtocol ${JSON.stringify(info)}: ${getErrorMessage(error)}`);
  }
  return { version: info['version'], accepts: info['accepts'] };
}

export interface SdkProtocol {
  version: string;
  understands: string;
}

export type Negotiation = { ok: true; version: string } | { ok: false; reason: string };

const OWN: SdkProtocol = { version: PROTOCOL_VERSION, understands: SDK_UNDERSTANDS };

/** SDK side, before anything is sent: can this SDK and that daemon talk to each other, and with which version. */
export function negotiate(daemon: QueueProtocolInfo, own: SdkProtocol = OWN): Negotiation {
  if (!satisfies(daemon.version, own.understands)) {
    const sdkIsOlder = compareVersions(parseVersion(daemon.version), parseVersion(own.version)) > 0;
    const remedy = sdkIsOlder ? 'update @wadeck-app/queue-sdk' : 'update queue-cli (the queue daemon)';
    return {
      ok: false,
      reason: `the queue daemon speaks push protocol ${daemon.version}, this SDK speaks ${own.version} and understands ${own.understands}: ${remedy}`,
    };
  }
  if (!satisfies(own.version, daemon.accepts)) {
    return {
      ok: false,
      reason: `the queue daemon (protocol ${daemon.version}) accepts clients ${daemon.accepts} but this SDK speaks ${own.version}: update @wadeck-app/queue-sdk`,
    };
  }
  return { ok: true, version: own.version };
}

export type ClientProtocolCheck = { ok: true; version: string } | { ok: false; reason: string; supported: string };

/** Daemon side, on receipt of a push: the `protocol` field of the body. Absent = 1.0.0, every client that exists today. */
export function checkClientProtocol(protocol: unknown, accepts: string = DAEMON_ACCEPTS): ClientProtocolCheck {
  const claimed = protocol === undefined ? '1.0.0' : protocol;
  if (typeof claimed !== 'string') {
    return { ok: false, reason: `invalid protocol ${JSON.stringify(protocol)}: expected a SemVer string such as "1.0.0"`, supported: accepts };
  }
  try {
    parseVersion(claimed);
  } catch {
    return { ok: false, reason: `invalid protocol ${JSON.stringify(protocol)}: expected a SemVer string such as "1.0.0"`, supported: accepts };
  }
  if (!satisfies(claimed, accepts)) {
    return { ok: false, reason: `push protocol ${claimed} is not accepted by this daemon (it accepts ${accepts}): update the client`, supported: accepts };
  }
  return { ok: true, version: claimed };
}
