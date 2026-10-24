export class DaemonUnreachableError extends Error {}

export class ReplayError extends Error {}

export class ReplayNotFoundError extends ReplayError {}

export class InvalidQueryError extends Error {}

/** A test push was asked for an event that has no declared example payload to push. */
export class TestPayloadNotFoundError extends Error {}

export class RelayNotConfiguredError extends Error {}
