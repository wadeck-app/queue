export class DaemonUnreachableError extends Error {}

export class ReplayError extends Error {}

export class ReplayNotFoundError extends ReplayError {}

export class InvalidQueryError extends Error {}

/** The id given to give up is not in the WAL. */
export class PendingNotFoundError extends Error {}

/** The entry exists but is no longer in flight (delivered, or already in the dead-letter queue). */
export class NotInFlightError extends Error {}

/** A test push was asked for an event that has no declared example payload to push. */
export class TestPayloadNotFoundError extends Error {}

export class RelayNotConfiguredError extends Error {}
