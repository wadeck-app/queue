// violations-suppress: ts/no-barrel-index package entry point (package.json main/module/types/exports): its exports are the package's public API, deleting it would expose dist internals to every consumer
// Public API of @wadeck-app/queue-sdk. Everything else in src/ is internal.
export { createQueuePublisher } from './publisher.js';
export type { PublishOptions, QueuePublisher, QueuePublisherOptions, QueueStatus } from './publisher.js';
export type { FailureKind, QueueFailure } from './report.js';
export type { EventDeclaration, PublishResult, RegisterResult } from './wire.js';
export { PROTOCOL_VERSION } from './protocol.js';
export type { PushDirection } from './protocol.js';
export { resolveConfigDir } from './configDir.js';
